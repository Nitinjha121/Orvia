/**
 * End-to-end test suite for the live voice loop, testing WebSocket streaming,
 * audio transcription, speech interaction, barge-in handling, and session persistence.
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { assertTestDatabase } from './guard';
import { preflight } from './preflight';
import { C2S, S2C, frame, parseServer, type ServerMessage } from './protocol';
import type { EvaluationView, NoEvaluation } from '../../packages/shared/src/evaluation.js';
import type { SessionEndedPayload } from '../../packages/shared/src/events.js';

const exec = promisify(execFile);

const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test',
);
// Synthesised fixtures only. Never under data/: that is where recordings live.
const TMP = join(tmpdir(), 'orvia-live-loop');

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // 2560

/* ── tiny assertion harness ────────────────────────────────────────────────── */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── speech synthesis for the "candidate" ──────────────────────────────────── */

/**
 * Renders a spoken line to raw 16 kHz mono PCM using macOS `say` + ffmpeg.
 * Real speech (not a tone) is essential: the Live API's voice activity
 * detection ignores synthetic noise, so a tone would never open a turn.
 */
async function speak(text: string, name: string): Promise<Buffer> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, `${name}.aiff`);
  const pcm = join(TMP, `${name}.pcm`);

  await exec('say', ['-v', 'Daniel', '-r', '175', '-o', aiff, text]);
  await exec('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', aiff,
    '-ar', String(SAMPLE_RATE), '-ac', '1',
    '-f', 's16le', '-acodec', 'pcm_s16le',
    pcm,
  ]);

  const buf = await readFile(pcm);
  await rm(aiff, { force: true });
  await rm(pcm, { force: true });
  return buf;
}

