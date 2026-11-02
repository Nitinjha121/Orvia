/**
 * End-to-end suite for question rotation and attempted tracking across modes,
 * verifying that only substantive completed rounds consume questions from the draw pool
 * and that short abandonments do not mark questions as spent.
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
/** Import shared constants by path to match the API definitions directly. */
import { HANDOUT_MIN_MS, DEFAULT_COLLECTION } from '../../packages/shared/src/modes.js';
import { assertTestDatabase } from './guard';
import { preflight } from './preflight';
import { C2S, S2C, frame, parseServer } from './protocol';

const exec = promisify(execFile);
const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test',
);
const TMP = '/tmp/orvia-assignment';

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

/** Comfortably past the floor, so a slow finalize cannot make this flaky. */
const REAL_ROUND_SECONDS = Number(process.env.ROUND_SECONDS ?? 66);

let passed = 0;
const failures: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) passed++;
  else failures.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── the candidate's voice ─────────────────────────────────────────────────── */

/**
 * Real speech, not a tone: the Live API's voice activity detection ignores
 * synthetic noise, so a tone would never open a turn.
 */
async function speak(text: string, name: string): Promise<Buffer> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, `${name}.aiff`);
  const pcm = join(TMP, `${name}.pcm`);
  await exec('say', ['-v', 'Daniel', '-r', '175', '-o', aiff, text]);
  await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', aiff,
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', pcm,
  ]);
  const buf = await readFile(pcm);
  await rm(aiff, { force: true });
  await rm(pcm, { force: true });
  return buf;
}

async function streamPcm(ws: WebSocket, pcm: Buffer) {
  // Paced at real time: bursting the buffer makes the server's VAD see one
  // impossible blob rather than speech.
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    ws.send(frame(C2S.AudioChunk, { data: pcm.subarray(off, off + CHUNK_BYTES).toString('base64') }));
    await sleep(CHUNK_MS);
  }
  // Trailing silence, or end-of-speech never commits and the model waits
  // forever for the candidate to finish. Must exceed silenceDurationMs.
  const silence = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < 40; i++) {
    ws.send(frame(C2S.AudioChunk, { data: silence.toString('base64') }));
    await sleep(CHUNK_MS);
  }
}

/* ── the pool, exactly as the setup panel computes it ──────────────────────── */

type Q = { id: string; title: string; difficulty: string; topics: string[] };
type Outcome = 'solved' | 'partial' | 'unsolved' | 'not_reached' | null;
type Attempt = { id: string; count: number; lastAt: string; outcome: Outcome };

/** Mirrors `SurpriseRules`. Easy-only keeps the drawn question quick to answer. */
const RULES = {
  difficulties: ['easy'],
  topics: [] as string[],
  avoidRepeats: true,
  repeatUnsolved: true,
};

/**
 * The draw pool. Deliberately a re-implementation rather than an import: this
 * asserts the SERVER hands back what the client needs to reach that answer, so
 * sharing the client's code would hide a protocol change.
 */
function poolOf(
  questions: Q[],
  attempts: Attempt[],
  cycleAt: string | null,
  repeatUnsolved = RULES.repeatUnsolved,
) {
  const parsed = cycleAt ? Date.parse(cycleAt) : 0;
  const floor = Number.isNaN(parsed) ? 0 : parsed;
  const thisCycle = new Map(
    attempts
      .filter((a) => Date.parse(a.lastAt) >= floor)
      .map((a) => [a.id, a.outcome ?? null] as const),
  );

  /**
   * Spent for the purposes of the draw.
   *
   * `null` — no finished report — counts as spent. No verdict is NOT the same
   * as having failed: without this, ending a round would immediately re-offer
   * the same question while its evaluation was still transcribing.
   */
  const spent = (id: string) => {
    if (!thisCycle.has(id)) return false;
    if (!repeatUnsolved) return true;
    const outcome = thisCycle.get(id) ?? null;
    return outcome === null || outcome === 'solved';
  };

  return questions.filter((q) => {
    if (RULES.difficulties.length && !RULES.difficulties.includes(q.difficulty)) return false;
    if (RULES.topics.length && !(q.topics ?? []).some((t) => RULES.topics.includes(t))) return false;
    return !(RULES.avoidRepeats && spent(q.id));
  });
}

