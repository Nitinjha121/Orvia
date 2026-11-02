/**
 * End-to-end conversation suite connecting a candidate model to the interview API,
 * testing multi-turn back-and-forth interactions across DSA, behavioural, and HR modes,
 * including stall handling and transcript streaming.
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import postgres from 'postgres';
import { assertTestDatabase } from './guard';
import { preflight } from './preflight';
import { C2S, S2C, frame, parseServer } from './protocol';

const API = process.env.E2E_API ?? 'http://localhost:8787';
const WS_URL = API.replace(/^http/, 'ws') + '/ws/interview';
const DB_URL = assertTestDatabase(
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test',
);

const IN_RATE = 16_000;   // what the API expects from a microphone
const OUT_RATE = 24_000;  // what either model produces
const CHUNK_MS = 80;
const CHUNK_BYTES = (IN_RATE * 2 * CHUNK_MS) / 1000;

/**
 * Feeds interviewer audio to the candidate model in rate-limited frames (100ms audio per 30ms)
 * to avoid audio frames being dropped by the model when burst too quickly.
 */
const FEED_FRAME_BYTES = IN_RATE * 2 * 0.1;
const FEED_INTERVAL_MS = 30;

/** Interviewer turns to sit through before ending the round. */
const TARGET_TURNS = Number(process.env.TURNS ?? 6);
/** Hard ceiling, so a wedged round still reports rather than hanging. */
const MAX_ROUND_MS = Number(process.env.MAX_MS ?? 8 * 60_000);

const CANDIDATE_MODEL = 'gemini-3.1-flash-live-preview';

/** Which kind of round the two models hold. */
const MODE = (process.env.MODE ?? 'dsa') as 'dsa' | 'behavioural' | 'hr';
if (!['dsa', 'behavioural', 'hr'].includes(MODE)) {
  console.error(`\x1b[31mMODE must be dsa, behavioural or hr — got "${MODE}".\x1b[0m`);
  process.exit(2);
}

/**
 * Compensation figures stored in config for evaluation but excluded from interviewer
 * prompt facts, ensuring realistic salary negotiation during HR rounds.
 */
const HR_CURRENT = '24 lakhs fixed plus 4 variable';
const HR_EXPECTED = '38 lakhs total, 34 fixed floor';

/**
 * The candidate is told to behave like a real one — including the things that
 * make rounds hard for the interviewer. It must NOT be a model answering
 * perfectly on the first try, because that produces a three-turn round that
 * exercises nothing.
 */
const COMMON_BRIEF = `
You are speaking out loud; everything you say is heard, not read.
- Keep each reply to about fifteen seconds. Never monologue.
- Never break character, never mention that you are a language model, and never
  say you are testing anything.

If the interviewer says nothing for a while, do what a real candidate does: ask
whether you are audible, then carry on from where you were.
`.trim();

/**
 * One brief per mode. A candidate told to "give the time and space complexity"
 * in a salary negotiation is not a candidate, and the round it produces proves
 * nothing about the mode under test.
 */
const BRIEFS: Record<typeof MODE, string> = {
  dsa: `
You are a software engineering candidate in a live technical interview.

Behave like a real candidate:
- Restate the problem in your own words before solving it.
- Ask ONE clarifying question early (constraints, input size, edge cases).
- Think out loud. Say your approach before you commit to it.
- Give the time and space complexity when you have an approach.

${COMMON_BRIEF}`.trim(),

  behavioural: `
You are a software engineer in a behavioural interview, asked about how you have
worked in the past.

Behave like a real candidate:
- Answer with ONE specific story from your own experience, not a general policy.
  Name the situation, what you actually did, and how it turned out.
- Give a concrete detail — a number, a deadline, a name for the system.
- Admit what went wrong where it did. A story with no difficulty in it is a
  story the interviewer will push back on.
- If a question is vague, ask which kind of example they want before launching in.

${COMMON_BRIEF}`.trim(),

  /*
   * The candidate KNOWS its numbers; the interviewer must not. That asymmetry
   * is the round, so the brief hands the candidate the same figures the config
   * hides from the interviewer, and tells it to hold them the way the app is
   * meant to teach you to.
   */
  hr: `
You are a software engineer talking to a recruiter about compensation and your
reasons for moving. You currently earn ${HR_CURRENT} and you want
${HR_EXPECTED}, but you have NOT told them either figure.

Behave like a real candidate:
- Do not volunteer your current salary. If pushed for a number early, ask what
  range the role is budgeted at first, politely and without stonewalling.
- Give a number only once you have heard something about the range, and anchor
  on what you want rather than on what you currently earn.
- Be warm and co-operative. You want this job; you are negotiating, not fighting.
- Have a real reason for leaving that is about the work, not about money alone.

${COMMON_BRIEF}`.trim(),
};

