/**
 * End-to-end suite for the practice cycle: committing to fixes, carrying fixes into rounds,
 * running targeted drills with before/after comparisons, and verifying onsite loop staging.
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
import type { EvaluationView, NoEvaluation } from '../../packages/shared/src/evaluation.js';
import type { SessionReadyPayload } from '../../packages/shared/src/events.js';
import { HANDOUT_MIN_MS } from '../../packages/shared/src/modes.js';
import { DRILL_MINUTES, type CommitmentView, type MomentsView } from '../../packages/shared/src/drills.js';
import type { LoopView, PlanSummary } from '../../packages/shared/src/plan.js';

const exec = promisify(execFile);
const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test');
const TMP = join(tmpdir(), 'orvia-drill-e2e');
const SAMPLE_RATE = 16_000;
const CHUNK_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failures.push(name);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function speak(text: string, name: string): Promise<Buffer> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, `${name}.aiff`);
  const pcm = join(TMP, `${name}.pcm`);
  await exec('say', ['-v', 'Daniel', '-r', '165', '-o', aiff, text]);
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', pcm]);
  const buf = await readFile(pcm);
  await rm(aiff, { force: true });
  await rm(pcm, { force: true });
  return buf;
}

async function streamPcm(ws: WebSocket, pcm: Buffer) {
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    ws.send(frame(C2S.AudioChunk, { data: pcm.subarray(off, off + CHUNK_BYTES).toString('base64') }));
    await sleep(CHUNK_MS);
  }
  // Past the server's silence window, or the turn never commits.
  const silence = Buffer.alloc(CHUNK_BYTES).toString('base64');
  for (let i = 0; i < 40; i++) {
    ws.send(frame(C2S.AudioChunk, { data: silence }));
    await sleep(CHUNK_MS);
  }
}

type Round = { ready: SessionReadyPayload | null; ended: boolean; error: string | null };

/**
 * One live round: start, let the interviewer speak, answer each clip after it
 * goes quiet, stop. `answers` empty means stop as soon as the round is ready.
 */
async function runRound(cookie: string, start: unknown, answers: Buffer[], minMs = 0): Promise<Round> {
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  const out: Round = { ready: null, ended: false, error: null };
  let aiBytes = 0;
  let userFinals = 0;
  ws.on('message', (raw) => {
    const m = parseServer(raw);
    if (!m) return;
    if (m.event === S2C.SessionReady) out.ready = m.data;
    if (m.event === S2C.AudioDelta) aiBytes += Buffer.from(m.data.data, 'base64').length;
    if (m.event === S2C.TranscriptDelta && m.data.final && m.data.speaker === 'user') userFinals++;
    if (m.event === S2C.SessionEnded) out.ended = true;
    if (m.event === S2C.Error && m.data.fatal) out.error = m.data.message;
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.send(frame(C2S.StartSession, start));

  const waitFor = async (pred: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (!pred() && !out.error && Date.now() - t0 < ms) await sleep(100);
    return pred();
  };
  const quiet = async () => {
    let last = aiBytes;
    let since = Date.now();
    const t0 = Date.now();
    while (Date.now() - since < 2500 && Date.now() - t0 < 60_000) {
      await sleep(250);
      if (aiBytes !== last) { last = aiBytes; since = Date.now(); }
    }
  };

  let readyAt = Date.now();
  if (await waitFor(() => !!out.ready, 30_000)) {
    readyAt = Date.now();
    if (answers.length) {
      await waitFor(() => aiBytes > 20_000, 40_000);
      for (const a of answers) {
        await quiet();
        const before = aiBytes;
        const finals = userFinals;
        await streamPcm(ws, a);
        await waitFor(() => userFinals > finals && aiBytes > before + 10_000, 40_000);
      }
    }
    // Held open on mic silence, as a browser would, so the round is long enough
    // to count as a handout (`HANDOUT_MIN_MS`) — otherwise nothing the rotation
    // does with it is being tested at all.
    const silence = Buffer.alloc(CHUNK_BYTES).toString('base64');
    while (Date.now() - readyAt < minMs && !out.error) {
      ws.send(frame(C2S.AudioChunk, { data: silence }));
      await sleep(CHUNK_MS);
    }
    ws.send(frame(C2S.AudioStreamEnd));
    ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));
    await waitFor(() => out.ended, 25_000);
  }
  ws.close();
  return out;
}

async function waitForReport(cookie: string, sessionId: string): Promise<EvaluationView | null> {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const r = await fetch(`${API}/api/sessions/${sessionId}/evaluation`, { headers: { cookie } })
      .then((x) => x.json() as Promise<EvaluationView | NoEvaluation>)
      .catch(() => null);
    if (r && (r.status === 'complete' || r.status === 'failed')) return r as EvaluationView;
    if (r && r.status === 'none' && !(r as NoEvaluation).pending) return null;
    await sleep(5000);
  }
  return null;
}