/* ── one real round ────────────────────────────────────────────────────────── */

type RoundResult = {
  sessionId: string;
  ended: { durationMs?: number; turnCount?: number } | null;
  aiAudioBytes: number;
  userText: string;
  fatal: string | null;
};

/**
 * Runs a round through the real gateway.
 *
 * `minSeconds` of 0 means stop the instant the session exists — the short-round
 * cases. `drop` terminates the socket instead of stopping cleanly, which is the
 * only path that actually yields status `aborted`; `session.stop` never does,
 * however fast it arrives.
 */
async function runRound(
  cookie: string,
  question: string | string[],
  minSeconds: number,
  drop = false,
  /**
   * What the round is. Defaults to a DSA round on the given slugs; the spoken
   * modes pass their own config, because the whole point of sections 7 and 8
   * is that the gateway records a real round of THAT mode.
   */
  config?: Record<string, unknown>,
  answer = DEFAULT_ANSWER,
): Promise<RoundResult> {
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  let sessionId = '';
  let aiAudioBytes = 0;
  let userText = '';
  let ended: RoundResult['ended'] = null;
  let fatal: string | null = null;

  ws.on('message', (raw) => {
    const m = parseServer(raw);
    if (!m) return;
    switch (m.event) {
      case S2C.SessionReady: sessionId = m.data.sessionId; break;
      case S2C.AudioDelta: aiAudioBytes += Buffer.from(m.data.data, 'base64').length; break;
      case S2C.TranscriptDelta:
        if (m.data.final && m.data.speaker === 'user') userText += ` ${m.data.text}`;
        break;
      case S2C.SessionEnded: ended = m.data; break;
      case S2C.Error:
        if (m.data.fatal) fatal = m.data.message;
        console.log(`      \x1b[31mserver error:\x1b[0m ${m.data.message}`);
        break;
    }
  });

  const waitFor = async (pred: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fatal) return false;
      if (pred()) return true;
      await sleep(150);
    }
    return false;
  };

  await new Promise<void>((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
    setTimeout(() => rej(new Error('ws connect timeout')), 10_000);
  });

  const startedAt = Date.now();
  ws.send(frame(C2S.StartSession, {
    config: config ?? {
      mode: 'dsa',
      // Order is meaningful: the interviewer works through the list in order,
      // and "which one did it reach" depends on that being the server's list.
      questionIds: Array.isArray(question) ? question : [question],
      codeEditor: false,
    },
    options: { durationMinutes: 5, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
  }));
  await waitFor(() => !!sessionId, 25_000);

  if (minSeconds > 0 && sessionId) {
    await waitFor(() => aiAudioBytes > 20_000, 40_000);
    // Let the opening finish, or the answer below is treated as barge-in.
    let quiet = Date.now();
    let last = aiAudioBytes;
    while (Date.now() - quiet < 2500) {
      await sleep(250);
      if (aiAudioBytes !== last) { last = aiAudioBytes; quiet = Date.now(); }
    }
    await streamPcm(ws, await speak(answer, 'answer'));
    await waitFor(() => userText.trim().length > 15, 25_000);
    while ((Date.now() - startedAt) / 1000 < minSeconds) await sleep(1000);
  }

  if (drop) {
    ws.terminate();
    await sleep(3000); // let the gateway notice and finalize
  } else {
    ws.send(frame(C2S.AudioStreamEnd));
    ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));
    await waitFor(() => !!ended, 25_000);
    ws.close();
  }
  return { sessionId, ended, aiAudioBytes, userText, fatal };
}

const DEFAULT_ANSWER =
  'I would use a hash map. I iterate through the input once, and for each element I check ' +
  'whether the value I need is already stored. That gives linear time and linear space, ' +
  'which beats the quadratic nested loop.';