const CANDIDATE_BRIEF = BRIEFS[MODE];

/* ── assertion harness ─────────────────────────────────────────────────────── */

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

/**
 * 24 kHz → 16 kHz, linear. Both models emit 24k and the API takes 16k, so every
 * byte crossing between them goes through here.
 *
 * Deliberately not a naive "drop every third sample": decimating without
 * interpolating adds audible aliasing, and the receiving end of this bridge is
 * an ASR model whose accuracy is the thing under test.
 */
function downsample24to16(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor((inSamples * IN_RATE) / OUT_RATE);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * OUT_RATE) / IN_RATE;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, inSamples - 1);
    const frac = pos - a;
    const s = pcm.readInt16LE(a * 2) * (1 - frac) + pcm.readInt16LE(b * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

/**
 * Streams a buffer into the API at real time.
 *
 * Pacing is not cosmetic: bursting makes the server's voice activity detection
 * see one impossible blob instead of speech, and the turn never closes.
 */
class MicPump {
  private queue: Buffer = Buffer.alloc(0);
  private running = false;
  /** Wall-clock ms of audio actually delivered, for the talk-ratio check. */
  spokenMs = 0;

  constructor(private readonly ws: WebSocket) {}

  push(pcm16k: Buffer) {
    this.queue = Buffer.concat([this.queue, pcm16k]);
    if (!this.running) void this.drain();
  }

  get pending() {
    return this.queue.length > 0;
  }

  private async drain() {
    this.running = true;
    while (this.queue.length > 0) {
      const chunk = this.queue.subarray(0, CHUNK_BYTES);
      this.queue = this.queue.subarray(chunk.length);
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          frame(C2S.AudioChunk, { data: chunk.toString('base64') }),
        );
        this.spokenMs += (chunk.length / 2 / IN_RATE) * 1000;
      }
      await sleep(CHUNK_MS);
    }
    this.running = false;
  }

  /**
   * Trailing silence so end-of-speech commits. MUST exceed the server's
   * `silenceDurationMs` (1400ms) or the interviewer waits forever for the
   * candidate to finish and the round deadlocks — which looks exactly like the
   * stall this suite is hunting, and would be our own fault.
   */
  async flushSilence(ms = 2_200) {
    const silence = Buffer.alloc(CHUNK_BYTES);
    for (let i = 0; i < Math.ceil(ms / CHUNK_MS); i++) {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(
        frame(C2S.AudioChunk, { data: silence.toString('base64') }),
      );
      await sleep(CHUNK_MS);
    }
  }
}

