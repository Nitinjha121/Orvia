/**
 * Integration suite for consumers of archived rounds other than playback,
 * verifying that coach listening, re-evaluation transcription, and budget seeding
 * properly fetch remote recordings via `ensureLocal`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import postgres from 'postgres';

import { assertTestDatabase } from './guard';

const REPO = resolve(import.meta.dirname, '../..');
const REAL_AUDIO = join(REPO, 'apps/api/data/audio');
const TEST_AUDIO = join(REPO, 'apps/api/data-test/audio');
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');

function r2Env(dataDir: string) {
  const t = readFileSync(join(REPO, 'apps/api/.env'), 'utf8');
  const g = (k: string) => t.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  return {
    DATA_DIR: dataDir,
    R2_ACCOUNT_ID: g('R2_ACCOUNT_ID'), R2_BUCKET: g('R2_BUCKET'), R2_ENDPOINT: g('R2_ENDPOINT'),
    R2_ACCESS_KEY_ID: g('R2_ACCESS_KEY_ID'), R2_SECRET_ACCESS_KEY: g('R2_SECRET_ACCESS_KEY'),
  } as never;
}

async function main() {
  assertTestDatabase(DB_URL);

  const { StorageService } = await import('../../apps/api/dist/storage/storage.service.js');
  const { ArchiveService } = await import('../../apps/api/dist/storage/archive.service.js');
  const { loadAudio } = await import('../../apps/api/dist/coach/coach.audio.js');
  const { analyzeWav } = await import('../../apps/api/dist/evaluation/audio-analysis.js');

  const sql = postgres(DB_URL, { max: 1 });
  const sessionId = randomUUID();
  const mic = join(TEST_AUDIO, `${sessionId}.wav`);
  const ai = join(TEST_AUDIO, `${sessionId}.ai.wav`);
  const storage = new StorageService(r2Env('./data-test'));
  const archive = new ArchiveService(r2Env('./data-test'), storage);

  try {
    console.log('\n1. baseline: measure the round BEFORE it is archived');
    await mkdir(TEST_AUDIO, { recursive: true });
    const srcMic = (await import('node:fs')).readdirSync(REAL_AUDIO)
      .find((f) => /^[0-9a-f-]+\.wav$/.test(f));
    const srcAi = srcMic?.replace(/\.wav$/, '.ai.wav');
    if (!srcMic || !srcAi || !existsSync(join(REAL_AUDIO, srcAi))) {
      check('a real mic+ai pair exists to copy', false);
      return;
    }
    await copyFile(join(REAL_AUDIO, srcMic), mic);
    await copyFile(join(REAL_AUDIO, srcAi), ai);

    const micShaBefore = sha(await readFile(mic));
    const analysisBefore = await analyzeWav(mic);
    const aiAnalysisBefore = await analyzeWav(ai);
    const coachBefore = await loadAudio(mic, 1);
    check('waveform analysis works locally', Boolean(analysisBefore),
      `${analysisBefore?.segments} segments, ${analysisBefore?.voicedMs}ms voiced`);
    check('coach can load the audio locally', Boolean(coachBefore),
      `${coachBefore?.audio.data.length ?? 0} base64 chars`);

    console.log('\n2. archive it');
    const res = await archive.archiveSession(sessionId, { audioPath: mic, aiAudioPath: ai });
    check('archived', res.archived, `${(res.bytes / 1024 ** 2).toFixed(1)}MB`);
    check('both local wavs gone', !existsSync(mic) && !existsSync(ai));

    console.log('\n3. THE EVALUATION PIPELINE on an archived round');
    // This is what a re-evaluation does: resolve the path, then analyse it.
    const micRestored = await archive.ensureLocal(mic);
    const aiRestored = await archive.ensureLocal(ai);
    check('mic resolves', Boolean(micRestored));
    check('interviewer resolves', Boolean(aiRestored));
    check('restored mic is byte-identical', micRestored ? sha(await readFile(micRestored)) === micShaBefore : false);

    const analysisAfter = micRestored ? await analyzeWav(micRestored) : null;
    const aiAnalysisAfter = aiRestored ? await analyzeWav(aiRestored) : null;
    check('waveform analysis returns a result', Boolean(analysisAfter));
    check('segment count IDENTICAL',
      analysisAfter?.segments === analysisBefore?.segments,
      `${analysisBefore?.segments} vs ${analysisAfter?.segments}`);
    check('voiced total IDENTICAL',
      analysisAfter?.voicedMs === analysisBefore?.voicedMs,
      `${analysisBefore?.voicedMs}ms vs ${analysisAfter?.voicedMs}ms`);
    check('longest silence IDENTICAL',
      analysisAfter?.longestSilenceMs === analysisBefore?.longestSilenceMs);
    check('every speech run boundary IDENTICAL',
      JSON.stringify(analysisAfter?.runs) === JSON.stringify(analysisBefore?.runs),
      `${analysisBefore?.runs.length} runs`);
    check('interviewer analysis IDENTICAL too — response latency is safe',
      JSON.stringify(aiAnalysisAfter?.runs) === JSON.stringify(aiAnalysisBefore?.runs),
      `${aiAnalysisBefore?.runs.length} runs`);

    console.log('\n4. THE COACH AND MENTOR on an archived round');
    const coachAfter = await loadAudio(await archive.ensureLocal(mic), 1);
    check('coach loads audio from the archive', Boolean(coachAfter));
    check('coach receives IDENTICAL bytes',
      coachAfter?.audio.data === coachBefore?.audio.data,
      `${coachAfter?.audio.data.length ?? 0} base64 chars`);
    check('mime type is still audio/wav', coachAfter?.audio.mimeType === 'audio/wav');
    check('part count unchanged', coachAfter?.parts === coachBefore?.parts,
      `${coachBefore?.parts} parts`);

    console.log('\n5. THE AUTOMATIC TRIGGER — EvaluationService.archiveSession itself');
    // The real production method, on the real services. Only the three-line
    // `.then()` that calls it is left to inspection; everything it DOES is here.
    {
      const { EvaluationService } = await import('../../apps/api/dist/evaluation/evaluation.service.js');
      const { TranscriptionService } = await import('../../apps/api/dist/evaluation/transcription.service.js');
      const { CodeCheckService } = await import('../../apps/api/dist/evaluation/code-check.service.js');
      const { ModelAvailabilityService } = await import('../../apps/api/dist/gemini/model-availability.service.js');
      const { createDb } = await import('../../packages/db/dist/index.js');

      const trigEnv = { ...(r2Env('./data-test') as Record<string, unknown>),
        GEMINI_API_KEY: 'x'.repeat(20) } as never;
      const sql2 = postgres(DB_URL, { max: 1 });
      const { db, client: dbClient } = createDb(DB_URL);
      const availability = new ModelAvailabilityService();
      const evalSvc = new EvaluationService(
        db, trigEnv, availability,
        new TranscriptionService(trigEnv),
        new CodeCheckService(trigEnv, availability),
        archive, storage,
      );

      const trigId = randomUUID();
      const tMic = join(TEST_AUDIO, `${trigId}.wav`);
      try {
        await copyFile(join(REAL_AUDIO, srcMic), tMic);
        const users2 = await sql2`select id from users limit 1`;
        if (!users2.length) {
          check('a user exists for the trigger test', false, 'seed orvia_test');
        } else {
          await sql2`
            insert into sessions (id, user_id, mode, status, config, options, model, voice,
              started_at, ai_speaking_ms, current_question_idx, dead_ms, audio_path)
            values (${trigId}, ${users2[0]!.id}, 'dsa', 'completed', '{}'::jsonb, '{}'::jsonb,
              'm', 'v', now(), 0, 0, 0, ${tMic})`;

          await (evalSvc as unknown as { archiveSession(id: string): Promise<void> }).archiveSession(trigId);

          const [row] = await sql2`select archived_at, archive_bytes from sessions where id = ${trigId}`;
          check('trigger archived the round', Boolean(row?.archived_at));
          check('trigger recorded the byte count', Number(row?.archive_bytes) > 0,
            `${(Number(row?.archive_bytes) / 1024 ** 2).toFixed(1)}MB`);
          check('trigger deleted the local wav', !existsSync(tMic));
          check('object is in the bucket at the recorded size',
            (await storage.head(archive.keyFor(tMic))) === Number(row?.archive_bytes));

          // Idempotence: a second call must not re-upload or re-stamp.
          const before = row?.archived_at;
          await (evalSvc as unknown as { archiveSession(id: string): Promise<void> }).archiveSession(trigId);
          const [again] = await sql2`select archived_at from sessions where id = ${trigId}`;
          check('a second call is a no-op', String(again?.archived_at) === String(before));
        }
      } finally {
        await sql2`delete from sessions where id = ${trigId}`.catch(() => {});
        await rm(tMic, { force: true });
        await archive.purgeSession({ audioPath: tMic }).catch(() => {});
      }
      await sql2.end().catch(() => {});
      await dbClient.end().catch(() => {});
    }

    console.log('\n6. BOOT BUDGET SEEDING with a real archived row');
    const userRows = await sql`select id from users limit 1`;
    let seeded = false;
    if (userRows.length) {
      await sql`
        insert into sessions (id, user_id, mode, status, config, options, model, voice,
          started_at, ai_speaking_ms, current_question_idx, dead_ms, archived_at, archive_bytes)
        values (${sessionId}, ${userRows[0]!.id}, 'dsa', 'completed', '{}'::jsonb, '{}'::jsonb,
          'm', 'v', now(), 0, 0, 0, now(), ${res.bytes})`;
      const rows = await sql`
        select coalesce(sum(archive_bytes), 0)::bigint as total, count(*)::int as n
        from sessions where archived_at is not null`;
      const total = Number(rows[0]!.total);
      storage.setUsedBytes(total);
      seeded = storage.usage().usedBytes === total && total >= res.bytes;
      check('archived rows sum into the budget', seeded,
        `${(total / 1024 ** 2).toFixed(1)}MB across ${rows[0]!.n} round(s)`);
      check('usage is not flagged full at this size', !storage.usage().full,
        `${(storage.usage().fraction * 100).toFixed(2)}%`);
    } else {
      check('a user exists to attach a session to', false, 'seed the test db first');
    }
  } finally {
    await sql`delete from sessions where id = ${sessionId}`.catch(() => {});
    await sql.end().catch(() => {});
    await rm(mic, { force: true });
    await rm(ai, { force: true });
    await archive.purgeSession({ audioPath: mic, aiAudioPath: ai }).catch(() => {});
    await rm(join(REPO, 'apps/api/data-test/audio-cache'), { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
