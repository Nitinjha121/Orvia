/**
 * End-to-end suite for multi-stage onsite loops and non-DSA drills,
 * covering behavioural and HR rounds, loop decision aggregation, commitment tracking,
 * and delivery moment scoring.
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
import {
  commitmentProgress, type CommitmentView, type Moment, type MomentsView,
} from '../../packages/shared/src/drills.js';
import { loopDecision, type LoopView } from '../../packages/shared/src/plan.js';

const exec = promisify(execFile);
const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test');
const TMP = join(tmpdir(), 'orvia-loop-e2e');
const SAMPLE_RATE = 16_000;
const CHUNK_MS = 80;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
const HOLD = HANDOUT_MIN_MS + 5000;

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
  const silence = Buffer.alloc(CHUNK_BYTES).toString('base64');
  for (let i = 0; i < 40; i++) {
    ws.send(frame(C2S.AudioChunk, { data: silence }));
    await sleep(CHUNK_MS);
  }
}

type Round = { ready: SessionReadyPayload | null; ended: boolean; error: string | null };

/** Start, answer each clip once the interviewer goes quiet, hold past `minMs`, stop. */
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
    await waitFor(() => aiBytes > 20_000, 40_000);
    for (const a of answers) {
      await quiet();
      const before = aiBytes;
      const finals = userFinals;
      await streamPcm(ws, a);
      await waitFor(() => userFinals > finals && aiBytes > before + 10_000, 40_000);
    }
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

const json = async <T>(cookie: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), cookie },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
};

/** Drill one moment through the gateway, as the report's button does. */
async function drill(cookie: string, sql: postgres.Sql, sourceId: string, m: Moment, answer: Buffer, label: string) {
  const plan = await json<{ input: unknown; focus: { text: string }[] }>(
    cookie, `/api/sessions/${sourceId}/moments/${encodeURIComponent(m.id)}/drill?minutes=5`);
  check(`${label}: the drill plan resolves`, plan.status === 200, `${plan.status}`);
  // Held past a minute, as a person would wait: a stalled reply gets the
  // watchdog's ladder to recover it instead of the suite hanging up at 40s.
  const round = await runRound(cookie, plan.body.input, [answer], HOLD);
  const id = round.ready?.sessionId ?? '';
  check(`${label}: the drill runs`, !!round.ready && round.ended, round.error ?? '');
  const [row] = await sql`select kind, drill, system_instruction, options from sessions where id = ${id || '00000000-0000-0000-0000-000000000000'}`;
  const instruction = String(row?.system_instruction ?? '');
  check(`${label}: stored as a drill of that moment`, row?.kind === 'drill' && row?.drill?.momentId === m.id);
  check(`${label}: the interviewer gets the question and none of the weaknesses`,
    instruction.includes('focused round on ONE question') && m.focus.every((f) => !instruction.includes(f)) &&
      !instruction.includes(m.advice));
  const report = await waitForReport(cookie, id);
  check(`${label}: the drill is evaluated`, report?.status === 'complete', report?.error ?? report?.status ?? 'no report');
  check(`${label}: before and after on the moment's own scale`,
    report?.drill?.momentId === m.id && report.drill.after.outOf === m.before.outOf && report.drill.after.score !== null,
    `before ${m.before.score}/${m.before.outOf} → after ${report?.drill?.after.score}/${report?.drill?.after.outOf}`);
  check(`${label}: every weakness is judged`,
    (report?.focus ?? []).length === m.focus.length && report!.focus.every((f) => f.source === 'drill'),
    (report?.focus ?? []).map((f) => f.result ?? 'unjudged').join(', '));
  return { id, row, report };
}