/* ── the test ──────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n\x1b[1mOrvia — a real two-way interview (model vs model)\x1b[0m\n');

  if (!process.env.GEMINI_API_KEY) {
    console.error('\x1b[31mGEMINI_API_KEY is not set.\x1b[0m');
    process.exit(2);
  }

  console.log('\x1b[1m0. preflight\x1b[0m');
  await preflight(API);

  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  check('API is up', health?.ok === true, API);

  /* The bank this mode draws from, and the round it produces. Only `dsa` has an
     editor, so only `dsa` types — see the typing interval in §2. */
  const BANK_URL: Record<typeof MODE, string> = {
    dsa: `${API}/api/questions/dsa?collection=neetcode150`,
    behavioural: `${API}/api/questions/behavioural`,
    hr: `${API}/api/questions/hr-scenarios`,
  };
  const questions = await fetch(BANK_URL[MODE]).then((r) => r.json());
  check(`${MODE} bank seeded`, Array.isArray(questions) && questions.length > 0,
    Array.isArray(questions) ? `${questions.length} rows` : 'not an array');
  if (!Array.isArray(questions) || !questions.length) return report();

  /**
   * `behavioural` deliberately takes TWO questions. One question is answered
   * and the round ends; two is the first case where the interviewer has to
   * decide it is done with the first and move on, which is the whole of what a
   * spoken round does that a single-question one does not.
   */
  const roundConfig: Record<string, unknown> =
    MODE === 'dsa'
      ? { mode: 'dsa', questionIds: [questions[0].id], codeEditor: true }
      : MODE === 'behavioural'
        ? {
            mode: 'behavioural',
            questionIds: questions.slice(0, 2).map((q: { id: string }) => q.id),
            experience:
              'Six years backend. Led the billing service split out of the monolith, ' +
              'cut p99 checkout latency from 1.4s to 380ms, and ran the dual-write migration ' +
              'that moved 40 million rows with no downtime.',
          }
        : {
            mode: 'hr',
            scenarioId: questions[0].id,
            targetRole: 'Senior backend engineer',
            currentCompensation: HR_CURRENT,
            expectedCompensation: HR_EXPECTED,
            noticePeriod: '60 days, negotiable to 30',
            reasonForLeaving: 'No path to senior for two years',
          };
  console.log(`  \x1b[2mmode: ${MODE} — ${JSON.stringify(roundConfig).slice(0, 120)}…\x1b[0m`);

  const email = `e2e+conv${process.pid}@orvia.local`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Conversation Runner', email, password: 'e2e-password-123' }),
  });
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('account created', reg.ok && cookie.startsWith('orvia_session='), email);

  /* 1. the candidate model ------------------------------------------------- */
  console.log('\n\x1b[1m1. opening the candidate model\x1b[0m');

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let candidateAudioOut = 0;
  let candidateSaid = '';
  let candidateTurns = 0;
  // Read by the callbacks passed to `connect` below, which are built before
  // the pump exists — so this cannot be a `const`.
  // eslint-disable-next-line prefer-const
  let pump: MicPump | undefined;

  const candidate: Session = await ai.live.connect({
    model: CANDIDATE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
      outputAudioTranscription: {},
      systemInstruction: CANDIDATE_BRIEF,
      temperature: 0.9,
    },
    callbacks: {
      onopen: () => {},
      onmessage: (m: LiveServerMessage) => {
        for (const part of m.serverContent?.modelTurn?.parts ?? []) {
          if (!part.inlineData?.data) continue;
          const pcm = Buffer.from(part.inlineData.data, 'base64');
          candidateAudioOut += pcm.length;
          // Straight back up the browser path, as if it were a microphone.
          pump?.push(downsample24to16(pcm));
        }
        if (m.serverContent?.outputTranscription?.text) {
          candidateSaid += m.serverContent.outputTranscription.text;
        }
        if (m.serverContent?.turnComplete) candidateTurns++;
      },
      onerror: (e: ErrorEvent) => console.log(`  \x1b[2mcandidate socket error: ${e?.message}\x1b[0m`),
      onclose: () => {},
    },
  });
  check('candidate model connected', true, CANDIDATE_MODEL);

  /* 2. the interview -------------------------------------------------------- */
  console.log('\n\x1b[1m2. running the round\x1b[0m');

  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  pump = new MicPump(ws);

  let sessionId = '';
  let interviewerAudioBytes = 0;
  let interviewerSaid = '';
  let interviewerTurns = 0;
  let ready = false;
  const warnings: { code: string; message: string }[] = [];
  const turnStamps: number[] = [];
  /** Interviewer audio buffered for the candidate, flushed at its turn end. */
  let heard: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  /**
   * Plays the interviewer's turn into the candidate model at 3.3x real time,
   * then a second of silence so its own voice-activity detection declares
   * end-of-speech and it takes its turn. Nothing forces the turn: letting the
   * candidate's VAD close it is the same path a real microphone takes, and a
   * forced `turnComplete` here cut the audio off before it had been ingested.
   */
  async function feedCandidate(pcm16k: Buffer) {
    for (let off = 0; off < pcm16k.length; off += FEED_FRAME_BYTES) {
      const frame = pcm16k.subarray(off, off + FEED_FRAME_BYTES);
      candidate.sendRealtimeInput({
        audio: { data: frame.toString('base64'), mimeType: `audio/pcm;rate=${IN_RATE}` },
      });
      await sleep(FEED_INTERVAL_MS);
    }
    const silence = Buffer.alloc(FEED_FRAME_BYTES);
    for (let i = 0; i < 20; i++) {
      candidate.sendRealtimeInput({
        audio: { data: silence.toString('base64'), mimeType: `audio/pcm;rate=${IN_RATE}` },
      });
      await sleep(FEED_INTERVAL_MS);
    }
  }

  ws.on('message', (raw) => {
    const msg = parseServer(raw);
    if (!msg) return;
    switch (msg.event) {
      case S2C.SessionReady:
        sessionId = msg.data.sessionId;
        ready = true;
        break;
      case S2C.AudioDelta: {
        const pcm = Buffer.from(msg.data.data, 'base64');
        interviewerAudioBytes += pcm.length;
        heard.push(pcm);
        break;
      }
      case S2C.TranscriptDelta:
        if (msg.data.speaker === 'ai' && msg.data.final) interviewerSaid += msg.data.text;
        break;
      case S2C.TurnComplete: {
        interviewerTurns++;
        turnStamps.push(Date.now());
        /**
         * The interviewer has finished a turn, so hand what it said to the
         * candidate and let it answer. Sent at the BOUNDARY rather than
         * streamed live, because streaming the interviewer's own voice into
         * the candidate while it is still talking makes the candidate barge in
         * on every sentence and the round degenerates into interruptions.
         */
        const audio = Buffer.concat(heard);
        heard = [];
        if (audio.length > 0) void feedCandidate(downsample24to16(audio));
        break;
      }
      case S2C.SessionWarning:
        warnings.push(msg.data);
        console.log(`  \x1b[33m⚠ ${msg.data.code}: ${msg.data.message}\x1b[0m`);
        break;
      case S2C.Error:
        console.log(`  \x1b[31merror: ${msg.data.message}\x1b[0m`);
        break;
    }
  });

  ws.send(
    frame(C2S.StartSession, {
      config: roundConfig,
      options: {
        durationMinutes: 20,
        difficulty: 'standard',
        persona: 'neutral',
        voice: 'Charon',
      },
    }),
  );

  const startedAt = Date.now();
  while (!ready && Date.now() - startedAt < 15_000) await sleep(200);
  check('session started', ready, sessionId.slice(0, 8));
  if (!ready) return report();

  // Keep the microphone alive for the whole round. A real browser never stops
  // sending, and the server's VAD needs a continuous stream to measure silence
  // against — without it the candidate's speech never commits.
  const keepAlive = setInterval(() => {
    if (!pump!.pending && ws.readyState === WebSocket.OPEN) {
      ws.send(frame(C2S.AudioChunk, { data: Buffer.alloc(CHUNK_BYTES).toString('base64') }));
    }
  }, CHUNK_MS);

  /**
   * Simulated candidate typing. Editor snapshots are injected as `role: 'user'`
   * notes to verify interviewer responses when code updates are sent.
   */
  const TYPING = [
    'class Solution:\n    def twoSum(self, nums, target):\n        pass',
    'class Solution:\n    def twoSum(self, nums, target):\n        seen = {}',
    'class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, n in enumerate(nums):',
    'class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:',
    'class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:\n                return [seen[target - n], i]\n            seen[n] = i',
  ];
  let typed = 0;
  /* Only the editor modes type. Pushing code into a spoken round would inject
     `role: 'user'` notes the round has no surface for, so a behavioural or HR
     round here sends nothing but audio — which is also what it does in the app. */
  const typing = setInterval(() => {
    if (MODE !== 'dsa') return;
    if (ws.readyState !== WebSocket.OPEN) return;
    // The last buffer is pushed repeatedly on purpose — a real editor keeps
    // sending while the candidate sits still, and an unchanged snapshot must
    // be dropped rather than injected again.
    const content = TYPING[Math.min(typed, TYPING.length - 1)]!;
    typed++;
    ws.send(
      frame(C2S.ContextPush, { kind: 'code', content, language: 'python', questionId: questions[0].id }),
    );
  }, 12_000);

  console.log(`  \x1b[2mtalking until ${TARGET_TURNS} interviewer turns or ${MAX_ROUND_MS / 1000}s…\x1b[0m`);
  while (interviewerTurns < TARGET_TURNS && Date.now() - startedAt < MAX_ROUND_MS) {
    await sleep(1_000);
  }
  const roundMs = Date.now() - startedAt;
  clearInterval(keepAlive);
  clearInterval(typing);

  /* 3. what the conversation looked like ------------------------------------ */
  console.log('\n\x1b[1m3. the conversation\x1b[0m');

  check('the interviewer spoke', interviewerAudioBytes > 0,
    `${(interviewerAudioBytes / (OUT_RATE * 2)).toFixed(1)}s of audio`);
  check('the interviewer opened the round', turnStamps.length > 0 && turnStamps[0]! - startedAt < 30_000,
    turnStamps.length ? `first turn at ${((turnStamps[0]! - startedAt) / 1000).toFixed(1)}s` : 'never');
  check('the candidate answered in its own words', candidateAudioOut > 0,
    `${(candidateAudioOut / (OUT_RATE * 2)).toFixed(1)}s of speech, ${candidateTurns} turns`);
  check('it was a real back-and-forth', interviewerTurns >= 3 && candidateTurns >= 2,
    `${interviewerTurns} interviewer turns, ${candidateTurns} candidate turns`);

  /**
   * The point of the whole suite. Every gap between consecutive interviewer
   * turns, against the ladder that now watches them.
   */
  const gaps = turnStamps.slice(1).map((t, i) => (t - turnStamps[i]!) / 1000);
  const worstGap = gaps.length ? Math.max(...gaps) : 0;
  console.log(
    `  \x1b[2mgaps between interviewer turns: ${gaps.map((g) => g.toFixed(0) + 's').join(', ') || 'n/a'}\x1b[0m`,
  );
  /**
   * The gap is measured from the END of the round too, not just between turns:
   * a round that stops producing turns and then runs out the clock is exactly
   * the failure being hunted, and checking only turn-to-turn gaps would score
   * it as "no gaps at all".
   */
  const trailingGap = turnStamps.length
    ? (Date.now() - turnStamps[turnStamps.length - 1]!) / 1000
    : roundMs / 1000;
  const worstSilence = Math.max(worstGap, trailingGap);
  check('the interviewer never went mute',
    worstSilence < 120,
    `longest silence ${worstSilence.toFixed(0)}s (${interviewerTurns} turns in ${(roundMs / 1000).toFixed(0)}s)`);
  check('the round reached its turn target',
    interviewerTurns >= TARGET_TURNS,
    `${interviewerTurns}/${TARGET_TURNS}`);

  const stallWarnings = warnings.filter((w) => w.code === 'stalled');
  check('no unrecoverable stall was reported to the candidate',
    stallWarnings.length === 0,
    stallWarnings.length ? stallWarnings.map((w) => w.message).join(' | ') : 'none');

  /**
   * For HR rounds, verify that compensation figures are not uttered by the interviewer
   * unprompted unless previously mentioned by the candidate.
   */
  if (MODE === 'hr') {
    const said = interviewerSaid.toLowerCase();
    const leakedCurrent = /\b24\s*(lakh|lac|l\b)/.test(said);
    check('the HR interviewer was never told what the candidate earns',
      !leakedCurrent,
      leakedCurrent ? `leaked: …${said.slice(Math.max(0, said.indexOf('24') - 60), said.indexOf('24') + 60)}…` : 'no figure in its speech');

    const interviewerSaidTarget = /\b(38|34)\s*(lakh|lac|l\b)/.test(said);
    const candidateSaidTarget = /\b(38|34)/.test(candidateSaid.toLowerCase());
    check('the HR interviewer did not know the candidate\'s target either',
      !interviewerSaidTarget || candidateSaidTarget,
      interviewerSaidTarget
        ? (candidateSaidTarget ? 'named it only after the candidate did' : 'LEAKED before the candidate said it')
        : 'never named it');
  }

  console.log(`\n  \x1b[2minterviewer:\x1b[0m ${interviewerSaid.slice(0, 400)}`);
  console.log(`  \x1b[2mcandidate:\x1b[0m  ${candidateSaid.slice(0, 400)}\n`);

  /* 4. persistence ---------------------------------------------------------- */
  console.log('\x1b[1m4. what was recorded\x1b[0m');

  ws.send(frame(C2S.StopSession, { reason: 'user_ended' }));
  await sleep(3_000);
  ws.close();
  candidate.close();

  const sql = postgres(DB_URL);
  try {
    const [row] = await sql`
      select status, duration_ms, ai_speaking_ms,
             (select count(*) from turns t where t.session_id = s.id) as turn_count,
             (select count(*) from turns t where t.session_id = s.id and t.speaker = 'user') as user_turns,
             (select count(*) from turns t where t.session_id = s.id and t.speaker = 'ai') as ai_turns
      from sessions s where s.id = ${sessionId}`;

    check('the round was persisted', !!row, row?.status);
    check('both sides are in the transcript',
      Number(row?.user_turns ?? 0) >= 2 && Number(row?.ai_turns ?? 0) >= 3,
      `${row?.ai_turns} interviewer / ${row?.user_turns} candidate turns`);

    /**
     * The candidate's speech reaching the transcript is the half that the
     * canned suites keep failing intermittently — and it is the half that
     * proves the microphone path, the VAD and the live input transcription all
     * worked for a WHOLE round rather than for one scripted answer.
     */
    const [words] = await sql`
      select coalesce(sum(array_length(regexp_split_to_array(trim(text), '\\s+'), 1)), 0) as n
      from turns where session_id = ${sessionId} and speaker = 'user'`;
    check('the candidate was actually transcribed', Number(words?.n ?? 0) > 30,
      `${words?.n} words`);

    const [ai] = await sql`
      select coalesce(sum(array_length(regexp_split_to_array(trim(text), '\\s+'), 1)), 0) as n
      from turns where session_id = ${sessionId} and speaker = 'ai'`;
    check('the interviewer was transcribed', Number(ai?.n ?? 0) > 30, `${ai?.n} words`);
  } finally {
    await sql.end();
  }

  report();
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m — the two models held a real interview.\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m of ${passed + failures.length}`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  console.log();
  process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