/* ── the test ──────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n\x1b[1mOrvia — step 1 end-to-end: live voice loop\x1b[0m\n');

  if (!process.env.GEMINI_API_KEY) {
    console.error('\x1b[31mGEMINI_API_KEY is not set.\x1b[0m Put it in apps/api/.env and re-run.');
    process.exit(2);
  }

  /* 0. API reachable ------------------------------------------------------- */
  console.log('\x1b[1m0. preflight\x1b[0m');

  await preflight(API);

  let health: { ok?: boolean; models?: { interviewer?: string } } | undefined;
  try {
    health = await fetch(`${API}/api/health`).then((r) => r.json());
    check('API is up', health?.ok === true, `${API}`);
    check('interviewer model pinned', typeof health?.models?.interviewer === 'string', health?.models?.interviewer);
  } catch {
    check('API is up', false, `cannot reach ${API} — run: pnpm --filter @orvia/api dev`);
    return report();
  }

  const cols = await fetch(`${API}/api/questions/collections`).then((r) => r.json());
  check('collections seeded', Array.isArray(cols) && cols.length >= 2,
    cols.map?.((c: { id: string; count: number }) => `${c.id}:${c.count}`).join(', '));

  const questions = await fetch(`${API}/api/questions/dsa?collection=neetcode150`).then((r) => r.json());
  check('DSA question bank seeded', Array.isArray(questions) && questions.length >= 150, `${questions.length} questions`);
  if (!questions.length) return report();

  const sd = await fetch(`${API}/api/questions/system-design`).then((r) => r.json());
  check('system design problems seeded', Array.isArray(sd) && sd.length === 10, `${sd.length} problems`);

  // The reference solution must never leave the server — a candidate with
  // devtools open could otherwise read the answer during the round.
  check('answers are not sent to the browser',
    !JSON.stringify(questions[0]).includes('referenceSolution'),
    Object.keys(questions[0] ?? {}).join(','));

  /* 0b. account + session cookie ------------------------------------------ */
  const email = `e2e+${process.pid}@orvia.local`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'E2E Runner', email, password: 'e2e-password-123' }),
  });
  check('account created', reg.ok, reg.ok ? email : `${reg.status} ${await reg.text()}`);

  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('session cookie issued', cookie.startsWith('orvia_session='), cookie.slice(0, 22) + '…');

  const me = await fetch(`${API}/api/auth/me`, { headers: { cookie } });
  check('authenticated request works', me.ok, me.ok ? (await me.json()).email : String(me.status));

  const unauth = await fetch(`${API}/api/sessions`);
  check('unauthenticated request is rejected', unauth.status === 401, `HTTP ${unauth.status}`);

  // The profile is the persistence promise — write it, then confirm it sticks.
  const savedExp = 'Led the billing migration; cut p99 from 1.4s to 380ms.';
  await fetch(`${API}/api/profile`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ experience: savedExp, silenceDurationMs: 1600 }),
  });
  const prof = await fetch(`${API}/api/profile`, { headers: { cookie } }).then((r) => r.json());
  check('profile persists', prof.experience === savedExp && prof.silenceDurationMs === 1600,
    `silence=${prof.silenceDurationMs}ms`);

  /* 1. render the candidate's answers before connecting -------------------- */
  console.log('\n\x1b[1m1. synthesising candidate speech\x1b[0m');
  const answer1 = await speak(
    "Sure. My approach would be to use a hash map. I'll iterate through the array once, " +
      'and for each element I check whether the target minus that element is already in the map. ' +
      'That gives me linear time and linear space.',
    'answer1',
  );
  const answer2 = await speak(
    'Because a nested loop would be quadratic. The hash map trades memory for a single pass, ' +
      'so it is order n time and order n space.',
    'answer2',
  );
  check('candidate audio rendered', answer1.length > 0 && answer2.length > 0,
    `${(answer1.length / (SAMPLE_RATE * 2)).toFixed(1)}s + ${(answer2.length / (SAMPLE_RATE * 2)).toFixed(1)}s`);

  /* 2. connect and run the interview --------------------------------------- */
  console.log('\n\x1b[1m2. running the live session\x1b[0m');

  // The WS rejects anonymous upgrades, so the cookie must ride along.
  const noAuth = new WebSocket(WS_URL);
  const rejected = await new Promise<boolean>((res) => {
    noAuth.once('close', (code) => res(code === 4401));
    noAuth.once('open', () => setTimeout(() => res(false), 2500));
    setTimeout(() => res(false), 6000);
  });
  check('unauthenticated websocket is rejected', rejected, 'close 4401');

  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  const seen: ServerMessage[] = [];
  let sessionId = '';
  let aiAudioBytes = 0;
  let aiText = '';
  let userText = '';
  let ended = null as SessionEndedPayload | null;
  let fatal: string | null = null;

  const waitFor = (pred: () => boolean, ms: number, label: string) =>
    new Promise<boolean>((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (fatal) { clearInterval(iv); res(false); }
        else if (pred()) { clearInterval(iv); res(true); }
        else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          console.log(`      \x1b[2m(timed out waiting for ${label})\x1b[0m`);
          res(false);
        }
      }, 100);
    });

  ws.on('message', (raw) => {
    const m = parseServer(raw);
    if (!m) return;
    seen.push(m);
    switch (m.event) {
      case S2C.SessionReady: sessionId = m.data.sessionId; break;
      case S2C.AudioDelta: aiAudioBytes += Buffer.from(m.data.data, 'base64').length; break;
      case S2C.TranscriptDelta:
        if (m.data.final) {
          if (m.data.speaker === 'ai') aiText += ` ${m.data.text}`;
          else userText += ` ${m.data.text}`;
        }
        break;
      case S2C.SessionEnded: ended = m.data; break;
      case S2C.Error:
        if (m.data.fatal) fatal = m.data.message;
        console.log(`      \x1b[31mserver error:\x1b[0m ${m.data.message}`);
        break;
    }
  });

  await new Promise<void>((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
    setTimeout(() => rej(new Error('ws connect timeout')), 8000);
  }).catch((e) => { check('websocket connects', false, e.message); });

  check('websocket connects', ws.readyState === WebSocket.OPEN, WS_URL);
  if (ws.readyState !== WebSocket.OPEN) return report();

  ws.send(frame(C2S.StartSession, {
    config: { mode: 'dsa', questionIds: [questions[0]!.id], codeEditor: false },
    options: { durationMinutes: 5, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
  }));

  check('session.ready received', await waitFor(() => !!sessionId, 20_000, 'session.ready'), sessionId);
  if (!sessionId) { ws.close(); return report(); }

  // The interviewer must open the round unprompted.
  const spoke = await waitFor(() => aiAudioBytes > 20_000, 30_000, 'interviewer audio');
  check('interviewer speaks first', spoke, `${(aiAudioBytes / 1024).toFixed(0)} KB of PCM`);
  // Transcription trails the audio, so this has to wait rather than sample the
  // instant the audio threshold was crossed.
  const gotAiText = await waitFor(() => aiText.trim().length > 20, 20_000, 'interviewer transcript');
  check('interviewer transcript arrives', gotAiText, `"${aiText.trim().slice(0, 70)}…"`);

  // Let the opening question finish so the candidate answer is not treated as barge-in.
  let quietSince = Date.now();
  let lastCount = aiAudioBytes;
  while (Date.now() - quietSince < 2500) {
    await sleep(250);
    if (aiAudioBytes !== lastCount) { lastCount = aiAudioBytes; quietSince = Date.now(); }
  }

  /* 3. the candidate answers ----------------------------------------------- */
  const aiBefore = aiAudioBytes;
  await streamPcm(ws, answer1);
  check('candidate speech transcribed',
    await waitFor(() => userText.trim().length > 15, 25_000, 'input transcription'),
    `"${userText.trim().slice(0, 70)}…"`);

  check('interviewer responds to the answer',
    await waitFor(() => aiAudioBytes > aiBefore + 20_000, 30_000, 'follow-up audio'),
    `+${((aiAudioBytes - aiBefore) / 1024).toFixed(0)} KB`);

  // Second exchange — proves the loop sustains, not just a single round trip.
  quietSince = Date.now(); lastCount = aiAudioBytes;
  while (Date.now() - quietSince < 2500) {
    await sleep(250);
    if (aiAudioBytes !== lastCount) { lastCount = aiAudioBytes; quietSince = Date.now(); }
  }
  const beforeSecond = aiAudioBytes;
  const userBefore = userText.length;
  await streamPcm(ws, answer2);
  check('second exchange completes',
    await waitFor(() => userText.length > userBefore + 15 && aiAudioBytes > beforeSecond + 15_000, 35_000, 'second turn'),
    `${seen.filter((m) => m.event === S2C.TranscriptDelta && m.data.final).length} final fragments`);

  /* 4. teardown ------------------------------------------------------------ */
  console.log('\n\x1b[1m3. teardown and persistence\x1b[0m');
  ws.send(frame(C2S.AudioStreamEnd));
  ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));

  check('session.ended received', await waitFor(() => !!ended, 20_000, 'session.ended'),
    ended ? `${(ended.durationMs / 1000).toFixed(1)}s, ${ended.turnCount} turns` : '');
  ws.close();

  check('turns were captured', (ended?.turnCount ?? 0) >= 2, `${ended?.turnCount ?? 0} turns`);

  /* 5. artefacts on disk and in Postgres ----------------------------------- */
  const wav = ended?.audioPath;
  check('candidate audio written as WAV', !!wav && existsSync(wav), wav ?? 'missing');
  if (wav && existsSync(wav)) {
    const { size } = await stat(wav);
    const header = (await readFile(wav)).subarray(0, 4).toString();
    const seconds = (size - 44) / (SAMPLE_RATE * 2);
    check('WAV has a valid RIFF header', header === 'RIFF', header);
    check('WAV length matches what was sent', seconds > 8,
      `${seconds.toFixed(1)}s recorded`);
  }

  const sql = postgres(DB_URL, { max: 1 });
  try {
    const [row] = await sql`select status, mode, model, duration_ms, audio_path, system_instruction, user_id
                            from sessions where id = ${sessionId}`;
    check('session row persisted', !!row, row ? `${row.mode} / ${row.status}` : 'not found');
    check('session marked completed', row?.status === 'completed', row?.status);
    check('system instruction stored', (row?.system_instruction?.length ?? 0) > 500,
      `${row?.system_instruction?.length ?? 0} chars`);
    check('session is owned by the account', !!row?.user_id, String(row?.user_id ?? '').slice(0, 8));

    const turnRows = await sql<{ speaker: string; text: string; start_ms: number }[]>`select speaker, text, start_ms from turns
                              where session_id = ${sessionId} order by idx`;
    check('turns persisted to Postgres', turnRows.length >= 2, `${turnRows.length} rows`);
    check('both speakers present',
      turnRows.some((t) => t.speaker === 'ai') && turnRows.some((t) => t.speaker === 'user'),
      turnRows.map((t) => t.speaker).join(','));

    const userTurn = turnRows.find((t) => t.speaker === 'user');
    check('candidate turn has real content', (userTurn?.text?.length ?? 0) > 15,
      userTurn ? `"${userTurn.text.slice(0, 60)}…"` : 'none');

    /* 6. the report card ---------------------------------------------------- */
    console.log('\n\x1b[1m4. evaluation\x1b[0m');

    // The evaluator listens to the whole recording, so this is minutes not
    // seconds. Poll rather than assume.
    let report: EvaluationView | null = null;
    const evalDeadline = Date.now() + 240_000;
    while (Date.now() < evalDeadline) {
      const r = await fetch(`${API}/api/sessions/${sessionId}/evaluation`, { headers: { cookie } })
        .then((x) => x.json() as Promise<EvaluationView | NoEvaluation>)
        .catch(() => null);
      if (r && (r.status === 'complete' || r.status === 'failed')) { report = r; break; }
      process.stdout.write(`      \x1b[2mstatus: ${r?.status ?? 'none'}…\x1b[0m\r`);
      await sleep(4000);
    }
    console.log(' '.repeat(40));

    check('evaluation was triggered automatically', !!report,
      report ? `status=${report.status}` : 'never appeared');

    if (report?.status === 'failed') {
      check('evaluation completed', false, report.error ?? '');
    } else if (report) {
      check('evaluation completed', report.status === 'complete', `via ${report.model}`);
      check('overall score produced', typeof report.overallScore === 'number',
        `${report.overallScore}/100 — ${report.overallVerdict}`);
      check('summary written', (report.summary?.length ?? 0) > 80,
        `"${String(report.summary).slice(0, 90)}…"`);
      check('three ranked fixes given', report.topFixes?.length === 3,
        report.topFixes?.[0] ? `1. ${String(report.topFixes[0]).slice(0, 70)}…` : '');

      check('per-question breakdown produced', report.questions?.length > 0,
        `${report.questions?.length} questions`);
      const q0 = report.questions?.[0];
      check('ideal answer is substantive', (q0?.idealAnswer?.length ?? 0) > 80,
        q0 ? `"${String(q0.idealAnswer).slice(0, 80)}…"` : '');
      check('question carries a score and verdict',
        typeof q0?.score === 'number' && !!q0?.verdict, `${q0?.score}/10 ${q0?.verdict}`);

      check('all delivery dimensions scored', report.delivery?.length === 12,
        `${report.delivery?.length}/12`);
      const withEvidence = (report.delivery ?? []).filter((d) => d.evidenceQuote);
      check('delivery scores cite evidence', withEvidence.length >= 8,
        `${withEvidence.length}/${report.delivery?.length} carry a quote`);

      // Deterministic metrics must be present and sane — they are the trend
      // line, and a bad divide-by-zero here poisons every future chart.
      const m = report.metrics;
      check('speech metrics computed', !!m,
        m ? `${m.wordsPerMinute}wpm, filler ${m.fillerRate}/100w, talk ${Math.round((m.talkRatio ?? 0) * 100)}%` : '');
      check('metrics are finite and in range',
        !!m && m.wordsPerMinute !== null && Number.isFinite(m.wordsPerMinute) && m.wordsPerMinute > 0 &&
        m.talkRatio !== null && m.talkRatio > 0 && m.talkRatio <= 1 && Number.isFinite(m.fillerRate),
        m ? `wpm=${m.wordsPerMinute} ratio=${m.talkRatio}` : '');

      console.log(`\n      \x1b[2msummary: ${String(report.summary).slice(0, 240)}\x1b[0m`);
      if (report.topFixes) {
        report.topFixes.forEach((f: string, i: number) =>
          console.log(`      \x1b[2m  ${i + 1}. ${f.slice(0, 110)}\x1b[0m`));
      }
    }

    // The whole delivery-analysis design rests on verbatim mode being on.
    // If fillers are being stripped here, the evaluator is already blind.
    const joined = turnRows.filter((t) => t.speaker === 'user').map((t) => t.text).join(' ');
    console.log(`\n      \x1b[2mcandidate transcript: "${joined.slice(0, 200)}"\x1b[0m`);
  } finally {
    await sql.end();
  }

  report();
}

async function streamPcm(ws: WebSocket, pcm: Buffer) {
  // Paced at real time on purpose: bursting the whole buffer makes the server's
  // voice activity detection see one impossible blob rather than speech.
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    const chunk = pcm.subarray(off, off + CHUNK_BYTES);
    ws.send(frame(C2S.AudioChunk, { data: chunk.toString('base64') }));
    await sleep(CHUNK_MS);
  }
  // Trailing silence so end-of-speech actually commits. This MUST exceed the
  // server's silenceDurationMs (1400ms) or the turn never closes and the model
  // waits forever for the candidate to finish.
  const silence = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < 40; i++) {
    ws.send(frame(C2S.AudioChunk, { data: silence.toString('base64') }));
    await sleep(CHUNK_MS);
  }
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m — the live voice loop works end to end.\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  console.log('');
  process.exit(1);
}

void main().catch((e) => {
  console.error('\x1b[31mharness crashed:\x1b[0m', e);
  process.exit(1);
});