async function main() {
  console.log('\n\x1b[1mOrvia — an onsite loop to its decision, and drills outside DSA\x1b[0m\n');
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set.');
    process.exit(2);
  }
  await preflight(API);
  const sql = postgres(DB_URL, { max: 1 });

  try {
    /* 1. an account, a commitment that is easy to show, a loop ------------- */
    console.log('\x1b[1m1. setup\x1b[0m');
    const email = `loop+${process.pid}${Date.now() % 10000}@orvia.local`;
    const reg = await fetch(`${API}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Loop E2E', email, password: 'e2e-password-123' }),
    });
    const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    check('account created', cookie.startsWith('orvia_session='));
    // Phrased so it applies to ANY round, and so saying it is unmistakable.
    const FIX = 'Open every answer with the words "In short", then give the headline in one sentence';
    const made = await json<CommitmentView>(cookie, '/api/commitments', { method: 'POST', body: JSON.stringify({ text: FIX }) });
    check('a commitment is saved', made.status === 201, `${made.status}`);
    const loop = await json<LoopView>(cookie, '/api/loops', { method: 'POST', body: JSON.stringify({ template: 'final' }) });
    check('a final-round loop starts: behavioural, then HR',
      loop.status === 201 && loop.body.stages.map((s) => s.mode).join(',') === 'behavioural,hr');

    const behavioural = (await (await fetch(`${API}/api/questions/behavioural`)).json()) as { id: string; title: string }[];
    const scenarios = (await (await fetch(`${API}/api/questions/hr-scenarios`)).json()) as { id: string }[];

    /* 2. stage one: an Amazon-style behavioural round ---------------------- */
    console.log('\n\x1b[1m2. stage one — behavioural, Amazon style\x1b[0m');
    const vague1 = await speak(
      'In short, we had a disagreement on the team about a deadline. We talked about it for a while, and ' +
        'in the end we sort of worked it out and it was fine. Everyone was happy with it I think.',
      'vague1',
    );
    const vague2 = await speak(
      'In short, I guess it went well. We shipped it eventually. I do not really remember the numbers.',
      'vague2',
    );
    const one = await runRound(cookie, {
      config: { mode: 'behavioural', questionIds: [behavioural[0]!.id], experience: '' },
      options: { durationMinutes: 5, style: 'amazon' },
      loopId: loop.body.id,
    }, [vague1, vague2], HOLD);
    const oneId = one.ready?.sessionId ?? '';
    check('stage one runs as loop round one of two', !!one.ready && one.ended &&
      one.ready.loop?.stage === 0 && one.ready.loop.of === 2, one.error ?? '');
    check('it carries the commitment', one.ready?.focus?.[0]?.key === made.body.id);
    const [r1] = await sql`select options, system_instruction, loop_stage, duration_ms from sessions where id = ${oneId || '00000000-0000-0000-0000-000000000000'}`;
    check('the Amazon style is stored with the round', r1?.options?.style === 'amazon');
    check('...and the interviewer is told to probe the leadership principles',
      String(r1?.system_instruction).includes('Leadership Principles'));
    check('...and is never told the commitment', !String(r1?.system_instruction).includes(FIX));
    check('the round ran past the handout floor, so it fills its stage', Number(r1?.duration_ms) >= HANDOUT_MIN_MS,
      `${r1?.duration_ms}ms`);

    const rep1 = await waitForReport(cookie, oneId);
    check('stage one is evaluated', rep1?.status === 'complete', rep1?.error ?? rep1?.status ?? 'no report');
    check('the report names the style it ran in', rep1?.session?.style === 'amazon');
    const c1 = rep1?.focus.find((f) => f.key === made.body.id);
    check('the commitment is judged in stage one', !!c1?.result, `${c1?.result}: ${c1?.note ?? ''}`);
    const mid = await json<LoopView>(cookie, `/api/loops/${loop.body.id}`);
    check('the loop moves on to its second stage', mid.body.next === 1 && mid.body.decision === 'pending');

    /* 3. stage two: HR ----------------------------------------------------- */
    console.log('\n\x1b[1m3. stage two — HR\x1b[0m');
    const hr1 = await speak(
      'In short, I am looking for more ownership. In my current role I lead the billing service, and I want to ' +
        'take on a wider scope, which this team offers.',
      'hr1',
    );
    const hr2 = await speak(
      'In short, I would like to understand the band for the role before I name a number. Could you share the range?',
      'hr2',
    );
    const two = await runRound(cookie, {
      config: { mode: 'hr', scenarioId: scenarios[0]!.id },
      options: { durationMinutes: 5 },
      loopId: loop.body.id,
    }, [hr1, hr2], HOLD);
    const twoId = two.ready?.sessionId ?? '';
    check('stage two runs as loop round two of two', !!two.ready && two.ended && two.ready.loop?.stage === 1, two.error ?? '');
    const rep2 = await waitForReport(cookie, twoId);
    check('stage two is evaluated', rep2?.status === 'complete', rep2?.error ?? rep2?.status ?? 'no report');
    const c2 = rep2?.focus.find((f) => f.key === made.body.id);
    check('the commitment is judged in stage two', !!c2?.result, `${c2?.result}: ${c2?.note ?? ''}`);

    /* 4. the loop's decision and the commitment's close -------------------- */
    console.log('\n\x1b[1m4. the decision, and the commitment\x1b[0m');
    const done = await json<LoopView>(cookie, `/api/loops/${loop.body.id}`);
    const verdicts = done.body.stages.map((s) => s.round?.verdict ?? null);
    check('every stage is filled', done.body.next === null && done.body.stages.every((s) => !!s.round));
    check('the loop is decided', done.body.decision !== 'pending' && done.body.reasons.length > 0,
      `${done.body.decision} — ${done.body.reasons.join(' ')} (${verdicts.join(', ')})`);
    check('...by the fixed rule, from the two reports', done.body.decision === loopDecision(verdicts).decision);

    const commitments = await json<CommitmentView[]>(cookie, '/api/commitments');
    const mine = commitments.body.find((c) => c.id === made.body.id)!;
    check('the commitment\'s history has both rounds, in order',
      mine.history.map((h) => h.sessionId).join(',') === `${oneId},${twoId}`,
      mine.history.map((h) => h.result).join(', '));
    check('its status is the one the rule derives', mine.status === commitmentProgress(mine.history.map((h) => h.result)).status);
    check('applied in both rounds, it is CLOSED', mine.status === 'closed',
      `${mine.history.map((h) => h.result).join(', ')} → ${mine.status}`);
    const probe = await runRound(cookie, {
      config: { mode: 'behavioural', questionIds: [behavioural[1]!.id], experience: '' }, options: { durationMinutes: 5 },
    }, []);
    check('a closed commitment is no longer carried into new rounds',
      mine.status !== 'closed' || !(probe.ready?.focus ?? []).some((f) => f.key === made.body.id),
      `${probe.ready?.focus?.length ?? 0} carried`);

    /* 5. drills outside DSA ------------------------------------------------ */
    console.log('\n\x1b[1m5. a behavioural drill — the bank-narrowed path\x1b[0m');
    const m1 = await json<MomentsView>(cookie, `/api/sessions/${oneId}/moments`);
    const bq = m1.body.moments.find((m) => m.kind === 'question' && !m.unavailable);
    const bd = m1.body.moments.find((m) => m.kind === 'delivery' && !m.unavailable);
    check('the vague behavioural answer yields a question moment', !!bq, `${m1.body.moments.length} moments`);
    check('...and a delivery moment', !!bd, m1.body.moments.filter((m) => m.kind === 'delivery').map((m) => m.label).join(', '));
    const star = await speak(
      'In short, I resolved a conflict over a release date by splitting the scope. Our designer wanted to delay two ' +
        'weeks for polish; I owned the release. I proposed shipping the core flow on time behind a flag and the polish ' +
        'a week later. I measured it: the core shipped on the date, error rates stayed under half a percent, and ' +
        'conversion rose four percent. What I would do differently is agree the scope split at kickoff, not in the last week.',
      'star',
    );
    if (bq) {
      const plan = await json<{ input: { config: { questionIds?: string[] }; options: { style?: string } } }>(
        cookie, `/api/sessions/${oneId}/moments/${encodeURIComponent(bq.id)}/drill?minutes=5`);
      check('the behavioural drill narrows to the round\'s one question, and keeps the Amazon style',
        JSON.stringify(plan.body.input.config.questionIds) === JSON.stringify([behavioural[0]!.id]) &&
          plan.body.input.options.style === 'amazon', JSON.stringify(plan.body.input.config.questionIds));
      await drill(cookie, sql, oneId, bq, star, 'behavioural');
    }

    console.log('\n\x1b[1m6. a delivery-moment drill\x1b[0m');
    if (bd) {
      const d = await drill(cookie, sql, oneId, bd, star, 'delivery');
      check('delivery: the "after" is that dimension\'s own score out of five',
        d.report?.drill?.kind === 'delivery' && d.report.drill.dimension === bd.dimension &&
          d.report.drill.after.score === d.report.delivery.find((x) => x.dimension === bd.dimension)?.score);
    }

    console.log('\n\x1b[1m7. an HR drill — the question-override path\x1b[0m');
    const m2 = await json<MomentsView>(cookie, `/api/sessions/${twoId}/moments`);
    const hq = m2.body.moments.find((m) => !m.unavailable);
    check('the HR round offers a moment', !!hq, m2.body.reason ?? `${m2.body.moments.length} moments`);
    if (hq) {
      const hrGood = await speak(
        'In short, based on my research and my current package, I am targeting thirty two lakhs fixed. ' +
          'I am flexible on the split if the equity is meaningful, and my notice period is sixty days, negotiable.',
        'hrgood',
      );
      const h = await drill(cookie, sql, twoId, hq, hrGood, 'hr');
      check('hr: the whole scenario is kept, with only the one question put',
        String(h.row?.system_instruction).includes('ONLY this one question') && h.row?.drill?.question === hq.question);
    }

    /* 8. none of it moved the trend ---------------------------------------- */
    const progress = await json<{ sessions: { sessionId: string }[] }>(cookie, '/api/progress');
    const drills = await sql`select s.id from sessions s join users u on u.id = s.user_id where u.email = ${email} and s.kind = 'drill'`;
    check('the trend has both loop rounds and none of the drills',
      [oneId, twoId].every((id) => progress.body.sessions.some((s) => s.sessionId === id)) &&
        drills.every((d) => !progress.body.sessions.some((s) => s.sessionId === d.id)),
      `${drills.length} drills`);
  } finally {
    await sql.end();
    await rm(TMP, { recursive: true, force: true });
  }
  report();
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (!failures.length) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m — a loop decided, a fix closed, three drills outside DSA.\n`);
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
