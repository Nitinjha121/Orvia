/**
 * Pre-generates feed narration with Gemini audio.
 *
 *   pnpm --filter @orvia/api speech:build              every card, default voice
 *   pnpm --filter @orvia/api speech:build -- --voice Puck --limit 20
 *
 * Feed scripts are static, so clips are generated once, encoded as AAC, and
 * cached in DATA_DIR/speech named by content hash. Interrupted runs resume cleanly.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { asc, eq } from 'drizzle-orm';
import {
  createDb,
  learningCards,
  dsaQuestions,
  questionCollections,
  conceptQuestions,
} from '@orvia/db';
import { DEFAULT_COLLECTION, speakableCard, speechGroups, type FeedCard } from '@orvia/shared';
import { LiveNarrator } from './live-narrator.mts';

const exec = promisify(execFile);

/**
 * TTS model fallback chain. Faster 3.8 models are tried first with 2.5
 * preview as fallback. Unroutable models that return 404 are temporarily
 * retired to avoid wasting retries on each card.
 */
const TTS_CHAIN = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'];

/**
 * Models that returned 404, and when they may be retried.
 * Faster models are rechecked every ten minutes.
 */
const retired = new Map<string, number>();
const RETIRE_MS = 10 * 60_000;
const isRetired = (model: string) => (retired.get(model) ?? 0) > Date.now();

/**
 * 48kbps mono AAC. Speech at this rate is indistinguishable from the 768kbps
 * source on a phone speaker, and it turns a 3MB card into about 300KB — which
 * is the difference between usable and not on mobile data.
 */
const AUDIO_BITRATE = '48k';

/** Read it as written. The model paraphrases if you ask it to "say" something. */
const STYLE = 'Read the following aloud clearly and naturally, exactly as written, at a calm pace:';

type Manifest = {
  voice: string;
  model: string;
  generatedAt: string;
  /** cardKey → the clips that make it up, in order. */
  entries: Record<string, { file: string; pauseAfterMs: number }[]>;
};

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

/**
 * Voices to build, comma separated.
 *
 * Built in INTERLEAVED blocks rather than one voice at a time, so every voice
 * has roughly equal coverage at any moment. Finishing Charon before starting
 * Kore would mean that switching voice mid-build switches to an empty one,
 * which is worse than having fewer cards in each.
 */
const VOICES = flag('voice', 'Charon')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

/**
 * Cards per voice before moving to the next. Matched to the narrator's session
 * rotation, so alternating voices costs no extra handshakes.
 */
const VOICE_BLOCK = 8;

const LIMIT = Number(flag('limit', '0')) || Infinity;

/**
 * Live audio streaming is the default engine because free-tier TTS models
 * have strict daily request caps. `--engine tts` uses dedicated TTS models
 * when paid billing quota is available.
 */
const ENGINE = flag('engine', 'live') as 'live' | 'tts';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is missing');

const dataDir = process.env.DATA_DIR ?? './data';
const speechDir = join(dataDir, 'speech');
const dirFor = (voice: string) => join(speechDir, voice);

const exists = (path: string) => access(path).then(() => true).catch(() => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One clip of speech, as a file.
 *
 * Retries on 429 and 5xx with backoff, because a long run WILL hit a per-minute
 * limit and losing an hour of generation to it would be absurd. Anything else
 * throws: a malformed request should stop the run rather than write silence.
 */
let narrator: LiveNarrator | null = null;

/** One clip through the Live API, reusing a single socket across cards. */
async function synthesiseLive(text: string, file: string, voice: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      narrator ??= new LiveNarrator(apiKey!);
      const clip = await narrator.narrate(text, voice);

      const source = join(tmpdir(), `orvia-tts-${process.pid}.pcm`);
      await writeFile(source, clip.pcm);
      await exec('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(clip.sampleRate), '-ac', '1',
        '-i', source,
        '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '1', file,
      ]);
      await rm(source, { force: true });
      usedModels.add('live');
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
      // A wedged turn or a dropped socket: the narrator has already discarded
      // the session, so the next attempt opens a clean one.
      await narrator?.close();
      narrator = null;
      // Capped: a socket that will not open is not helped by a five-minute
      // wait, and the run is resumable anyway.
      const wait = Math.min(30_000, 2 ** attempt * 2_000);
      process.stdout.write(` [${(e as Error).message}, retrying in ${wait / 1000}s]`);
      await sleep(wait);
    }
  }
}

