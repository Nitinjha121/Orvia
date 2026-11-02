/**
 * End-to-end suite testing recovery when upstream speech recognition stops receiving
 * microphone input, verifying that detection triggers socket rebuilds or model failover
 * and preserves session continuity.
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { assertTestDatabase } from './guard';
import { preflight } from './preflight';
import { C2S, S2C, frame, parseServer } from './protocol';
import type { SessionEndedPayload } from '../../packages/shared/src/events.js';
import type { EvaluationView, NoEvaluation } from '../../packages/shared/src/evaluation.js';

const exec = promisify(execFile);
const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test',
);
const TMP = join(tmpdir(), 'orvia-deaf');

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
/** The live model is really deaf: no injected fault, no healthy exchange first. */
const REAL = process.env.DEAF_REAL === '1';

let passed = 0;
const failures: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) passed++;
  else failures.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function speak(text: string, name: string): Promise<Buffer> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, `${name}.aiff`);
  const pcm = join(TMP, `${name}.pcm`);
  await exec('say', ['-v', 'Daniel', '-r', '175', '-o', aiff, text]);
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', pcm]);
  const buf = await readFile(pcm);
  await rm(aiff, { force: true });
  await rm(pcm, { force: true });
  return buf;
}

/**
 * Simulated continuous microphone: streams speech when queued and silence otherwise,
 * ensuring server voice activity detection receives a continuous stream.
 */
class Mic {
  private queue: Buffer[] = [];
  private timer: NodeJS.Timeout;
  private drained: (() => void)[] = [];
  constructor(private ws: WebSocket) {
    const silence = Buffer.alloc(CHUNK_BYTES);
    this.timer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      const chunk = this.queue.shift() ?? silence;
      this.ws.send(frame(C2S.AudioChunk, { data: chunk.toString('base64') }));
      if (!this.queue.length) this.drained.splice(0).forEach((r) => r());
    }, CHUNK_MS);
  }
  /** Resolves once the whole clip has gone out, paced at real time. */
  say(pcm: Buffer): Promise<void> {
    for (let off = 0; off < pcm.length; off += CHUNK_BYTES) this.queue.push(pcm.subarray(off, off + CHUNK_BYTES));
    return new Promise((r) => this.drained.push(r));
  }
  stop() {
    clearInterval(this.timer);
  }
}