/**
 * The pool for a mode with one facet and no per-question verdict of its own.
 *
 * Same shape as `poolOf` above and deliberately still a re-implementation: it
 * asserts the SERVER hands back what a client needs, so importing the client's
 * own rules would hide a protocol change behind a passing test. What it drops
 * is the difficulty and topic rules, which these sections do not set.
 */
function simplePool<T extends { id: string }>(
  items: T[], attempts: Attempt[], cycleAt: string | null, repeatUnsolved = true,
) {
  const parsed = cycleAt ? Date.parse(cycleAt) : 0;
  const floor = Number.isNaN(parsed) ? 0 : parsed;
  const thisCycle = new Map(
    attempts.filter((a) => Date.parse(a.lastAt) >= floor).map((a) => [a.id, a.outcome ?? null] as const),
  );
  const spent = (id: string) => {
    if (!thisCycle.has(id)) return false;
    if (!repeatUnsolved) return true;
    const outcome = thisCycle.get(id) ?? null;
    return outcome === null || outcome === 'solved';
  };
  return items.filter((i) => !spent(i.id));
}

/* ── the suite ─────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n\x1b[1mOrvia — random question assignment, end to end\x1b[0m\n');

  if (!process.env.GEMINI_API_KEY) {
    console.error('\x1b[31mGEMINI_API_KEY is not set.\x1b[0m Put it in apps/api/.env and re-run.');
    process.exit(2);
  }

  console.log('\x1b[1m0. preflight\x1b[0m');

  await preflight(API);

  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  check('API is up', health?.ok === true,
    health?.ok ? API : `cannot reach ${API} — run: pnpm api:test`);
  if (!health?.ok) return report();

  const sql = postgres(DB_URL, { max: 1 });
  const email = `assignment-e2e+${process.pid}@orvia.local`;
  // Deletes the account on every exit path, a crash included: an early
  // `report()` exits the process, so a `finally` here would never run.
  cleanup = async () => {
    cleanup = async () => {};
    await sql`delete from users where email = ${email}`.catch(() => {});
    await sql.end();
    await rm(TMP, { recursive: true, force: true });
  };
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Assignment E2E', email, password: 'assignment-password-123' }),
  });
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('account created', reg.ok && cookie.startsWith('orvia_session='), email);
  if (!cookie) return finish();

  const get = <T>(path: string) =>
    fetch(`${API}${path}`, { headers: { cookie } }).then((r) => r.json() as Promise<T>);

  const unauth = await fetch(`${API}/api/questions/attempted`);
  check('attempted history requires an account', unauth.status === 401, `HTTP ${unauth.status}`);

  const questions = await get<Q[]>(`/api/questions/dsa?collection=${DEFAULT_COLLECTION}`);
  check('question bank seeded', questions.length >= 150, `${questions.length} questions`);
  if (!questions.length) return finish();

  let attempts = await get<Attempt[]>('/api/questions/attempted');
  check('a fresh account has been handed nothing', attempts.length === 0, `${attempts.length} attempts`);

  const pool0 = poolOf(questions, attempts, null);
  const easyTotal = questions.filter((q) => q.difficulty === 'easy').length;
  check('opening pool is every question the rules allow', pool0.length === easyTotal,
    `${pool0.length} of ${questions.length}`);
  if (pool0.length < 3) return finish();

  const drawn = pool0[Math.floor(Math.random() * pool0.length)]!;
  console.log(`\n  \x1b[1mdrawn:\x1b[0m ${drawn.title}  \x1b[2m(${drawn.id})\x1b[0m\n`);

  /* 1. a real round on the drawn question --------------------------------- */
  console.log('\x1b[1m1. a real round on the drawn question\x1b[0m');
  const real = await runRound(cookie, drawn.id, REAL_ROUND_SECONDS);
  check('gateway ran the round', !real.fatal && !!real.sessionId,
    real.fatal ?? real.sessionId.slice(0, 8));
  if (!real.sessionId) return finish();
  check('interviewer actually spoke', real.aiAudioBytes > 20_000,
    `${(real.aiAudioBytes / 1024).toFixed(0)} KB of PCM`);
  check('candidate speech was transcribed', real.userText.trim().length > 15,
    `"${real.userText.trim().slice(0, 60)}…"`);
  check('round cleared the handout floor',
    (real.ended?.durationMs ?? 0) >= HANDOUT_MIN_MS,
    `${((real.ended?.durationMs ?? 0) / 1000).toFixed(1)}s vs ${HANDOUT_MIN_MS / 1000}s floor`);

  const [realRow] = await sql`
    select status, duration_ms, config->>'questionIds' as qids
    from sessions where id = ${real.sessionId}`;
  check('session persisted with the drawn slug',
    realRow?.status === 'completed' && String(realRow?.qids).includes(drawn.id),
    `${realRow?.status} ${realRow?.qids}`);

  /* 2. the draw stops offering it ------------------------------------------ */
  console.log('\n\x1b[1m2. the draw stops offering it\x1b[0m');
  attempts = await get<Attempt[]>('/api/questions/attempted');
  const mine = attempts.find((a) => a.id === drawn.id);
  check('the round shows up as attempted', !!mine, `${attempts.length} attempt(s)`);
  check('counted exactly once', mine?.count === 1, String(mine?.count));
  check('lastAt is the round just run',
    !!mine && Date.now() - Date.parse(mine.lastAt) < 10 * 60_000, mine?.lastAt ?? '');

  const pool1 = poolOf(questions, attempts, null);
  check('the pool shrank by exactly one', pool1.length === pool0.length - 1,
    `${pool0.length} → ${pool1.length}`);
  check('the drawn question is gone from the pool', !pool1.some((q) => q.id === drawn.id), drawn.id);
  // The rotation's whole promise. One draw proves nothing; the distribution does.
  const redraws = Array.from({ length: 500 }, () => pool1[Math.floor(Math.random() * pool1.length)]!.id);
  check('500 further draws never return it', !redraws.includes(drawn.id),
    `${new Set(redraws).size} distinct questions drawn`);

  /* 3. rounds too short to have asked anything ----------------------------- */
  console.log('\n\x1b[1m3. a round too short to ask anything does not spend a question\x1b[0m');

  // Stopped at once. The gateway calls this `completed` — the exact trap.
  const stopped = pool1[0]!;
  const short = await runRound(cookie, stopped.id, 0);
  const [shortRow] = await sql`select status, duration_ms from sessions where id = ${short.sessionId}`;
  check('an instant stop is still recorded as completed', shortRow?.status === 'completed',
    `${shortRow?.status} / ${shortRow?.duration_ms}ms`);
  check('and is under the floor', (shortRow?.duration_ms ?? 1e9) < HANDOUT_MIN_MS,
    `${shortRow?.duration_ms}ms`);
  const afterShort = await get<Attempt[]>('/api/questions/attempted');
  check('a completed sub-second round does NOT spend the question',
    !afterShort.some((a) => a.id === stopped.id), stopped.id);
  check('it is still drawable',
    poolOf(questions, afterShort, null).some((q) => q.id === stopped.id), stopped.id);

  // A dropped socket — the path that really produces `aborted`.
  const dropped = pool1[1]!;
  const abort = await runRound(cookie, dropped.id, 0, true);
  const [abortRow] = await sql`select status, duration_ms from sessions where id = ${abort.sessionId}`;
  check('a dropped connection is recorded as aborted', abortRow?.status === 'aborted',
    `${abortRow?.status} / ${abortRow?.duration_ms}ms`);
  const afterAbort = await get<Attempt[]>('/api/questions/attempted');
  check('an aborted round does NOT spend the question',
    !afterAbort.some((a) => a.id === dropped.id), dropped.id);

  const pool2 = poolOf(questions, afterAbort, null);
  check('exactly one question was spent across three rounds',
    pool2.length === pool0.length - 1, `${pool0.length} → ${pool2.length}`);

  /* 4. the cycle marker, over real history --------------------------------- */
  console.log('\n\x1b[1m4. resetting the cycle brings it back\x1b[0m');
  // What "Reset cycle" does: move the line, delete nothing.
  const afterReset = poolOf(questions, afterAbort, new Date().toISOString());
  check('a reset restores the full pool', afterReset.length === pool0.length,
    `${pool2.length} → ${afterReset.length}`);
  check('including the question just answered',
    afterReset.some((q) => q.id === drawn.id), drawn.id);
  const stillThere = await sql`select count(*)::int as n from sessions where id = ${real.sessionId}`;
  check('and the round itself is untouched', stillThere[0]?.n === 1, 'session still on record');

  /* 5. the report decides whether it comes back ---------------------------- */
  console.log('\n\x1b[1m5. failing a question puts it back in the rotation\x1b[0m');
  /**
   * Evaluator verdicts are stubbed to test the read path and verify that
   * rotation handles different question outcomes without full model evaluations.
   */
  const evalOf = async (sessionId: string, outcome: string, created: Date) => {
    const [row] = await sql`
      insert into evaluations (session_id, status, model, provider, rubric_version, created_at)
      values (${sessionId}, 'complete', 'stub', 'stub', 'test', ${created})
      returning id`;
    await sql`
      insert into question_outcomes (evaluation_id, question_id, idx, outcome, reason)
      values (${row!.id}, ${drawn.id}, 0, ${outcome}, 'assignment e2e')`;
    return row!.id as string;
  };

  /**
   * Before any of that: the round has already queued a REAL evaluation, and it
   * has not finished. So there is no verdict yet — and a question with no
   * verdict has to stay spent. Otherwise finishing a round would immediately
   * offer the same problem back while its report was still transcribing.
   */
  const [queued] = await sql`
    select count(*)::int as n from evaluations where session_id = ${real.sessionId}`;
  check('the finished round queued its own evaluation', (queued?.n ?? 0) >= 1,
    `${queued?.n} evaluation row(s)`);
  const pending = await get<Attempt[]>('/api/questions/attempted');
  check('no verdict yet, so no outcome is reported',
    pending.find((a) => a.id === drawn.id)?.outcome == null,
    String(pending.find((a) => a.id === drawn.id)?.outcome));
  check('and the question stays spent while the report is still running',
    !poolOf(questions, pending, null).some((q) => q.id === drawn.id), drawn.id);

  /**
   * That real evaluation is now in the way: it is newer than anything stubbed
   * below, and "latest evaluation wins" would keep picking it. Dropped so the
   * ordering under test is the one written here.
   */
  await sql`delete from evaluations where session_id = ${real.sessionId}`;

  await evalOf(real.sessionId, 'unsolved', new Date(Date.now() - 60_000));
  let withOutcome = await get<Attempt[]>('/api/questions/attempted');
  check('the verdict reaches the rotation',
    withOutcome.find((a) => a.id === drawn.id)?.outcome === 'unsolved',
    String(withOutcome.find((a) => a.id === drawn.id)?.outcome));
  check('a question you did not solve is drawable again',
    poolOf(questions, withOutcome, null).some((q) => q.id === drawn.id), drawn.id);
  check('the pool is whole again',
    poolOf(questions, withOutcome, null).length === pool0.length,
    `${pool2.length} → ${poolOf(questions, withOutcome, null).length}`);
  // The old behaviour, still available: asked is spent, however it went.
  check('with "keep asking" off it stays spent',
    !poolOf(questions, withOutcome, null, false).some((q) => q.id === drawn.id), drawn.id);

  await sql`update question_outcomes set outcome = 'partial' where question_id = ${drawn.id}`;
  withOutcome = await get<Attempt[]>('/api/questions/attempted');
  check('a partial solve also comes back',
    poolOf(questions, withOutcome, null).some((q) => q.id === drawn.id),
    'brute force never improved is unfinished business');

  await sql`update question_outcomes set outcome = 'solved' where question_id = ${drawn.id}`;
  withOutcome = await get<Attempt[]>('/api/questions/attempted');
  check('only solving it retires it',
    !poolOf(questions, withOutcome, null).some((q) => q.id === drawn.id), drawn.id);

  /**
   * A retry inserts an additional evaluation row; verify that the newest
   * evaluation takes precedence and questions are not double counted.
   */
  await evalOf(real.sessionId, 'unsolved', new Date());
  withOutcome = await get<Attempt[]>('/api/questions/attempted');
  check('a re-evaluation overrides the older verdict',
    withOutcome.find((a) => a.id === drawn.id)?.outcome === 'unsolved',
    String(withOutcome.find((a) => a.id === drawn.id)?.outcome));
  check('counted once despite two evaluations',
    withOutcome.find((a) => a.id === drawn.id)?.count === 1,
    String(withOutcome.find((a) => a.id === drawn.id)?.count));
  check('and it is back in the pool', 
    poolOf(questions, withOutcome, null).some((q) => q.id === drawn.id), drawn.id);

  /* 6. a question the round never reached is not a handout ----------------- */
  console.log('\n\x1b[1m6. a multi-question round only spends what it reached\x1b[0m');
  /**
   * Verify that a multi-question round only spends questions actually reached,
   * without retiring questions configured but never presented.
   */
  const trio = poolOf(questions, withOutcome, null)
    .filter((q) => q.id !== drawn.id)
    .slice(0, 3);
  check('three questions available for a multi-question round', trio.length === 3,
    `${trio.length} available`);

  if (trio.length === 3) {
    const multi = await runRound(cookie, trio.map((q) => q.id), REAL_ROUND_SECONDS);
    check('the multi-question round ran', !multi.fatal && !!multi.sessionId,
      multi.fatal ?? multi.sessionId.slice(0, 8));

    const [multiRow] = await sql`
      select current_question_idx, duration_ms from sessions where id = ${multi.sessionId}`;
    check('a minute-long round never got past the first problem',
      multiRow?.current_question_idx === 0,
      `reached index ${multiRow?.current_question_idx}`);

    const afterMulti = await get<Attempt[]>('/api/questions/attempted');
    check('the problem it actually asked is spent',
      afterMulti.some((a) => a.id === trio[0]!.id), trio[0]!.id);
    check('the two it never reached are NOT spent',
      !afterMulti.some((a) => a.id === trio[1]!.id) &&
        !afterMulti.some((a) => a.id === trio[2]!.id),
      `${trio[1]!.id}, ${trio[2]!.id}`);
    const poolMulti = poolOf(questions, afterMulti, null);
    check('so the pool lost one question, not three',
      poolMulti.length === poolOf(questions, withOutcome, null).length - 1,
      `${poolOf(questions, withOutcome, null).length} → ${poolMulti.length}`);
  }

  /* 7. the same rotation, on a spoken concepts round ----------------------- */
  console.log('\n\x1b[1m7. a concepts round spends a concept question\x1b[0m');

  type ConceptQ = { id: string; topic: string; title: string; difficulty: string };
  const conceptBank = await get<ConceptQ[]>('/api/questions/concepts');
  check('concept bank seeded with enough to draw from', conceptBank.length >= 48,
    `${conceptBank.length} questions`);
  /**
   * Asserted against served rows to ensure each topic maintains sufficient
   * question depth before repeats are needed.
   */
  const perTopic = new Map<string, number>();
  for (const q of conceptBank) perTopic.set(q.topic, (perTopic.get(q.topic) ?? 0) + 1);
  const thinTopics = [...perTopic.entries()].filter(([, n]) => n < 10);
  check('every served topic carries at least ten questions', thinTopics.length === 0,
    thinTopics.map(([t, n]) => `${t}=${n}`).join(', ') ||
      [...perTopic.entries()].map(([t, n]) => `${t}=${n}`).join(' '));
  check('the browser is never sent the answers',
    conceptBank.every((q) => !('expectedPoints' in q) && !('commonMistakes' in q) && !('probes' in q)),
    Object.keys(conceptBank[0] ?? {}).join(', '));

  let conceptAttempts = await get<Attempt[]>('/api/questions/attempted?mode=concepts');
  check('a fresh account has been handed no concept questions', conceptAttempts.length === 0,
    `${conceptAttempts.length} attempts`);
  check('and the DSA history is a different list',
    (await get<Attempt[]>('/api/questions/attempted')).length > 0,
    'one endpoint, one bank per mode');

  const conceptPool0 = simplePool(conceptBank, conceptAttempts, null);
  const conceptDrawn = conceptPool0[Math.floor(Math.random() * conceptPool0.length)]!;
  console.log(`  \x1b[2mdrawn: ${conceptDrawn.title} (${conceptDrawn.id})\x1b[0m`);

  const conceptRound = await runRound(
    cookie, conceptDrawn.id, REAL_ROUND_SECONDS, false,
    { mode: 'concepts', questionIds: [conceptDrawn.id], depth: 'practical' },
    'It runs on a single thread, and the work is handed to the operating system rather than ' +
      'to a thread of its own, so one slow piece of computation blocks everything behind it.',
  );
  check('the gateway ran a real concepts round',
    !conceptRound.fatal && !!conceptRound.sessionId,
    conceptRound.fatal ?? conceptRound.sessionId.slice(0, 8));
  check('the interviewer spoke in a mode with no editor', conceptRound.aiAudioBytes > 20_000,
    `${(conceptRound.aiAudioBytes / 1024).toFixed(0)} KB of PCM`);

  const [conceptRow] = await sql`
    select mode, status, duration_ms, config->>'questionIds' as qids
    from sessions where id = ${conceptRound.sessionId}`;
  check('persisted as a concepts session with the drawn id',
    conceptRow?.mode === 'concepts' && String(conceptRow?.qids).includes(conceptDrawn.id),
    `${conceptRow?.mode} ${conceptRow?.qids}`);

  conceptAttempts = await get<Attempt[]>('/api/questions/attempted?mode=concepts');
  check('the concepts round shows up as attempted',
    conceptAttempts.some((a) => a.id === conceptDrawn.id), `${conceptAttempts.length} attempt(s)`);
  const conceptPool1 = simplePool(conceptBank, conceptAttempts, null);
  check('the concepts pool shrank by exactly one',
    conceptPool1.length === conceptPool0.length - 1,
    `${conceptPool0.length} → ${conceptPool1.length}`);
  check('it does not leak into the DSA rotation',
    !(await get<Attempt[]>('/api/questions/attempted')).some((a) => a.id === conceptDrawn.id),
    conceptDrawn.id);

  /**
   * The read path, as in section 5: given a verdict, does the rotation
   * respond? Stubbed for the same reason — producing it costs a real
   * ten-minute evaluation — and dropping the round's own real evaluation
   * first, because "latest wins" would otherwise keep choosing it.
   */
  await sql`delete from evaluations where session_id = ${conceptRound.sessionId}`;
  const [conceptEval] = await sql`
    insert into evaluations (session_id, status, model, provider, rubric_version)
    values (${conceptRound.sessionId}, 'complete', 'stub', 'stub', 'test') returning id`;
  await sql`
    insert into question_outcomes (evaluation_id, question_id, idx, outcome, reason)
    values (${conceptEval!.id}, ${conceptDrawn.id}, 0, 'partial', 'assignment e2e')`;
  conceptAttempts = await get<Attempt[]>('/api/questions/attempted?mode=concepts');
  check('a concept question the evaluator scored partial comes back',
    conceptAttempts.find((a) => a.id === conceptDrawn.id)?.outcome === 'partial' &&
      simplePool(conceptBank, conceptAttempts, null).some((q) => q.id === conceptDrawn.id),
    'an answer you could not defend is unfinished business');

  await sql`update question_outcomes set outcome = 'solved' where evaluation_id = ${conceptEval!.id}`;
  conceptAttempts = await get<Attempt[]>('/api/questions/attempted?mode=concepts');
  check('and only getting it right retires it',
    !simplePool(conceptBank, conceptAttempts, null).some((q) => q.id === conceptDrawn.id),
    conceptDrawn.id);

  /* 8. system design, where the round is one problem ----------------------- */
  console.log('\n\x1b[1m8. a system design round spends its problem\x1b[0m');

  type DesignProblem = { id: string; title: string; level: string; prompt: string };
  const designBank = await get<DesignProblem[]>('/api/questions/system-design');
  check('system design bank seeded', designBank.length >= 5, `${designBank.length} problems`);

  let designAttempts = await get<Attempt[]>('/api/questions/attempted?mode=system_design');
  check('a fresh account has been handed no design problems', designAttempts.length === 0);

  const designPool0 = simplePool(designBank, designAttempts, null);
  const designDrawn = designPool0[Math.floor(Math.random() * designPool0.length)]!;
  console.log(`  \x1b[2mdrawn: ${designDrawn.title} (${designDrawn.id})\x1b[0m`);

  const designRound = await runRound(
    cookie, designDrawn.id, REAL_ROUND_SECONDS, false,
    {
      mode: 'system_design',
      problem: designDrawn.prompt,
      // The field the rotation resolves against. Without it this round would
      // only be identifiable by matching its prompt text back to the bank.
      problemId: designDrawn.id,
      level: 'mid',
      scratchpad: false,
    },
    'I would start with the read and write rates, because that decides whether this is one ' +
      'database or a cache in front of one. Then the data model, then where it has to fan out.',
  );
  check('the gateway ran a real system design round',
    !designRound.fatal && !!designRound.sessionId,
    designRound.fatal ?? designRound.sessionId.slice(0, 8));

  designAttempts = await get<Attempt[]>('/api/questions/attempted?mode=system_design');
  check('the design round shows up as attempted, by id',
    designAttempts.some((a) => a.id === designDrawn.id), `${designAttempts.length} attempt(s)`);
  check('with no verdict, because this mode has none',
    designAttempts.find((a) => a.id === designDrawn.id)?.outcome === null,
    'a design round is scored by phase, not solved or not');
  const designPool1 = simplePool(designBank, designAttempts, null);
  check('and is retired from the draw anyway',
    !designPool1.some((p) => p.id === designDrawn.id) &&
      designPool1.length === designPool0.length - 1,
    `${designPool0.length} → ${designPool1.length}`);

  /**
   * Legacy rounds lacking `problemId` identify problems by prompt text;
   * verify that prompt-based resolution still matches the question bank.
   */
  const legacyProblem = designPool1.find((p) => p.id !== designDrawn.id)!;
  await sql`
    insert into sessions (user_id, mode, status, config, options, duration_ms, started_at, model, voice)
    select id, 'system_design', 'completed',
           ${JSON.stringify({ mode: 'system_design', problem: legacyProblem.prompt, level: 'mid', scratchpad: false })}::jsonb,
           ${JSON.stringify({ durationMinutes: 30, difficulty: 'standard', persona: 'neutral', voice: 'Charon' })}::jsonb,
           ${HANDOUT_MIN_MS + 5_000}, now(), 'stub', 'Charon'
    from users where email = ${email}`;
  designAttempts = await get<Attempt[]>('/api/questions/attempted?mode=system_design');
  check('a round from before problemId existed still resolves by its prompt',
    designAttempts.some((a) => a.id === legacyProblem.id), legacyProblem.id);

  /* 9. the endpoint refuses a mode that has no draw ------------------------ */
  console.log('\n\x1b[1m9. only the modes with a draw are addressable\x1b[0m');
  const badMode = await fetch(`${API}/api/questions/attempted?mode=behavioural`, { headers: { cookie } });
  check('a mode with no rotation is rejected, not silently emptied',
    badMode.status === 400, `HTTP ${badMode.status}`);
  const noMode = await fetch(`${API}/api/questions/attempted`, { headers: { cookie } });
  check('and omitting the mode still means DSA', noMode.ok, `HTTP ${noMode.status}`);

  await finish();
}

let cleanup: () => Promise<void> = async () => {};

async function finish(): Promise<never> {
  await cleanup();
  return report();
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m — a real round is what spends a question.\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  console.log('');
  process.exit(1);
}

void main().catch(async (e) => {
  console.error('\x1b[31mharness crashed:\x1b[0m', e);
  await cleanup().catch(() => {});
  process.exit(1);
});
