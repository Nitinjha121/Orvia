/**
 * Long-session and resumption test suite verifying that interview sessions survive
 * upstream connection recycling and context window renewal beyond 30 minutes,
 * maintaining uninterrupted speech transcription across reconnect boundaries.
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { assertTestDatabase } from './guard';
import { preflight } from './preflight';
import { C2S, S2C, frame, parseServer } from './protocol';
import type { SessionEndedPayload } from '../../packages/shared/src/events.js';
import { liveModelQuirks } from '../../packages/shared/src/models.js';

const exec = promisify(execFile);
const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test',
);
const TMP = '/tmp/orvia-resumption';
/** Runs past the connection recycling threshold. */
const MINUTES = Number(process.env.MINUTES ?? 32);
/** When the long narration starts, and how long it runs. */
const NARRATE_FROM_MS = Math.min(22, Math.max(1, MINUTES - 8)) * 60_000;
const NARRATE_MS = 4 * 60_000;
/** How long after a clip ends its transcript may take. */
const HEARD_WITHIN_MS = 20_000;

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

let passed = 0;
const failures: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) passed++;
  else failures.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (ms: number) =>
  `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

async function speak(text: string, name: string): Promise<Buffer> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, `${name}.aiff`);
  const pcm = join(TMP, `${name}.pcm`);
  await exec('say', ['-v', 'Daniel', '-r', '170', '-o', aiff, text]);
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', pcm]);
  const buf = await readFile(pcm);
  await rm(aiff, { force: true });
  await rm(pcm, { force: true });
  return buf;
}

/** Answers cycled through so the round has genuine content to compress. */
const ANSWERS = [
  'My approach would be to use a hash map so lookups are constant time on average, which gives linear time overall.',
  'The brute force would be a nested loop at order n squared time, but constant space, so it is a trade of memory against speed.',
  'For edge cases I would check an empty input, a single element, and duplicates that happen to sum to the target.',
  'I would store the value and its index as I go, so when I find the complement I can return both positions immediately.',
  'If the array were sorted I could use two pointers instead and drop the extra space down to constant.',
  'Hash collisions would degrade it to linear per lookup in the worst case, so the order n bound is an average, not a guarantee.',
];

async function main() {
  console.log(`\n\x1b[1mOrvia — long session and resumption (${MINUTES} minutes)\x1b[0m\n`);
  console.log(`  \x1b[2mThe Live API recycles the connection at ~10 min and caps audio sessions at 15.\x1b[0m`);
  console.log(`  \x1b[2mThis run deliberately crosses both.\x1b[0m\n`);

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set.');
    process.exit(2);
  }


  await preflight(API);

  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  check('API is up', !!health?.ok);
  if (!health?.ok) return report();

  const questions = await fetch(`${API}/api/questions/dsa?collection=neetcode150`).then((r) => r.json());
  const email = `resume+${process.pid}@orvia.local`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Resumption', email, password: 'resumption-password-1' }),
  });
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('account created', reg.ok, email);

  console.log('\n\x1b[1mrendering speech\x1b[0m');
  const clips = await Promise.all(ANSWERS.map((a, i) => speak(a, `a${i}`)));
  check('answers rendered', clips.every((c) => c.length > 0), `${clips.length} clips`);

  /* ── run the long session ───────────────────────────────────────────────── */
  console.log(`\n\x1b[1mrunning a ${MINUTES} minute round\x1b[0m`);
  const ws = new WebSocket(WS_URL, { headers: { cookie } });

  let sessionId = '';
  let model = '';
  let aiBytes = 0;
  let userFinals = 0;
  let aiFinals = 0;
  let ended = null as SessionEndedPayload | null;
  let fatal: string | null = null;
  const warnings: { code: string; atMs: number }[] = [];
  const transcriptAt: number[] = [];
  const userFinalAt: number[] = [];
  /** Every clip spoken: when it started and ended, and whether it was the narration. */
  const spoken: { from: number; to: number; narration: boolean }[] = [];
  const started = Date.now();

  ws.on('message', (raw) => {
    const m = parseServer(raw);
    if (!m) return;
    switch (m.event) {
      case S2C.SessionReady: sessionId = m.data.sessionId; model = m.data.model; break;
      case S2C.AudioDelta: aiBytes += Buffer.from(m.data.data, 'base64').length; break;
      case S2C.TranscriptDelta:
        if (m.data.final) {
          transcriptAt.push(Date.now() - started);
          if (m.data.speaker === 'user') {
            userFinals++;
            userFinalAt.push(Date.now() - started);
          } else aiFinals++;
        }
        break;
      case S2C.SessionWarning:
        warnings.push({ code: m.data.code, atMs: Date.now() - started });
        console.log(`  \x1b[33m·\x1b[0m [${mmss(Date.now() - started)}] warning: ${m.data.code}`);
        break;
      case S2C.SessionEnded: ended = m.data; break;
      case S2C.Error:
        if (m.data.fatal) fatal = m.data.message;
        console.log(`  \x1b[31m·\x1b[0m [${mmss(Date.now() - started)}] error: ${String(m.data.message).slice(0, 120)}`);
        break;
    }
  });

  await new Promise<void>((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
    setTimeout(() => rej(new Error('ws timeout')), 10_000);
  }).catch(() => {});
  check('websocket connected', ws.readyState === WebSocket.OPEN);

  ws.send(frame(C2S.StartSession, {
    config: { mode: 'dsa', questionIds: [questions[0].id], codeEditor: false },
    options: { durationMinutes: MINUTES + 5, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
  }));

  for (let i = 0; i < 200 && !sessionId; i++) await sleep(100);
  check('session started', !!sessionId, sessionId.slice(0, 8));
  if (!sessionId) { ws.close(); return report(); }

  const totalMs = MINUTES * 60_000;
  const silence = Buffer.alloc(CHUNK_BYTES);
  let clipIdx = 0;
  let lastMilestone = 0;
  const beforeReconnect = { user: 0, ai: 0 };

  const sendClip = async (clip: Buffer, narration: boolean) => {
    const from = Date.now() - started;
    for (let off = 0; off < clip.length; off += CHUNK_BYTES) {
      ws.send(frame(C2S.AudioChunk, { data: clip.subarray(off, off + CHUNK_BYTES).toString('base64') }));
      await sleep(CHUNK_MS);
    }
    spoken.push({ from, to: Date.now() - started, narration });
  };
  let narrated = false;

  // Speak for a few seconds every ~90s, silence otherwise. Streaming silence
  // rather than nothing matters: the mic is genuinely open in a real round, and
  // a session that only survives when idle has not been tested.
  while (Date.now() - started < totalMs && !fatal && !ended) {
    const elapsed = Date.now() - started;

    /**
     * Continuous narration simulation: multiple minutes of speech with short pauses
     * between clips followed by silence to verify transcription commits under sustained load.
     */
    if (!narrated && elapsed >= NARRATE_FROM_MS) {
      narrated = true;
      console.log(`  \x1b[2m[${mmss(elapsed)}] narrating for ${NARRATE_MS / 60_000} minutes without a long pause\x1b[0m`);
      const until = Date.now() + NARRATE_MS;
      while (Date.now() < until && !fatal && !ended) {
        await sendClip(clips[clipIdx++ % clips.length]!, true);
        for (let i = 0; i < 1_200 / CHUNK_MS; i++) {
          ws.send(frame(C2S.AudioChunk, { data: silence.toString('base64') }));
          await sleep(CHUNK_MS);
        }
      }
      for (let i = 0; i < 6_000 / CHUNK_MS; i++) {
        ws.send(frame(C2S.AudioChunk, { data: silence.toString('base64') }));
        await sleep(CHUNK_MS);
      }
      continue;
    }

    if (elapsed > lastMilestone + 120_000) {
      lastMilestone = elapsed;
      console.log(`  \x1b[2m[${mmss(elapsed)}] alive · ${userFinals} of your turns · ${aiFinals} interviewer turns · ${(aiBytes / 1024).toFixed(0)} KB audio\x1b[0m`);
    }

    if (elapsed > 60_000 && elapsed % 90_000 < 900) {
      if (elapsed > 9 * 60_000 && beforeReconnect.user === 0) {
        beforeReconnect.user = userFinals;
        beforeReconnect.ai = aiFinals;
      }
      await sendClip(clips[clipIdx++ % clips.length]!, false);
      for (let i = 0; i < 45; i++) {
        ws.send(frame(C2S.AudioChunk, { data: silence.toString('base64') }));
        await sleep(CHUNK_MS);
      }
      continue;
    }

    ws.send(frame(C2S.AudioChunk, { data: silence.toString('base64') }));
    await sleep(CHUNK_MS);
  }

  const ranFor = Date.now() - started;
  console.log('');
  check('session survived past the connection lifetime (10 min)', ranFor > 10 * 60_000 && !fatal,
    `ran ${mmss(ranFor)}${fatal ? `, fatal: ${String(fatal).slice(0, 80)}` : ''}`);
  check('session survived past the audio-session cap (15 min)',
    ranFor > 15 * 60_000 ? !fatal : true,
    ranFor > 15 * 60_000 ? 'crossed 15 min' : `only ran ${mmss(ranFor)} — set MINUTES=16+ to test this bound`);
  check('no fatal error during the round', !fatal, fatal ?? 'none');

  // The reconnect is invisible by design, so it is proven by the conversation
  // continuing rather than by an event.
  const lateTranscripts = transcriptAt.filter((t) => t > 10 * 60_000).length;
  check('still transcribing after 10 minutes', lateTranscripts > 0,
    `${lateTranscripts} final fragments after the 10 minute mark`);
  check('interviewer still responding late in the round',
    aiFinals > beforeReconnect.ai || beforeReconnect.ai === 0,
    `${beforeReconnect.ai} → ${aiFinals} interviewer turns`);
  if (warnings.length) {
    console.log(`      \x1b[2mwarnings seen: ${warnings.map((w) => `${w.code}@${mmss(w.atMs)}`).join(', ')}\x1b[0m`);
  }

  /**
   * Heard, clip by clip. A clip counts as heard when a candidate transcript
   * arrives between its start and HEARD_WITHIN_MS after it ends. During the
   * narration the server commits at its own pauses, so those clips are judged
   * as one stretch: transcript must keep arriving through it and after it.
   */
  const heard = (c: { from: number; to: number }) =>
    userFinalAt.some((t) => t >= c.from && t <= c.to + HEARD_WITHIN_MS);
  const single = spoken.filter((c) => !c.narration);
  const unheard = single.filter((c) => !heard(c));
  check('every clip spoken outside the narration was transcribed', unheard.length === 0,
    `${single.length - unheard.length} of ${single.length}` +
      (unheard.length ? `; missed at ${unheard.map((c) => mmss(c.from)).join(', ')}` : ''));
  const late = single.filter((c) => c.from > 25 * 60_000);
  if (MINUTES >= 27) {
    check('...including every clip past twenty-five minutes',
      late.length > 0 && late.every(heard), `${late.filter(heard).length} of ${late.length}`);
  }
  const narration = spoken.filter((c) => c.narration);
  if (narration.length) {
    const nFrom = narration[0]!.from;
    const nTo = narration.at(-1)!.to;
    const minutes = Math.ceil((nTo - nFrom) / 60_000);
    const perMinute = Array.from({ length: minutes + 1 }, (_, i) =>
      userFinalAt.filter((t) => t >= nFrom + i * 60_000 && t < nFrom + (i + 1) * 60_000).length);
    check('transcript kept arriving through the long narration, minute by minute',
      perMinute.slice(0, minutes).filter((n) => n > 0).length >= minutes - 1,
      `fragments per minute: ${perMinute.join(', ')}`);
    check('...and the last of it was transcribed once the narration stopped', heard(narration.at(-1)!),
      'sustained speech commits after narration finishes');
  }

  ws.send(frame(C2S.AudioStreamEnd));
  ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));
  for (let i = 0; i < 300 && !ended; i++) await sleep(100);
  check('session ended cleanly', !!ended, ended ? `${(ended.durationMs / 60000).toFixed(1)} min, ${ended.turnCount} turns` : 'no session.ended');
  ws.close();

  /* ── persisted state ────────────────────────────────────────────────────── */
  const sql = postgres(DB_URL, { max: 1 });
  try {
    const [row] = await sql`select status, duration_ms, resumption_handle, audio_path from sessions where id = ${sessionId}`;
    check('session marked completed', row?.status === 'completed', row?.status);
    check('full duration recorded', (row?.duration_ms ?? 0) > 10 * 60_000,
      `${((row?.duration_ms ?? 0) / 60000).toFixed(1)} min`);
    check('a resumption handle was stored', !!row?.resumption_handle,
      row?.resumption_handle ? 'present' : 'none — resumption was never armed');

    /**
     * What the socket went through. Renewals must have kept the context under
     * the budget, and any refusal the server issued must have been answered by
     * a clean socket rather than a resumed one.
     */
    const [up] = await sql`select upstream_events from sessions where id = ${sessionId}`;
    const events = (up?.upstream_events ?? []) as { atMs: number; kind: string; why?: string; tokens?: number; code?: number }[];
    const renewed = events.filter((e) => e.kind === 'renewed');
    const peak = Math.max(0, ...events.map((e) => e.tokens ?? 0));
    console.log(`      \x1b[2mupstream: ${events.map((e) => `${e.kind}${e.why ? `(${e.why})` : ''}@${mmss(e.atMs)}${e.tokens ? ` ${e.tokens}t` : ''}`).join(', ') || 'nothing recorded'}\x1b[0m`);
    /**
     * Context renewal is checked when upstream events show tokens reached
     * the configured threshold or a handover warning occurred.
     */
    const replaced = warnings.some((w) => w.code === 'go_away' || w.code === 'reconnecting');
    check('upstream events were recorded whenever the socket was replaced', !replaced || events.length > 0,
      `${events.length} events${replaced ? '' : ', socket never replaced'}`);
    if (MINUTES >= 15) {
      const budget = liveModelQuirks(model).contextBudget;
      const due = events.some((e) => (e.tokens ?? 0) >= budget.renewAt ||
        (e.kind === 'handover_warning' && (e.tokens ?? 0) >= budget.renewAtHandover));
      check('the context was renewed whenever it reached the budget', !due || renewed.length > 0,
        renewed.map((e) => `${e.why}@${mmss(e.atMs)}`).join(', ') ||
          (due ? 'never renewed' : `never due on ${model}: no event at ${budget.renewAt} or a handover at ${budget.renewAtHandover}`));
    }
    check('the context never reached the refusal zone', peak < 30_000, `peak ${peak} tokens`);
    const refused = events.filter((e) => e.kind === 'closed' && e.why === 'refused');
    check('every refusal was answered by a clean socket',
      refused.every((r) => events.some((e) => e.kind === 'renewed' && e.atMs >= r.atMs)),
      refused.length ? `${refused.length} refusals` : 'no refusals');
    check('no renewal failed', !events.some((e) => e.kind === 'renew_failed'));

    const turns = await sql`select speaker, start_ms from turns where session_id = ${sessionId} order by idx`;
    check('turns span the whole round', turns.length > 4 &&
      Number(turns[turns.length - 1]!.start_ms) > 10 * 60_000,
      `${turns.length} turns, last at ${mmss(Number(turns[turns.length - 1]?.start_ms ?? 0))}`);
  } finally {
    await sql.end();
  }

  report();
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (!failures.length) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} RESUMPTION CHECKS PASSED\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  process.exit(1);
}

void main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