async function main() {
  console.log('\n\x1b[1mOrvia — a server that stops hearing the microphone\x1b[0m\n');
  await preflight(API);

  const health = (await fetch(`${API}/api/health`).then((r) => r.json())) as {
    target?: { faults?: { deafAfterMs?: number } };
  };
  const faultMs = health.target?.faults?.deafAfterMs;
  if (REAL) {
    check('against a model that is really deaf', !faultMs, faultMs ? 'this stack also injects a fault' : 'no injected fault');
  } else if (!faultMs) {
    console.error(
      '\n\x1b[31mThe API at ' + API + ' was not started with E2E_FAULT_DEAF_AFTER_MS.\x1b[0m\n' +
        'This suite needs the injected fault; see the usage at the top of the file.\n',
    );
    process.exit(2);
  } else {
    check('the API under test injects the fault', true, `deaf from ${faultMs / 1000}s into each round`);
  }

  const questions = await fetch(`${API}/api/questions/dsa?collection=neetcode150`).then((r) => r.json());
  const email = `e2e+deaf-${process.pid}@orvia.local`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'E2E Deaf', email, password: 'e2e-password-123' }),
  });
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('account created', reg.ok && cookie.startsWith('orvia_session='), email);

  console.log('\n\x1b[1m1. synthesising candidate speech\x1b[0m');
  const healthy = await speak(
    'Sure. My approach is a hash map from each value to its index, so one pass finds the complement ' +
      'in constant time on average. That is linear time and linear space.',
    'healthy',
  );
  // Short answers with pauses between them: each pause is a point where a
  // hearing server would commit a transcript.
  const unheard = await Promise.all([
    'Could I ask whether the input can contain duplicate values?',
    'And can the array be empty, or is there always at least one element?',
    'Hello, I think you are not able to hear me.',
    'Can you hear me? I am still here.',
    'I will assume duplicates are allowed and carry on.',
  ].map((t, i) => speak(t, `unheard${i}`)));
  const repeat = await speak(
    'Sure. I asked whether the input can contain duplicate values, and whether the array can ever be empty.',
    'repeat',
  );
  check('candidate audio rendered', healthy.length > 0 && unheard.every((b) => b.length > 0) && repeat.length > 0);

  console.log('\n\x1b[1m2. the round\x1b[0m');
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  let sessionId = '';
  let startModel = '';
  let readyAt = 0;
  let aiAudioBytes = 0;
  let aiText = '';
  let userText = '';
  /** `userLen`: how much candidate text had arrived when the warning did. */
  const warnings: { code: string; message: string; at: number; userLen: number }[] = [];
  let ended: SessionEndedPayload | null = null;
  let fatal: string | null = null;

  ws.on('message', (raw) => {
    const m = parseServer(raw);
    if (!m) return;
    switch (m.event) {
      case S2C.SessionReady: sessionId = m.data.sessionId; startModel = m.data.model; readyAt = Date.now(); break;
      case S2C.AudioDelta: aiAudioBytes += Buffer.from(m.data.data, 'base64').length; break;
      case S2C.TranscriptDelta:
        if (m.data.final) {
          if (m.data.speaker === 'ai') aiText += ` ${m.data.text}`;
          else userText += ` ${m.data.text}`;
        }
        break;
      case S2C.SessionWarning:
        warnings.push({ code: m.data.code, message: m.data.message, at: Date.now(), userLen: userText.length });
        console.log(`      \x1b[2mwarning (${m.data.code}): ${m.data.message}\x1b[0m`);
        break;
      case S2C.SessionEnded: ended = m.data; break;
      case S2C.Error:
        if (m.data.fatal) fatal = m.data.message;
        console.log(`      \x1b[31mserver error:\x1b[0m ${m.data.message}`);
        break;
    }
  });
  const waitFor = (pred: () => boolean, ms: number) =>
    new Promise<boolean>((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (fatal || pred()) { clearInterval(iv); res(!fatal && pred()); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); }
      }, 100);
    });
  /** Until the interviewer has been quiet for `ms`, so an answer is not a barge-in. */
  const untilQuiet = async (ms = 2_500) => {
    let since = Date.now();
    let last = aiAudioBytes;
    while (Date.now() - since < ms) {
      await sleep(250);
      if (aiAudioBytes !== last) { last = aiAudioBytes; since = Date.now(); }
    }
  };

  await new Promise<void>((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  const mic = new Mic(ws);
  ws.send(frame(C2S.StartSession, {
    config: { mode: 'dsa', questionIds: [questions[0]!.id], codeEditor: false },
    options: { durationMinutes: 15, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
  }));
  check('session.ready', await waitFor(() => !!sessionId, 30_000), `${sessionId} on ${startModel}`);
  if (!sessionId) return finish(mic, ws);

  check('the interviewer opens', await waitFor(() => aiAudioBytes > 20_000, 45_000));
  // Longer than between answers: an opening pauses between its greeting and
  // the problem, and answering into that pause is a barge-in.
  await untilQuiet(5_000);

  let aiBefore = aiAudioBytes;
  if (!REAL) {
    // A healthy exchange first, so the recovery is compared against a line that worked.
    await mic.say(healthy);
    check('before the fault, the candidate is transcribed', await waitFor(() => userText.trim().length > 15, 25_000),
      `"${userText.trim().slice(0, 60)}…"`);
    check('...and answered', await waitFor(() => aiAudioBytes > aiBefore + 20_000, 40_000));
    await untilQuiet();
  }

  const faultAt = readyAt + (faultMs ?? 0);
  if (!REAL && Date.now() < faultAt) {
    console.log(`      \x1b[2mwaiting ${((faultAt - Date.now()) / 1000).toFixed(0)}s for the fault to begin\x1b[0m`);
    await sleep(faultAt - Date.now() + 2_000);
  }

  console.log('\n\x1b[1m3. the server stops hearing\x1b[0m');
  const userAtFault = userText.length;
  const deafWarned = () => warnings.some((w) => w.code === 'stalled' && /stopped hearing your microphone/.test(w.message));
  const deafSince = Date.now();
  for (const clip of unheard) {
    if (deafWarned()) break;
    await mic.say(clip);
    await sleep(5_000);
  }
  check('the candidate is told the interviewer stopped hearing them',
    await waitFor(deafWarned, 30_000),
    `${((Date.now() - deafSince) / 1000).toFixed(0)}s after the first unheard answer`);
  const reconnected = () => warnings.some((w) => w.code === 'reconnecting' && /did not hear what you said/.test(w.message));
  check('...then told to repeat themselves once reconnected', await waitFor(reconnected, 45_000));
  // Marked at the reconnect: the rebuilt interviewer may answer the replayed
  // speech while the check below is still waiting for its transcript.
  const aiAtRebuild = aiText.length;
  aiBefore = aiAudioBytes;
  /**
   * Measured at the reconnect: since `MicBacklog` replays missed speech to
   * the rebuilt socket, verify that the deaf socket itself transcribed none of it.
   */
  const atReconnect = warnings.find((w) => w.code === 'reconnecting')?.userLen ?? userText.length;
  check('nothing they said while deaf was transcribed by the deaf socket', atReconnect === userAtFault,
    atReconnect === userAtFault ? '' : `"${userText.slice(userAtFault, atReconnect).slice(0, 80)}"`);
  check('...and the rebuilt socket was replayed it',
    await waitFor(() => /duplicate|empty|hear me/i.test(userText.slice(atReconnect)), 30_000),
    `"${userText.slice(atReconnect).trim().slice(0, 80)}"`);

  console.log('\n\x1b[1m4. recovery on a clean socket\x1b[0m');
  check('the rebuilt interviewer speaks', await waitFor(() => aiAudioBytes > aiBefore + 10_000, 45_000));
  await untilQuiet();
  // Asks for it again, or — having been replayed it — answers it. Waited for:
  // replayed speech still arriving can cut its first reply short ("Yes, the").
  const tookUp = /(miss|again|repeat|lost|didn't catch|did not catch|come again|say that|duplicate|empty|element|hear you)/i;
  await waitFor(() => tookUp.test(aiText.slice(aiAtRebuild)), 30_000);
  await untilQuiet();
  const askedAgain = aiText.slice(aiAtRebuild).trim();
  check('...and takes up what it missed', tookUp.test(askedAgain), `"${askedAgain.slice(0, 120)}"`);
  check('...without greeting again', !/\b(hello|hi|welcome|my name is)\b/i.test(askedAgain.slice(0, 60)));

  const userAtRepeat = userText.length;
  aiBefore = aiAudioBytes;
  await mic.say(repeat);
  check('the repeated answer is transcribed', await waitFor(() => userText.length > userAtRepeat + 15, 25_000),
    `"${userText.slice(userAtRepeat).trim().slice(0, 70)}…"`);
  check('...and answered', await waitFor(() => aiAudioBytes > aiBefore + 20_000, 40_000));
  await untilQuiet();

  console.log('\n\x1b[1m5. what was recorded\x1b[0m');
  ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));
  check('session.ended', await waitFor(() => !!ended, 30_000));
  finish(mic, ws, false);

  const sql = postgres(DB_URL, { max: 1 });
  try {
    const [row] = await sql<{ interviewer_stalls: unknown; dead_ms: number; duration_ms: number }[]>`
      select interviewer_stalls, dead_ms, duration_ms from sessions where id = ${sessionId}`;
    const stalls = (row?.interviewer_stalls ?? []) as { deaf?: boolean; recovered: boolean; forMs: number; wallMs?: number; action: string }[];
    const deaf = stalls.find((s) => s.deaf);
    check('the deaf window is persisted as deaf', !!deaf, stalls.map((s) => s.action).join(' | '));
    check('...and as recovered', deaf?.recovered === true);
    check('...refunding its whole wall time', !!deaf && deaf.wallMs !== undefined && deaf.forMs === deaf.wallMs,
      deaf ? `${deaf.forMs}ms of ${deaf.wallMs}ms` : '');
    check('...into the round budget', (row?.dead_ms ?? 0) >= (deaf?.forMs ?? Infinity), `${row?.dead_ms}ms dead`);
    if (REAL) {
      check('the round failed over to another model', /on \S+ \(\S+ marked deaf\)/.test(deaf?.action ?? ''),
        deaf?.action.split(' — ')[1] ?? '');
      const h = (await fetch(`${API}/api/health`).then((r) => r.json())) as { unavailableModels?: { model: string; reason: string }[] };
      check('...and new rounds will skip the deaf one', !!h.unavailableModels?.some((m) => m.model === startModel && m.reason === 'not hearing audio'),
        JSON.stringify(h.unavailableModels ?? []));
    }

    const turns = await sql<{ speaker: string; text: string }[]>`
      select speaker, text from turns where session_id = ${sessionId} order by idx`;
    const user = turns.filter((t) => t.speaker === 'user').map((t) => t.text).join(' ');
    check('the repeated answer is in the stored transcript', /duplicate/i.test(user), `"${user.slice(-100)}"`);

    console.log('\n\x1b[1m6. the report\x1b[0m');
    let report: EvaluationView | NoEvaluation | null = null;
    const deadline = Date.now() + 480_000;
    while (Date.now() < deadline) {
      report = await fetch(`${API}/api/sessions/${sessionId}/evaluation`, { headers: { cookie } })
        .then((x) => x.json() as Promise<EvaluationView | NoEvaluation>)
        .catch(() => null);
      if (report && (report.status === 'complete' || report.status === 'failed')) break;
      await sleep(5_000);
    }
    check('the round is evaluated', report?.status === 'complete',
      report?.status === 'complete' ? `${(report as EvaluationView).overallScore}/100` : String(report?.status));
  } finally {
    await sql.end();
  }
  report();
}

function finish(mic: Mic, ws: WebSocket, andReport = true) {
  mic.stop();
  ws.close();
  if (andReport) report();
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (!failures.length) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  process.exit(1);
}

void main().catch((e) => {
  console.error('\x1b[31mharness crashed:\x1b[0m', e);
  process.exit(1);
});
