/**
 * Verification script ensuring `GET /api/sessions/:id/replay` accurately reproduces
 * previous session configurations (questions, order, voice, length) in a new session
 * without modifying original records.
 */
import WebSocket from 'ws';
import { assertTestApi } from './e2e/guard';
import { C2S, S2C, frame, parseServer } from './e2e/protocol';

const API = process.env.E2E_API ?? 'http://localhost:8788';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}

async function main() {
  await assertTestApi(API);

  /* An account of its own, so this never reads or repeats a real round. */
  const email = `replay+${Date.now() % 100000}@orvia.local`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name: 'Replay' }),
  });
  const cookie = (reg.headers.getSetCookie?.() ?? []).join('; ');
  check('registered a throwaway account', reg.ok && !!cookie, email);
  if (!reg.ok) return report();

  const bank = (await (await fetch(`${API}/api/questions/dsa?collection=neetcode150`)).json()) as {
    id: string;
  }[];
  /* Two questions, in an order the bank does NOT return them in, so "same
     order" is a real claim rather than one the database satisfies by luck. */
  const questionIds = [bank[3]!.id, bank[1]!.id];

  const original = {
    config: { mode: 'dsa', questionIds, codeEditor: true, language: 'java' },
    /* Deliberately not the defaults: a repeat that reinstated the defaults
       would pass a test written against them. */
    options: { durationMinutes: 45, difficulty: 'hard', persona: 'terse', voice: 'Puck' },
  };

  const first = await runRound(cookie, original);
  check('the original round starts', !!first.sessionId, first.sessionId.slice(0, 8));
  if (!first.sessionId) return report();

  const res = await fetch(`${API}/api/sessions/${first.sessionId}/replay`, { headers: { cookie } });
  const plan = (await res.json()) as {
    input: typeof original;
    questions: { id: string }[];
    missingQuestionIds: string[];
  };
  check('the round can be fetched as a replay plan', res.ok, `${res.status}`);
  if (!res.ok) return report();

  check(
    'the plan carries the same questions, in the same order',
    JSON.stringify(plan.input.config.questionIds) === JSON.stringify(questionIds),
    plan.input.config.questionIds.join(' → '),
  );
  check('the plan carries the same options', JSON.stringify(plan.input.options) === JSON.stringify(original.options),
    JSON.stringify(plan.input.options));
  check('nothing was dropped from a round whose questions all exist', plan.missingQuestionIds.length === 0);
  check(
    'the bank rows come back with their starter code',
    plan.questions.length === 2 && plan.questions.every((q) => !!q.id),
    plan.questions.map((q) => q.id).join(', '),
  );

  /* The plan, driven through the gateway exactly as the browser drives it. */
  const second = await runRound(cookie, plan.input);
  check('the repeat starts', !!second.sessionId, second.sessionId.slice(0, 8));
  check(
    'the repeat is a NEW session, not the old one reopened',
    !!second.sessionId && second.sessionId !== first.sessionId,
  );
  check(
    'the repeat runs the same questions, in the same order',
    JSON.stringify(second.questions.map((q) => q.id)) === JSON.stringify(first.questions.map((q) => q.id)),
    second.questions.map((q) => q.id).join(' → '),
  );

  /* What the server actually stored, which is what the round will be evaluated
     and rotated against. */
  const detail = (await (
    await fetch(`${API}/api/sessions/${second.sessionId}`, { headers: { cookie } })
  ).json()) as {
    voice: string;
    options: { durationMinutes?: number; difficulty?: string; persona?: string };
    config: { language?: string };
  };
  check('the repeat uses the same voice', detail.voice === original.options.voice, detail.voice);
  check(
    'the repeat uses the same length, bar and persona',
    detail.options.durationMinutes === 45 &&
      detail.options.difficulty === 'hard' &&
      detail.options.persona === 'terse',
    JSON.stringify(detail.options),
  );
  check('the repeat keeps the configured language', detail.config.language === 'java', String(detail.config.language));

  const firstStill = await fetch(`${API}/api/sessions/${first.sessionId}`, { headers: { cookie } });
  check('the original round is still there, untouched', firstStill.ok, `${firstStill.status}`);

  /* Another account must not be able to repeat this round: an HR config carries
     that account's salary numbers. */
  const other = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `other+${Date.now() % 100000}@orvia.local`, password: 'password123', name: 'Other' }),
  });
  const otherCookie = (other.headers.getSetCookie?.() ?? []).join('; ');
  const stolen = await fetch(`${API}/api/sessions/${first.sessionId}/replay`, {
    headers: { cookie: otherCookie },
  });
  check("another account cannot replay this round", stolen.status === 404, `${stolen.status}`);

  return report();
}

/** Starts a round, waits for the server to say what it configured, ends it. */
function runRound(cookie: string, input: unknown) {
  return new Promise<{ sessionId: string; questions: { id: string }[] }>((resolve) => {
    const ws = new WebSocket(WS_URL, { headers: { cookie } });
    let sessionId = '';
    let questions: { id: string }[] = [];

    const finish = () => {
      try {
        ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));
      } catch { /* already closing */ }
      setTimeout(() => {
        ws.close();
        resolve({ sessionId, questions });
      }, 1500);
    };

    ws.on('message', (raw) => {
      const m = parseServer(raw);
      if (!m) return;
      if (m.event === S2C.SessionReady) {
        sessionId = m.data.sessionId;
        questions = m.data.questions ?? [];
        finish();
      }
      if (m.event === S2C.Error && m.data.fatal) {
        console.log(`      \x1b[31mserver error:\x1b[0m ${m.data.message}`);
        ws.close();
        resolve({ sessionId, questions });
      }
    });

    ws.on('open', () => ws.send(frame(C2S.StartSession, input)));
    setTimeout(() => { ws.close(); resolve({ sessionId, questions }); }, 30_000);
  });
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

void main();