async function register(tag: string) {
  const email = `${tag}+${process.pid}${Date.now() % 10000}@orvia.local`;
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Drill E2E', email, password: 'e2e-password-123' }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const json = async <T>(cookie: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), cookie },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
};

async function main() {
  console.log('\n\x1b[1mOrvia — moments, drills, commitments and loops, end to end\x1b[0m\n');
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set.');
    process.exit(2);
  }
  await preflight(API);
  const sql = postgres(DB_URL, { max: 1 });

  try {
    /* 1. a fix to carry ---------------------------------------------------- */
    console.log('\x1b[1m1. committing to a fix\x1b[0m');
    const cookie = await register('drill');
    check('account created', cookie.startsWith('orvia_session='));
    const FIX = 'Say the time and space complexity out loud before finishing';
    const made = await json<CommitmentView>(cookie, '/api/commitments', { method: 'POST', body: JSON.stringify({ text: FIX }) });
    check('a commitment is saved', made.status === 201 || made.status === 200, `${made.status}`);

    const bank = (await (await fetch(`${API}/api/questions/dsa?collection=neetcode150`)).json()) as { id: string; title: string }[];
    const problem = bank.find((q) => q.id === 'two-sum') ?? bank[0]!;

    /* 2. a real round carries it ------------------------------------------ */
    console.log('\n\x1b[1m2. a round that carries it\x1b[0m');
    const weak1 = await speak(
      "Um, okay. So I think, maybe, I would just loop over the array twice? Like, for every number, " +
        "I check every other number, and if they add up I return them. I'm not totally sure that's right.",
      'weak1',
    );
    const weak2 = await speak(
      "Uh, I guess it's fine? I haven't really thought about how fast it is. It should work though, I think.",
      'weak2',
    );
    const round = await runRound(cookie, {
      config: { mode: 'dsa', questionIds: [problem.id], codeEditor: false },
      options: { durationMinutes: 5 },
    }, [weak1, weak2], HANDOUT_MIN_MS + 5000);
    check('the round starts and ends', !!round.ready && round.ended, round.error ?? '');
    const roundId = round.ready?.sessionId ?? '';
    check('SessionReady shows the commitment the round carries',
      round.ready?.focus?.length === 1 && round.ready.focus[0]!.key === made.body.id && round.ready.focus[0]!.text === FIX);

    const [row] = await sql`select kind, focus, drill, system_instruction from sessions where id = ${roundId}`;
    check('stored as a round, with the focus snapshotted', row?.kind === 'round' &&
      Array.isArray(row?.focus) && row.focus[0]?.key === made.body.id && row?.drill === null);
    check('the interviewer is never told the commitment', !String(row?.system_instruction).includes(FIX));

    /* 3. the report judges it and offers moments --------------------------- */
    console.log('\n\x1b[1m3. the report\x1b[0m');
    const report = await waitForReport(cookie, roundId);
    check('the round is evaluated', report?.status === 'complete', report?.error ?? report?.status ?? 'no report');
    const judged = report?.focus?.find((f) => f.key === made.body.id);
    check('the report carries the commitment', !!judged, JSON.stringify(report?.focus ?? []));
    check('...and the evaluator judged it', !!judged?.result, `${judged?.result}: ${judged?.note ?? ''}`);
    check('...quoting the candidate when it says applied or partly, and never for no chance',
      judged?.result === 'no_chance'
        ? judged.evidenceQuote === null
        : judged?.result === 'not_applied' || !!judged?.evidenceQuote,
      `${judged?.result}, quote ${judged?.evidenceQuote ? 'given' : 'none'}`);
    const checks = await sql`select key, result from focus_checks fc join evaluations e on e.id = fc.evaluation_id where e.session_id = ${roundId}`;
    check('one focus_checks row per carried item', checks.length === 1 && checks[0]!.key === made.body.id, `${checks.length} rows`);

    const commitments = await json<CommitmentView[]>(cookie, '/api/commitments');
    const mine = commitments.body.find((c) => c.id === made.body.id);
    check('the commitment\'s history has this round in it',
      mine?.history.length === 1 && mine.history[0]!.sessionId === roundId, JSON.stringify(mine?.progress));

    const moments = await json<MomentsView>(cookie, `/api/sessions/${roundId}/moments`);
    const drillable = moments.body.moments?.filter((m) => !m.unavailable) ?? [];
    check('the report offers moments to retry', moments.status === 200 && drillable.length > 0,
      `${moments.body.moments?.length ?? 0} moments, ${drillable.length} drillable${moments.body.reason ? ` — ${moments.body.reason}` : ''}`);
    const moment = drillable.find((m) => m.kind === 'question') ?? drillable[0];
    if (!moment) report_();

    const other = await register('drill-other');
    const peek = await json(other, `/api/sessions/${roundId}/moments`);
    const steal = await json(other, `/api/sessions/${roundId}/moments/${encodeURIComponent(moment.id)}/drill`);
    check('another account cannot see this round\'s moments, or drill them', peek.status === 404 && steal.status === 404,
      `${peek.status}, ${steal.status}`);

    /* 4. the drill plan ---------------------------------------------------- */
    console.log('\n\x1b[1m4. a drill of one moment\x1b[0m');
    const plan = await json<{ input: { config: { questionIds?: string[] }; options: { durationMinutes: number }; drill?: { momentId: string } }; focus: { text: string }[] }>(
      cookie, `/api/sessions/${roundId}/moments/${encodeURIComponent(moment.id)}/drill?minutes=5`);
    check('the drill plan narrows to the one problem, at the chosen length',
      plan.status === 200 && JSON.stringify(plan.body.input.config.questionIds) === JSON.stringify([problem.id]) &&
        plan.body.input.options.durationMinutes === 5 && plan.body.input.drill?.momentId === moment.id,
      JSON.stringify(plan.body.input?.config));
    check('...and carries the moment\'s weaknesses as its focus',
      JSON.stringify(plan.body.focus.map((f) => f.text)) === JSON.stringify(moment.focus));

    const good = await speak(
      'My approach is a single pass with a hash map from value to index. For each number I check whether ' +
        'target minus that number is already in the map, and return both indices if it is. That is order n time ' +
        'and order n space, because each element is visited once and the map holds at most n entries.',
      'good1',
    );
    // Tampered: a different problem and ninety minutes. The drill it names must win.
    const drillRound = await runRound(cookie, {
      config: { mode: 'dsa', questionIds: [bank.find((q) => q.id !== problem.id)!.id], codeEditor: false },
      options: { durationMinutes: 90 },
      drill: { sessionId: roundId, momentId: moment.id },
    }, [good], HANDOUT_MIN_MS + 5000);
    const drillId = drillRound.ready?.sessionId ?? '';
    check('the drill runs', !!drillRound.ready && drillRound.ended, drillRound.error ?? '');
    // Ninety is not a drill length, so the server falls back to the mode's
    // default rather than honouring it: a client cannot turn a drill into a round.
    check('it runs the drill the SERVER rebuilt, not the setup the client sent',
      drillRound.ready?.durationMinutes === DRILL_MINUTES.dsa && drillRound.ready.questions?.[0]?.id === problem.id,
      `${drillRound.ready?.durationMinutes} min, ${drillRound.ready?.questions?.map((q) => q.id).join(',')}`);
    check('SessionReady carries the drill and its focus, not the commitment',
      !!drillRound.ready?.drill && drillRound.ready.focus?.every((f) => f.source === 'drill') === true &&
        drillRound.ready.drill.beforeScore === moment.before.score);

    const [drow] = await sql`select kind, drill, focus, system_instruction from sessions where id = ${drillId}`;
    check('stored as a drill of that moment', drow?.kind === 'drill' && drow?.drill?.momentId === moment.id &&
      drow?.drill?.sourceSessionId === roundId);
    const instruction = String(drow?.system_instruction);
    check('the interviewer is given the question to put', instruction.includes('focused round on ONE question'));
    check('...and NONE of the weaknesses it is being retried for',
      moment.focus.every((f) => !instruction.includes(f)) && !instruction.includes(moment.advice));

    /* 5. before and after -------------------------------------------------- */
    console.log('\n\x1b[1m5. the drill\'s report\x1b[0m');
    const drillReport = await waitForReport(cookie, drillId);
    check('the drill is evaluated', drillReport?.status === 'complete', drillReport?.error ?? drillReport?.status ?? 'no report');
    check('its report compares against the moment it retried',
      drillReport?.drill?.momentId === moment.id && drillReport.drill.before.score === moment.before.score,
      `before ${drillReport?.drill?.before.score} → after ${drillReport?.drill?.after.score}`);
    check('...with an "after" on the same scale', drillReport?.drill?.after.outOf === moment.before.outOf);
    check('every weakness is judged', (drillReport?.focus ?? []).length === moment.focus.length &&
      drillReport!.focus.every((f) => f.source === 'drill'),
      (drillReport?.focus ?? []).map((f) => f.result).join(', '));
    check('the attempt is listed against the moment',
      drillReport?.drill?.attempts.length === 1 && drillReport.drill.attempts[0]!.sessionId === drillId);
    const again = await json<MomentsView>(cookie, `/api/sessions/${roundId}/moments`);
    check('...and on the original round\'s report',
      again.body.moments.find((m) => m.id === moment.id)?.attempts.length === 1);

    /* 6. a drill is not a round -------------------------------------------- */
    console.log('\n\x1b[1m6. drills stay out of every score\x1b[0m');
    const progress = await json<{ sessions: { sessionId: string }[] }>(cookie, '/api/progress');
    check('the progress trend has the round and not the drill',
      progress.body.sessions.some((s) => s.sessionId === roundId) && !progress.body.sessions.some((s) => s.sessionId === drillId));
    const attempted = await json<{ id: string; count: number }[]>(cookie, '/api/questions/attempted?mode=dsa');
    const lengths = await sql`select kind, duration_ms from sessions where id in (${roundId}, ${drillId})`;
    check('both the round and the drill ran past the handout floor, so the next check means something',
      lengths.length === 2 && lengths.every((l) => Number(l.duration_ms) >= HANDOUT_MIN_MS),
      lengths.map((l) => `${l.kind} ${l.duration_ms}ms`).join(', '));
    check('the rotation counts the problem once — the drill did not hand it out again',
      attempted.body.find((a) => a.id === problem.id)?.count === 1, JSON.stringify(attempted.body));
    const history = await json<{ id: string; kind: string; drill: { label: string } | null }[]>(cookie, '/api/sessions');
    check('history lists the drill, labelled as one',
      history.body.find((h) => h.id === drillId)?.kind === 'drill' && !!history.body.find((h) => h.id === drillId)?.drill?.label);
    const replay = await json<{ input: { drill?: { sessionId: string; momentId: string } } }>(cookie, `/api/sessions/${drillId}/replay`);
    check('running a drill again retries the same moment', replay.body.input.drill?.sessionId === roundId &&
      replay.body.input.drill.momentId === moment.id);
    const nested = await json<MomentsView>(cookie, `/api/sessions/${drillId}/moments`);
    const nestedPlan = await json(cookie, `/api/sessions/${drillId}/moments/q:anything/drill`);
    check('a drill offers no moments of its own, and cannot be drilled',
      nested.body.offersMoments === false && nestedPlan.status === 400, `${nestedPlan.status}`);
    const planSummary = await json<PlanSummary>(cookie, '/api/plan');
    check('the plan sees both, told apart',
      planSummary.body.rounds.find((r) => r.sessionId === drillId)?.kind === 'drill' &&
        planSummary.body.rounds.find((r) => r.sessionId === roundId)?.kind === 'round');
    check('...with the commitment\'s verdict among its checks', planSummary.body.checks.length >= 1);

    /* 7. an onsite loop ---------------------------------------------------- */
    console.log('\n\x1b[1m7. an onsite loop\x1b[0m');
    const loop = await json<LoopView>(cookie, '/api/loops', { method: 'POST', body: JSON.stringify({ template: 'final' }) });
    check('a loop starts on its first stage', loop.status === 201 && loop.body.next === 0 && loop.body.decision === 'pending');
    const wrong = await runRound(cookie, {
      config: { mode: 'dsa', questionIds: [problem.id], codeEditor: false }, options: { durationMinutes: 5 }, loopId: loop.body.id,
    }, []);
    check('a round in the wrong mode for the stage is refused before it starts',
      !wrong.ready && /next round of this loop is Behavioural/.test(wrong.error ?? ''), wrong.error ?? '');
    const behavioural = (await (await fetch(`${API}/api/questions/behavioural`)).json()) as { id: string }[];
    const staged = await runRound(cookie, {
      config: { mode: 'behavioural', questionIds: [behavioural[0]!.id] }, options: { durationMinutes: 5 }, loopId: loop.body.id,
    }, []);
    check('the right mode is staged as round one of two',
      staged.ready?.loop?.id === loop.body.id && staged.ready.loop.stage === 0 && staged.ready.loop.of === 2);
    const [srow] = await sql`select loop_id, loop_stage from sessions where id = ${staged.ready?.sessionId ?? '00000000-0000-0000-0000-000000000000'}`;
    check('...and recorded on the session', srow?.loop_id === loop.body.id && srow?.loop_stage === 0);
    const after = await json<LoopView>(cookie, `/api/loops/${loop.body.id}`);
    check('a stage round that ended inside a minute leaves the stage to run again', after.body.next === 0);
    const theirs = await json(other, `/api/loops/${loop.body.id}`);
    check('another account cannot read the loop', theirs.status === 404, `${theirs.status}`);
  } finally {
    await sql.end();
    await rm(TMP, { recursive: true, force: true });
  }
  report_();
}

function report_(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (!failures.length) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m — a moment retried, a fix carried, a loop staged.\n`);
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