async function synthesise(text: string, file: string, voice: string): Promise<'generated' | 'cached'> {
  if (await exists(file)) return 'cached';

  if (ENGINE === 'live') {
    await synthesiseLive(text, file, voice);
    return 'generated';
  }

  for (let attempt = 0; ; attempt++) {
    const model = TTS_CHAIN.find((m) => !isRetired(m));
    if (!model) throw new Error('every TTS model in the chain is unroutable');

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${STYLE}\n\n${text}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
      },
    );

    if (res.status === 404) {
      retired.set(model, Date.now() + RETIRE_MS);
      process.stdout.write(` [${model} unroutable, falling back]`);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 6) throw new Error(`${model} kept returning ${res.status}`);
      const wait = Math.min(60_000, 2 ** attempt * 2_000);
      process.stdout.write(` [${res.status}, waiting ${wait / 1000}s]`);
      await sleep(wait);
      continue;
    }

    const body = (await res.json()) as {
      candidates?: {
        content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }
      }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`${model} ${res.status}: ${body.error?.message ?? 'failed'}`);

    const part = body.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    const b64 = part?.data;
    if (!b64) throw new Error('TTS returned no audio');

    /**
     * The models in the chain disagree about the container. 3.8 returns
     * `audio/wav`, which ffmpeg reads directly; 2.5 returns HEADERLESS PCM as
     * `audio/L16;codec=pcm;rate=24000`, which ffmpeg rejects as "invalid data"
     * unless the format is stated on the command line.
     */
    const mime = part.mimeType ?? '';
    const raw = /L16|pcm/i.test(mime) && !/wav/i.test(mime);
    const sampleRate = /rate=(\d+)/.exec(mime)?.[1] ?? '24000';

    // Outside the cache directory, so an interrupted run cannot leave a stray
    // multi-megabyte temporary among the files the API serves.
    const source = join(tmpdir(), `orvia-tts-${process.pid}.${raw ? 'pcm' : 'wav'}`);
    await writeFile(source, Buffer.from(b64, 'base64'));
    // Encoded rather than served raw: the source is about 48KB per second,
    // which is a three megabyte card.
    await exec('ffmpeg', [
      '-y', '-loglevel', 'error',
      ...(raw ? ['-f', 's16le', '-ar', sampleRate, '-ac', '1'] : []),
      '-i', source,
      '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '1', file,
    ]);
    await rm(source, { force: true });
    usedModels.add(model);
    return 'generated';
  }
}

/** Which models actually produced audio, recorded in the manifest. */
const usedModels = new Set<string>();

/** Everything the feed can narrate in advance, as the cards the feed will serve. */
async function scripts(db: ReturnType<typeof createDb>['db']): Promise<{ key: string; card: FeedCard }[]> {
  const state = { timesSeen: 0, saved: false, strength: 0, dueAt: null };

  const [cards, dsa, concepts] = await Promise.all([
    db.select().from(learningCards).orderBy(asc(learningCards.orderIdx)),
    db
      .select({
        id: dsaQuestions.id,
        title: dsaQuestions.title,
        prompt: dsaQuestions.prompt,
        difficulty: dsaQuestions.difficulty,
      })
      .from(questionCollections)
      .innerJoin(dsaQuestions, eq(dsaQuestions.id, questionCollections.questionId))
      .where(eq(questionCollections.collection, DEFAULT_COLLECTION))
      .orderBy(asc(questionCollections.orderIdx)),
    db
      .select({
        id: conceptQuestions.id,
        title: conceptQuestions.title,
        prompt: conceptQuestions.prompt,
        difficulty: conceptQuestions.difficulty,
        topic: conceptQuestions.topic,
      })
      .from(conceptQuestions)
      .orderBy(asc(conceptQuestions.orderIdx)),
  ]);

  const out: { key: string; card: FeedCard }[] = [];

  for (const row of cards) {
    out.push({
      key: `card:${row.id}`,
      card: {
        kind: row.kind as 'lesson',
        key: `card:${row.id}`,
        state,
        becauseOf: null,
        card: {
          id: row.id,
          kind: row.kind as 'lesson',
          track: row.track as 'dsa',
          title: row.title,
          body: row.body,
          takeaway: row.takeaway,
          code: row.code ?? undefined,
          codeLanguage: row.codeLanguage ?? undefined,
          tags: (row.tags as string[]) ?? [],
          difficulty: row.difficulty as 'medium',
          choices: (row.choices as string[] | null) ?? undefined,
          answerIdx: row.answerIdx ?? undefined,
          explanation: row.explanation ?? undefined,
        },
      },
    });
  }

  /**
   * Drills and recalls read the same prompt, so one set of clips serves both —
   * keyed by the drill, and resolved for either at request time.
   */
  for (const q of dsa) {
    out.push({
      key: `drill:dsa:${q.id}`,
      card: {
        kind: 'drill', key: `drill:dsa:${q.id}`, state, track: 'dsa',
        questionId: q.id, title: q.title, prompt: q.prompt, difficulty: q.difficulty,
        tags: [], practice: { mode: 'dsa', questionId: q.id },
      },
    });
  }
  for (const q of concepts) {
    out.push({
      key: `drill:concepts:${q.id}`,
      card: {
        kind: 'drill', key: `drill:concepts:${q.id}`, state, track: 'concepts',
        questionId: q.id, title: q.title, prompt: q.prompt, difficulty: q.difficulty,
        tags: [q.topic], practice: { mode: 'concepts', questionId: q.id },
      },
    });
  }

  return out;
}

async function main() {
  const { db, client } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia',
  );
  for (const voice of VOICES) await mkdir(dirFor(voice), { recursive: true });

  const manifestPath = (voice: string) => join(speechDir, `${voice}.json`);
  const manifests = new Map<string, Manifest>();
  for (const voice of VOICES) {
    const path = manifestPath(voice);
    manifests.set(
      voice,
      (await exists(path))
        ? (JSON.parse(await readFile(path, 'utf8')) as Manifest)
        : { voice, model: ENGINE, generatedAt: new Date().toISOString(), entries: {} },
    );
  }

  const all = (await scripts(db)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(
    `\n${all.length} narratable cards × ${VOICES.length} voice(s) (${VOICES.join(', ')})` +
      ` · engine ${ENGINE}${ENGINE === 'tts' ? ` · chain ${TTS_CHAIN.join(' → ')}` : ''}\n`,
  );

  let generated = 0;
  let cached = 0;

  /**
   * Blocks of cards per voice, so coverage stays level across voices as the
   * build runs. The block size matches the narrator's session rotation, which
   * is why alternating voices costs nothing.
   */
  for (let start = 0; start < all.length; start += VOICE_BLOCK) {
    const block = all.slice(start, start + VOICE_BLOCK);

    for (const voice of VOICES) {
      const manifest = manifests.get(voice)!;

      for (const [i, { key, card }] of block.entries()) {
        const position = start + i + 1;
        const groups = speechGroups(speakableCard(card));
        const clips: { file: string; pauseAfterMs: number }[] = [];

        process.stdout.write(
          `${String(position).padStart(4)}/${all.length} ${voice.padEnd(7)} ` +
            `${key.slice(0, 44).padEnd(44)}`,
        );

        for (const group of groups) {
          // Hashed on the TEXT and the voice, so editing a card regenerates
          // only that card and only for the voices it affects.
          const name = `${createHash('sha256').update(`${voice}:${group.text}`).digest('hex').slice(0, 20)}.m4a`;
          const result = await synthesise(group.text, join(dirFor(voice), name), voice);
          if (result === 'generated') generated++;
          else cached++;
          clips.push({ file: name, pauseAfterMs: group.pauseAfterMs });
        }

        manifest.entries[key] = clips;
        manifest.generatedAt = new Date().toISOString();
        // Written after every card, so an interrupted run leaves a manifest
        // that matches the files on disk.
        await writeFile(manifestPath(voice), JSON.stringify(manifest, null, 2));
        console.log(` ${clips.length} clip(s)`);
      }
    }
  }

  await narrator?.close();

  if (usedModels.size) {
    for (const voice of VOICES) {
      const manifest = manifests.get(voice)!;
      manifest.model = [...usedModels].join(', ');
      await writeFile(manifestPath(voice), JSON.stringify(manifest, null, 2));
    }
  }

  console.log(
    `\ngenerated ${generated}, reused ${cached}` +
      `${usedModels.size ? `, via ${[...usedModels].join(', ')}` : ''}` +
      `${retired.size ? `, unroutable at some point: ${[...retired.keys()].join(', ')}` : ''}` +
      `\nmanifests in ${speechDir}\n`,
  );

  await client.end();
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
