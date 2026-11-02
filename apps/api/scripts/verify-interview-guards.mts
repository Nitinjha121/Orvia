/**
 * Verification suite for interview guards, session lifecycle, audio handling,
 * and speech guard regressions across live interview flows.
 *
 * Usage:  pnpm --filter @orvia/api verify:guards
 */
import { SessionService } from '../src/interview/session.service';
import { VoiceActivity } from '../src/gemini/voice-activity';
import { InputLiveness, DEAF_COMMIT_WAIT_MS, DEAF_MISSED_COMMITS } from '../src/gemini/input-liveness';
import { classifyFloor } from '../src/gemini/floor-intent';
import { InterviewGateway, API_SHUTDOWN_REASON, clockDue } from '../src/interview/interview.gateway';
import { unjudgedTail } from '../src/interview/turn-checks/round-state';
import { TurnChecks } from '../src/interview/turn-checks/turn-checks';
import { MarkupFilter } from '../src/gemini/markup-filter';
import { interviewerFaultSentence } from '../src/evaluation/interviewer-blame';
import type { RoundEffects } from '../src/interview/turn-checks/effects';
import { QuestionScopeGuard } from '../src/interview/question-scope-guard';
import {
  LiveInterviewSession,
  OPENING_MAX_KICKOFFS,
  OPENING_LADDER,
  OPENING_DEAD_TURN_MS,
  yieldCeilingRung,
  type LiveOptions,
} from '../src/gemini/live-session.service';
import { TranscriptionService } from '../src/evaluation/transcription.service';
import { buildToolDispatcher, MENTOR_TOOLS, COACH_TOOLS } from '../src/coach/coach.tools';
import { PART_SECONDS } from '../src/coach/coach.audio';
import { scrubToolArtifacts } from '../src/gemini/tool-artifacts';
import {
  isNearDuplicate, matchRoundRef, pickMemoryToForget, type MentorToolsService,
} from '../src/coach/mentor-tools.service';
import { CoachGateway } from '../src/coach/coach.gateway';
import type { MentorCatalogueService } from '../src/coach/mentor-catalogue.service';
import { QuestionBankService } from '../src/question-bank/question-bank.service';
import { RepeatGuard, PRESSURE_EXTRA_ASKS } from '../src/interview/repeat-guard';
import { candidateOfferedToEnd, findClockClaim, findFalseClose } from '../src/interview/clock-claim-guard';
import { candidateSignal, codeUnstarted, prematureAdvance } from '../src/interview/advance-guard';
import { findCodeClaim } from '../src/interview/code-claim-guard';
import { clockNoteCorrection, fabricatedNoteClaimsTimeShort } from '../src/interview/spurious-note-correction';
import { buildInterviewerPrompt } from '../src/interview/prompts/interviewer.prompt';
import { expectedColumns, schemaDrift } from '../src/db/schema-check';
import { parseRange } from '../src/interview/byte-range';
import { ensureMixed, mixPathFor } from '../src/interview/audio-mix';
import { wavHeader } from '../src/interview/recording.service';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvaluatorPrompt } from '../src/evaluation/rubric.prompt';
import { EvaluationService, cutShortBy, REFERENCE } from '../src/evaluation/evaluation.service';
import { renderRole } from '../src/interview/session.service';
import { EvaluationController } from '../src/evaluation/evaluation.controller';
import { CodeCheckService } from '../src/evaluation/code-check.service';
import { MODELS, S2C, liveModelQuirks, startSessionSchema } from '@orvia/shared';
import {
  classifyClose, renewalDue, refusalBackoffMs, RefusalTracker, REFUSALS_BEFORE_FAILOVER,
  type UpstreamEvent,
} from '../src/gemini/context-budget';
import { MicBacklog, BACKLOG_MAX_MS } from '../src/gemini/mic-backlog';
import { coachListeningNote } from '../src/coach/coach.prompt';
import { ModelAvailabilityService } from '../src/gemini/model-availability.service';

// Quirk checks name the model they were measured on: the chain's order changes, the measurement does not.
const LIVE_31 = 'gemini-3.1-flash-live-preview';
const LIVE_25 = 'gemini-2.5-flash-native-audio-preview-12-2025';

let pass = 0;
const fails: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++;
  else fails.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A `TurnChecks` acting on a hand-built connection through the gateway's own
 * `roundEffects`, as `onStart` builds it — so the wiring is under test too.
 */
function attachChecks(
  gw: InterviewGateway,
  client: object,
  conn: Record<string, unknown>,
  o: { questions?: { id: string; title: string; prompt: string }[]; starters?: Record<string, string[]> } = {},
): TurnChecks {
  const qs = o.questions ?? [];
  const priv = gw as never as { roundEffects: (c: object, conn: () => unknown) => RoundEffects };
  const checks = new TurnChecks({
    sessionId: String(conn.sessionId ?? 's'),
    mode: 'dsa',
    questionIds: qs.map((q) => q.id),
    questions: qs,
    starters: o.starters ?? {},
    effects: priv.roundEffects.call(gw, client, () => conn),
  });
  conn.checks = checks;
  return checks;
}

/* ── 1. fragment ordering under a slow database ───────────────────────────── */

/**
 * The bug needed the insert to be slower than the gap between two WebSocket
 * frames, which on a local Postgres it usually is not — so the fake database
 * here is deliberately slow. That is the whole point: the ordering must not
 * depend on how fast the write lands.
 */
function fakeDb(inserted: { idx: number; speaker: string; text: string }[], delayMs: number) {
  return {
    insert: () => ({
      values: async (row: { idx: number; speaker: string; text: string }) => {
        await sleep(delayMs);
        inserted.push(row);
      },
    }),
  };
}

async function fragmentOrdering() {
  console.log('\n\x1b[1m1. transcript fragment ordering\x1b[0m');

  const rows: { idx: number; speaker: string; text: string }[] = [];
  const svc = new SessionService(fakeDb(rows, 40) as never, {} as never, {} as never);

  // Stand in for a live session without touching the database.
  (svc as never as { live: Map<string, unknown> }).live.set('s1', {
    id: 's1',
    startedAt: Date.now(),
    turnIdx: 0,
    buffer: null,
    writes: Promise.resolve(),
  });

  // The candidate holds the floor, then the interviewer's reply arrives as
  // three fragments back to back — the exact shape that got reordered.
  svc.recordFragment('s1', 'user', 'I already told you why.');
  svc.recordFragment('s1', 'ai', 'You mentioned');
  svc.recordFragment('s1', 'ai', 'big O of n squared for time complexity.');
  svc.recordFragment('s1', 'ai', 'Can you walk me through that?');
  await svc.flush('s1');

  const ai = rows.find((r) => r.speaker === 'ai');
  check('the candidate turn is stored first', rows[0]?.speaker === 'user', rows[0]?.text);
  check('both turns are stored', rows.length === 2, `${rows.length} rows`);
  check(
    'interviewer fragments keep the order they were spoken in',
    ai?.text === 'You mentioned big O of n squared for time complexity. Can you walk me through that?',
    ai?.text,
  );
  check(
    'turn indexes follow speech order',
    rows.every((r, i) => r.idx === i),
    rows.map((r) => r.idx).join(','),
  );

  // A second handover, to prove it holds when a turn closes while the previous
  // insert is still in flight.
  const rows2: { idx: number; speaker: string; text: string }[] = [];
  const svc2 = new SessionService(fakeDb(rows2, 60) as never, {} as never, {} as never);
  (svc2 as never as { live: Map<string, unknown> }).live.set('s2', {
    id: 's2',
    startedAt: Date.now(),
    turnIdx: 0,
    buffer: null,
    writes: Promise.resolve(),
  });
  for (const [speaker, text] of [
    ['ai', 'A one'], ['ai', 'A two'],
    ['user', 'B one'], ['user', 'B two'],
    ['ai', 'C one'], ['ai', 'C two'],
    ['user', 'D one'], ['user', 'D two'],
  ] as const) {
    svc2.recordFragment('s2', speaker, text);
  }
  await svc2.flush('s2');
  check(
    'four alternating turns all keep their fragment order',
    rows2.map((r) => r.text).join(' | ') === 'A one A two | B one B two | C one C two | D one D two',
    rows2.map((r) => r.text).join(' | '),
  );
}

/* ── 2. the interviewer imitating a system note ───────────────────────────── */

function noteSuppression() {
  console.log('\n\x1b[1m2. fabricated system notes\x1b[0m');

  const make = () => {
    const transcript: string[] = [];
    const spurious: string[] = [];
    // Everything the CANDIDATE actually hears, which is the half that used to
    // go unchecked entirely.
    const heard: string[] = [];
    /** Durations of turns spoken but never transcribed. */
    const untranscribed: number[] = [];
    const s = new LiveInterviewSession(
      {} as never,
      'test-model',
      { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: (d) => heard.push(d),
        onTranscript: (t) => transcript.push(t.text),
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {},
        onSpuriousNote: (t) => spurious.push(t),
        onUntranscribedTurn: (ms) => untranscribed.push(ms),
      },
    );
    // Methods live on the prototype, so they must be bound rather than spread.
    const priv = s as never as {
      emitOutput: (t: string) => void;
      settleOutput: () => void;
      handleMessage: (m: unknown) => void;
    };
    return {
      s,
      transcript,
      spurious,
      heard,
      untranscribed,
      emitOutput: (t: string) => priv.emitOutput.call(s, t),
      settleOutput: () => priv.settleOutput.call(s),
      handleMessage: (m: unknown) => priv.handleMessage.call(s, m),
    };
  };

  /** A server message as it really arrives: audio, transcript, or both. */
  const msg = (text?: string, audio?: string) => ({
    serverContent: {
      ...(audio ? { modelTurn: { parts: [{ inlineData: { data: audio } }] } } : {}),
      ...(text !== undefined ? { outputTranscription: { text } } : {}),
    },
  });

  // The real fabricated turn, delivered the way transcription delivers it.
  const a = make();
  for (const frag of ['[SYSTEM', ' NOTE — not spoken by the candidate]', ' Time is running low.', ' Close the round cleanly.']) {
    a.emitOutput(frag);
  }
  a.settleOutput();
  check('a fabricated note never reaches the transcript', a.transcript.length === 0,
    a.transcript.join('') || 'nothing emitted');
  check('a fabricated note is reported to the gateway', a.spurious.length === 1);

  /**
   * Unbracketed pacing or system notes emitted by the model.
   * Matches notes by shape and classifies fragments as they arrive so
   * directions to the candidate or interviewer are suppressed.
   */
  for (const [name, frags] of [
    ['Pacing note, the real one', ['Pacing', ' note:', ' Time is running low,', ' so move toward closing.']],
    ['a label with a dash', ['Timing', ' note -', ' we are at the twenty minute mark.']],
    ['a label we have not seen yet', ['Internal note: ', 'do not reveal the answer to them.']],
  ] as const) {
    const n = make();
    for (const f of frags) n.emitOutput(f);
    n.settleOutput();
    check(`suppressed: ${name}`, n.transcript.length === 0 && n.spurious.length === 1,
      n.transcript.join('') || `spurious=${n.spurious.length}`);
  }

  /**
   * ...and the sentence that merely CONTAINS the word. The delimiter is what
   * makes a label a label: "note on your approach" is speech and must be
   * spoken, or the guard starts muting the interviewer mid-round.
   */
  for (const [name, frags] of [
    ['a sentence about a note', ['One note', ' on your approach - it is quadratic in the worst case.']],
    ['a turn opening with Note', ['Note', ' that the array is already sorted, which matters here.']],
    ['a turn opening with a bare word', ['So', ' the complexity would be n log n, yes?']],
    ['an ordinary transition', ["Right, let's", ' move on to question two.']],
  ] as const) {
    const k = make();
    for (const f of frags) k.emitOutput(f);
    k.settleOutput();
    check(`spoken: ${name}`, k.transcript.join('') === frags.join('') && k.spurious.length === 0,
      k.transcript.join('') || 'SUPPRESSED — the guard is muting real speech');
  }

  // Ordinary speech must be untouched, and must not be delayed.
  const b = make();
  b.emitOutput('Yes, I ');
  check('normal speech is forwarded on the first fragment', b.transcript.join('') === 'Yes, I ',
    b.transcript.join(''));
  b.emitOutput('can hear you.');
  b.settleOutput();
  check('normal speech is forwarded in order', b.transcript.join('') === 'Yes, I can hear you.',
    b.transcript.join(''));
  check('normal speech raises no alarm', b.spurious.length === 0);

  // A turn that legitimately opens with a bracket is held, then released whole.
  const c = make();
  c.emitOutput('[');
  c.emitOutput('pause] Let me rephrase that question for you now.');
  c.settleOutput();
  check('a bracketed non-note is still delivered',
    c.transcript.join('') === '[pause] Let me rephrase that question for you now.',
    c.transcript.join(''));
  check('a bracketed non-note raises no alarm', c.spurious.length === 0);

  // A short bracketed turn that ends before the sniff window fills must still
  // be released at the turn boundary rather than swallowed.
  const d = make();
  d.emitOutput('[hmm]');
  d.settleOutput();
  check('a short bracketed turn is released at the turn boundary',
    d.transcript.join('') === '[hmm]', d.transcript.join('') || 'SWALLOWED');

  // Mid-turn marker, after the turn has already been classified as speech.
  const e = make();
  e.emitOutput('Okay, understood. ');
  e.emitOutput('[SYSTEM NOTE] close the round now.');
  e.settleOutput();
  check('a mid-turn note is dropped but the real speech is kept',
    e.transcript.join('') === 'Okay, understood. ' && e.spurious.length === 1,
    e.transcript.join(''));

  /**
   * Audio suppression for system notes.
   * Ensures synthesized audio of suppressed system notes is not played to the
   * candidate while the text is being omitted from the transcript.
   */
  const f = make();
  f.handleMessage(msg('[SYSTEM', 'note-1'));
  f.handleMessage(msg(' NOTE — not spoken by the candidate]', 'note-2'));
  f.handleMessage(msg(' Time is running low.', 'note-3'));
  f.settleOutput();
  check('a fabricated note is never PLAYED to the candidate', f.heard.length === 0,
    f.heard.join('|') || 'nothing played');
  check('and it is still kept out of the transcript', f.transcript.length === 0);
  check('a note-only turn leaves the greeting still owed', f.s.hasSpoken === false,
    'otherwise maybeRetryOpening declines to re-send and the round opens on silence');

  // Ordinary speech must be played in full, in order, and unchanged.
  const g = make();
  g.handleMessage(msg('Right, ', 'a1'));
  g.handleMessage(msg("let's move on.", 'a2'));
  g.settleOutput();
  check('ordinary speech is played in full and in order', g.heard.join('|') === 'a1|a2',
    g.heard.join('|'));
  check('speaking it also marks the session as having spoken', g.s.hasSpoken === true);

  // Audio ahead of its transcript — 34% of turns, measured — is held, not lost.
  const h = make();
  h.handleMessage(msg(undefined, 'lead1'));
  check('audio ahead of the transcript is held, not played', h.heard.length === 0,
    h.heard.join('|'));
  h.handleMessage(msg('Right, ', 'lead2'));
  check('and is released in arrival order once the turn is cleared',
    h.heard.join('|') === 'lead1|lead2', h.heard.join('|'));

  // A turn that ends before any transcript arrived must not be swallowed —
  // the same failure as the short bracketed turn above, one stream over.
  const i = make();
  i.handleMessage(msg(undefined, 'x1'));
  i.settleOutput();
  check('audio never classified is released at the turn boundary, not lost',
    i.heard.join('') === 'x1', i.heard.join('') || 'SWALLOWED');

  /**
   * Spoken interviewer turns that generated audio but produced no transcript.
   * Reported so downstream reporting does not treat untranscribed turns as candidate monologues.
   */
  const j = make();
  // 24kHz 16-bit mono: ~1.3s of audio, comfortably past UNTRANSCRIBED_MIN_MS.
  const bigChunk = 'A'.repeat(Math.ceil((64_000 * 4) / 3));
  j.handleMessage(msg(undefined, bigChunk));
  j.settleOutput();
  check('a spoken turn with no transcript is reported', j.untranscribed.length === 1,
    `reported ${j.untranscribed.length}`);
  check('and is reported with the duration actually heard',
    (j.untranscribed[0] ?? 0) > 1_000 && (j.untranscribed[0] ?? 0) < 1_600,
    `${j.untranscribed[0]}ms`);

  // A turn that DID transcribe must never be reported, however short.
  const k = make();
  k.handleMessage(msg('Go ahead.', bigChunk));
  k.settleOutput();
  check('a turn that transcribed normally is not reported', k.untranscribed.length === 0);

  /**
   * A fabricated note is not a failure to capture — we HAD its text and chose
   * to drop it. Reporting it would file a placeholder for a turn the candidate
   * was deliberately spared.
   */
  const l = make();
  l.handleMessage(msg('[SYSTEM NOTE] close the round now.', bigChunk));
  l.settleOutput();
  check('a suppressed note is not reported as untranscribed', l.untranscribed.length === 0,
    'its text arrived; we dropped it on purpose');
  check('and its audio was never played', l.heard.length === 0);
}

/* ── 3. a re-transcription that quietly returned nothing ──────────────────── */

/**
 * Speech-shaped PCM: loud bursts separated by short quiet gaps, so the adaptive
 * threshold has a floor and a peak to work with. A constant tone would sit
 * entirely inside its own noise floor and measure as silence.
 */
function speechLikePcm(seconds: number): Buffer {
  const sr = 16_000;
  const buf = Buffer.alloc(sr * 2 * seconds);
  for (let i = 0; i < sr * seconds; i++) {
    const frame = Math.floor(i / (sr * 0.02));
    const loud = frame % 25 < 20;
    const amp = loud ? 0.3 : 0.0005;
    buf.writeInt16LE(Math.round(Math.sin(i * 0.07) * amp * 32767), i * 2);
  }
  return buf;
}

function degradedTranscription() {
  console.log('\n\x1b[1m3. re-transcription that returned nothing\x1b[0m');

  const svc = new TranscriptionService({ GEMINI_API_KEY: 'not-used-here' } as never);
  const check_ = svc as never as { implausible: (pcm: Buffer, text: string) => string | null };
  const implausible = (pcm: Buffer, text: string) => check_.implausible.call(svc, pcm, text);

  const speech = speechLikePcm(40);
  const silence = Buffer.alloc(16_000 * 2 * 40);

  check('40s of silence returning nothing is accepted',
    implausible(silence, '') === null);

  const emptyDespiteSpeech = implausible(speech, '');
  check('40s of speech returning nothing is rejected', emptyDespiteSpeech !== null,
    emptyDespiteSpeech ?? 'ACCEPTED — this is the bug');

  const sparse = implausible(speech, 'so we will just return zero');
  check('40s of speech returning six words is rejected', sparse !== null,
    sparse ?? 'ACCEPTED — this is the bug');

  const plausible = implausible(speech, Array.from({ length: 100 }, () => 'word').join(' '));
  check('40s of speech returning a hundred words is accepted', plausible === null,
    plausible ?? 'accepted');

  // Slow, sparse speech must not be flagged: the floor is far below normal pace.
  const slow = implausible(speech, Array.from({ length: 20 }, () => 'word').join(' '));
  check('slow speech is not mistaken for a failed segment', slow === null,
    slow ?? 'accepted');
}

/* ── 4. the opening turn ──────────────────────────────────────────────────── */

/**
 * Retrying opening turns when empty.
 * Driven by `turnComplete` with no audio received, avoiding wall-clock race conditions.
 */
function openingTurn() {
  console.log('\n\x1b[1m4. the opening turn\x1b[0m');

  const make = () => {
    const sent: { turnComplete: boolean; text: string }[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as {
      handleMessage: (m: unknown) => void;
      kickoffCount: number;
      everSpoke: boolean;
      session?: unknown;
    };
    priv.session = {
      sendClientContent: (p: { turns?: { parts: { text?: string }[] }[]; turnComplete?: boolean }) => {
        sent.push({
          turnComplete: !!p.turnComplete,
          text: (p.turns?.[0]?.parts ?? []).map((x) => x.text ?? '').join(''),
        });
      },
      sendRealtimeInput: () => {},
      close: () => {},
    };
    return { s, priv, sent };
  };

  const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } };
  const done = { serverContent: { turnComplete: true } };

  {
    const { s, priv, sent } = make();
    check('a fresh session has not spoken', s.hasSpoken === false);

    // The empty opening: the model finished the turn having said nothing.
    priv.handleMessage.call(s, done);
    check('an empty turn does not count as having spoken', s.hasSpoken === false,
      'this is what opened the mic gate too early');
    check('an empty opening is re-sent', sent.length === 1,
      'and only from turnComplete, where no turn is in flight to barge in on');
    check('the retry is a real opening turn',
      !!sent[0]?.text.includes('SESSION START') && sent[0]?.turnComplete === true);
  }

  {
    const { s, priv, sent } = make();
    // A SLOW opening — audio arrives, then the turn ends. Must never be retried.
    priv.handleMessage.call(s, audio);
    /**
     * Audio ARRIVING is no longer the same event as the candidate HEARING it:
     * the note gate holds a turn's audio until the transcript rules out a
     * fabricated note (see `AUDIO_HOLD_MAX_MS`). `hasSpoken` follows delivery,
     * because that is what `maybeRetryOpening` needs to know — a turn that was
     * nothing but a note delivers nothing and still owes a greeting.
     */
    check('held audio has not been heard yet', s.hasSpoken === false,
      'the gate is still deciding whether this turn is a note');
    priv.handleMessage.call(s, done);
    check('the turn boundary delivers it, so the session has spoken',
      s.hasSpoken === true,
      'settleOutput releases before turnComplete tests everSpoke — the order is load-bearing');
    check('an opening that produced audio is never re-sent', sent.length === 0,
      'a merely slow model must not greet the candidate twice');

    // And silence later in the round is the stall watchdog\'s problem, not this one.
    priv.handleMessage.call(s, done);
    check('later empty turns do not re-open the round', sent.length === 0);
  }

  {
    const { s, priv, sent } = make();
    for (let i = 0; i < 6; i++) priv.handleMessage.call(s, done);
    check('retries are capped', sent.length === OPENING_MAX_KICKOFFS - 1,
      `${sent.length} re-sends, then it gives up and leaves the round to the candidate`);
  }

  {
    const { s, priv, sent } = make();
    s.close();
    priv.handleMessage.call(s, done);
    check('a closed session is never re-kicked', sent.length === 0);
  }
}

/* ── 5. mentor tool dispatch ──────────────────────────────────────────────── */

async function toolDispatch() {
  console.log('\n\x1b[1m5. mentor tool dispatch\x1b[0m');

  check('the interviewer is given no tools at all',
    !MENTOR_TOOLS.some((t) => t.name === undefined) && COACH_TOOLS.length < MENTOR_TOOLS.length,
    `mentor ${MENTOR_TOOLS.length} tools, coach ${COACH_TOOLS.length}`);
  check('the coach cannot read other rounds',
    COACH_TOOLS.every((t) => ['remember', 'list_memories', 'forget'].includes(t.name as string)),
    COACH_TOOLS.map((t) => t.name).join(','));
  // Reading a different conversation is the account-wide view that makes the
  // mentor the mentor; the coach is one finished round and stays that way.
  check('only the mentor can read past conversations',
    ['list_conversations', 'get_conversation'].every(
      (n) => MENTOR_TOOLS.some((t) => t.name === n) && !COACH_TOOLS.some((t) => t.name === n)),
    MENTOR_TOOLS.map((t) => t.name).join(','));

  /**
   * Tool arguments must not take a user identifier directly.
   * The authenticated user ID is bound from the socket session.
   */
  const takesAPerson = MENTOR_TOOLS.filter((t) =>
    Object.keys(
      ((t.parameters as { properties?: Record<string, unknown> })?.properties ?? {}),
    ).some((k) => /user|account|owner|email/i.test(k)),
  );
  check('no mentor tool takes a user — the account comes from the socket',
    takesAPerson.length === 0,
    takesAPerson.map((t) => t.name).join(',') || 'none of them');

  // The banks, the profile and the unfinished rounds are account-wide, so they
  // belong to the mentor for the same reason past conversations do.
  check('only the mentor can browse the platform',
    ['list_question_lists', 'browse_questions', 'get_profile', 'list_unfinished_rounds'].every(
      (n) => MENTOR_TOOLS.some((t) => t.name === n) && !COACH_TOOLS.some((t) => t.name === n)),
    MENTOR_TOOLS.map((t) => t.name).join(','));

  /** What each listen asked the listening model for, and what it answers. */
  const listened: { round: string; covers?: string; focus?: string }[] = [];
  let listenerAnswer: string | null = 'They rushed the complexity and said "kind of" a lot.';
  let resolveRef: string | undefined;
  let browsedWith: Record<string, unknown> | undefined;

  const fakeCatalogue = {
    lists: async () => ({ dsa: { lists: [{ list: 'neetcode150' }] } }),
    browse: async (_u: string, opts: Record<string, unknown>) => {
      browsedWith = opts;
      return { questions: [] };
    },
    profile: async () => ({ target_role: 'backend' }),
    unfinishedRounds: async () => ({ rounds: [] }),
  } as unknown as MentorCatalogueService;

  const fakeTools = {
    listRounds: async () => ({ rounds: [] }),
    getReport: async (_u: string, ref?: string) => ({ ref }),
    getTranscript: async () => ({ transcript: 'x' }),
    getCode: async () => ({ your_code: null }),
    resolveSession: async (_u: string, ref?: string) => {
      resolveRef = ref;
      if (ref === 'gone') return null;
      return {
        id: 'sess-1', label: 'Two Sum (2026-09-03)',
        audioPath: ref === 'silent' ? null : '/tmp/x.wav',
      };
    },
    listConversations: async () => ({ conversations: [{ ref: '1', kind: 'mentor' }] }),
    getConversation: async (_u: string, ref?: string) => ({ ref, conversation: 'x' }),
    remember: async (_u: string, c: string) => ({ saved: true, content: c }),
    listMemories: async () => [],
    forget: async () => ({ forgotten: true }),
    explode: () => {},
  } as unknown as MentorToolsService;

  // Long round audio processing.
  const TOTAL = 1575;
  let askedForPart: number | undefined;
  const dispatch = buildToolDispatcher({
    declared: MENTOR_TOOLS,
    tools: fakeTools,
    catalogue: fakeCatalogue,
    userId: 'u1',
    loadAudio: async (path, part = 1) => {
      askedForPart = part;
      if (!path) return null;
      const parts = Math.ceil(TOTAL / PART_SECONDS);
      const idx = Math.min(Math.max(Math.trunc(part), 1), parts) - 1;
      return {
        audio: { mimeType: 'audio/wav', data: 'AAAA' },
        part: idx + 1,
        parts,
        fromSeconds: idx * PART_SECONDS,
        toSeconds: Math.min(TOTAL, (idx + 1) * PART_SECONDS),
        totalSeconds: TOTAL,
        split: parts > 1,
      };
    },
    listen: async (_audio, o) => {
      listened.push(o);
      return listenerAnswer;
    },
  });

  const unknown = await dispatch([{ name: 'nonexistent_tool', args: {} }]);
  check('an unknown tool returns an error instead of throwing',
    unknown.length === 1 && typeof unknown[0]!.response.error === 'string',
    String(unknown[0]!.response.error));

  /**
   * One dispatcher per SCOPE. The Live API does not stop a model naming a tool
   * it was never declared, so a round's coach calling `get_transcript` would
   * read every other round unless the dispatcher refuses it.
   */
  const coachScoped = buildToolDispatcher({
    declared: COACH_TOOLS,
    tools: fakeTools,
    catalogue: fakeCatalogue,
    userId: 'u1',
    pinnedSessionId: 'sess-1',
    loadAudio: async () => null,
    listen: async () => null,
  });
  resolveRef = undefined;
  const smuggled = await coachScoped([
    { name: 'get_transcript', args: { round: '2' } },
    { name: 'browse_questions', args: { mode: 'dsa' } },
    { name: 'list_memories', args: {} },
  ]);
  check('the coach cannot call a mentor tool it was not declared',
    String(smuggled[0]!.response.error).startsWith('no such tool') &&
      String(smuggled[1]!.response.error).startsWith('no such tool') &&
      !smuggled[2]!.response.error && browsedWith === undefined,
    smuggled.map((r) => `${r.name}:${r.response.error ?? 'ok'}`).join(' '));

  const throwing = buildToolDispatcher({
    declared: MENTOR_TOOLS,
    tools: { listRounds: async () => { throw new Error('db is down'); } } as unknown as MentorToolsService,
    catalogue: fakeCatalogue,
    userId: 'u1',
    loadAudio: async () => null,
    listen: async () => null,
  });
  const failed = await throwing([{ name: 'list_rounds', args: {} }]);
  check('a tool that throws still answers the model',
    failed.length === 1 && String(failed[0]!.response.error).includes('db is down'),
    String(failed[0]!.response.error));

  const many = await dispatch([
    { name: 'list_rounds', args: {} },
    { name: 'get_transcript', args: {} },
    { name: 'get_code', args: {} },
  ]);
  check('every call gets exactly one response, in order',
    many.length === 3 && many.map((r) => r.name).join(',') === 'list_rounds,get_transcript,get_code',
    many.map((r) => r.name).join(','));

  const convs = await dispatch([
    { name: 'list_conversations', args: {} },
    { name: 'get_conversation', args: { conversation: '2' } },
  ]);
  check('past conversations are reachable and the reference is passed through',
    (convs[0]!.response as { conversations?: unknown[] }).conversations?.length === 1 &&
      (convs[1]!.response as { ref?: string }).ref === '2',
    JSON.stringify(convs[1]!.response).slice(0, 60));

  const blank = await dispatch([{ name: 'get_report', args: { round: '   ' } }]);
  check('a blank round argument falls back to the latest',
    (blank[0]!.response as { ref?: string }).ref === undefined);

  /* ── the platform tools ───────────────────────────────────────────────── */

  const platform = await dispatch([
    { name: 'list_question_lists', args: {} },
    { name: 'get_profile', args: {} },
    { name: 'list_unfinished_rounds', args: {} },
  ]);
  check('the banks, the profile and the unfinished rounds all dispatch',
    platform.every((r) => !r.response.error),
    platform.map((r) => `${r.name}:${r.response.error ?? 'ok'}`).join(' '));

  await dispatch([
    { name: 'browse_questions', args: { mode: 'DSA', list: 'neetcode150', only: 'never_asked', limit: '10' } },
  ]);
  check('a browse is passed through with its list, filter and limit',
    browsedWith?.mode === 'dsa' && browsedWith?.list === 'neetcode150' &&
      browsedWith?.only === 'never_asked' && browsedWith?.limit === 10,
    JSON.stringify(browsedWith));

  /**
   * A mode the model invented is REFUSED, not defaulted.
   *
   * Defaulting to dsa would answer a question about behavioural practice with a
   * list of coding problems, and nothing downstream — not the model, not the
   * person listening — could tell that it had happened.
   */
  browsedWith = undefined;
  const wrongMode = await dispatch([{ name: 'browse_questions', args: { mode: 'leetcode' } }]);
  check('an unknown bank is refused rather than silently swapped',
    typeof wrongMode[0]!.response.error === 'string' && browsedWith === undefined,
    String(wrongMode[0]!.response.error));

  /**
   * The mentor reads the banks through `QuestionBankService`, and this is why
   * that matters: the mentor SAYS what it reads, so a reference solution or a
   * list of expected points reaching it reaches the candidate — who has not
   * attempted the question yet. The redaction is enforced by which columns are
   * selected, so this drives the real service with a recording stub and checks
   * the projection rather than trusting the comment above it.
   */
  {
    const requested: string[] = [];
    let selectedEverything = false;
    const chain: Record<string, () => unknown> = {};
    for (const link of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
      chain[link] = () => chain;
    }
    const recorder = {
      select: (fields?: Record<string, { name?: string }>) => {
        // `select()` with no projection ships every column, answer key included.
        if (!fields) selectedEverything = true;
        for (const col of Object.values(fields ?? {})) if (col?.name) requested.push(col.name);
        return chain;
      },
    };

    const bank = new QuestionBankService(recorder as never);
    bank.collections(); bank.listDsa(); bank.conceptTopics(); bank.listConcepts();
    bank.competencies(); bank.listBehavioural(); bank.listHrScenarios(); bank.listSystemDesign();

    const WITHHELD = [
      'reference_solution', 'key_insights', 'expected_points', 'common_mistakes',
      'strong_answer', 'probes', 'beats', 'rubric_notes',
    ];
    const leaked = WITHHELD.filter((c) => requested.includes(c));
    check('no bank the mentor can browse returns the evaluator\'s half',
      leaked.length === 0 && !selectedEverything,
      leaked.length ? `LEAKED ${leaked.join(', ')}` : `${requested.length} columns, none of them answers`);
  }

  const noContent = await dispatch([{ name: 'remember', args: {} }]);
  check('remember without content is rejected, not saved',
    typeof noContent[0]!.response.error === 'string');

  listened.length = 0;
  const missing = await dispatch([{ name: 'listen_to_round', args: { round: 'gone' } }]);
  check('listening to a round that does not exist errors and listens to nothing',
    typeof missing[0]!.response.error === 'string' && listened.length === 0,
    String(missing[0]!.response.error));

  listened.length = 0;
  const noRec = await dispatch([{ name: 'listen_to_round', args: { round: 'silent' } }]);
  check('a round with no recording errors and listens to nothing',
    typeof noRec[0]!.response.error === 'string' && listened.length === 0,
    String(noRec[0]!.response.error));

  /**
   * Large audio recordings are transcribed as text before passing to the session
   * to stay within model context bounds.
   */
  listened.length = 0;
  askedForPart = undefined;
  const listen = await dispatch([{ name: 'listen_to_round', args: { round: '3', focus: 'nerves' } }]);
  const r = listen[0]!.response as Record<string, unknown>;
  check('listening returns the listener\'s notes as the result', r.listener_notes === listenerAnswer && listened.length === 1,
    String(r.listener_notes).slice(0, 60));
  check('the listener is told the focus and which part it is hearing',
    listened[0]?.focus === 'nerves' && listened[0]?.covers === 'part 1 of 2, minute 0 to 15 of 26',
    JSON.stringify(listened[0]));
  check('the model is told the notes are someone else\'s listening, not its own',
    /listened to the recording for you/.test(String(r.instruction)) && /listening back/.test(String(r.instruction)),
    'a model that read a summary must not say "I heard you"');
  check('no audio-arriving flag survives from the old path', r.audio_arriving === undefined);
  check('the round reference reached the resolver', resolveRef === '3', String(resolveRef));

  /**
   * Long recordings must be processed completely rather than truncating early.
   */
  check('a long round defaults to part one', askedForPart === 1, `part ${askedForPart}`);
  check('part one of a long round is reported as partial, with a way on',
    r.partial === true && r.part === 1 && r.parts_total === 2 && r.next_part === 2,
    `part ${r.part} of ${r.parts_total}, next ${r.next_part}`);
  check('the part it covers is stated in minutes',
    r.covers_minutes === '0 to 15' && r.minutes_total === 26,
    `${r.covers_minutes} of ${r.minutes_total} min`);

  listened.length = 0;
  const last = await dispatch([{ name: 'listen_to_round', args: { round: '3', part: 2 } }]);
  const r2 = last[0]!.response as Record<string, unknown>;
  check('the requested part reaches the loader', askedForPart === 2, `part ${askedForPart}`);
  check('the final part offers no next part', r2.next_part === undefined, `next ${r2.next_part}`);
  check('the final part still counts as partial',
    r2.partial === true && r2.covers_minutes === '15 to 26' && listened[0]?.covers === 'part 2 of 2, minute 15 to 26 of 26',
    `${r2.covers_minutes}`);

  // Models send integers as strings often enough that rejecting them would
  // cost a turn every time; the loader clamps whatever comes out of this.
  askedForPart = undefined;
  await dispatch([{ name: 'listen_to_round', args: { round: '3', part: 'part 2' } }]);
  check('a part sent as text is understood, not dropped', askedForPart === 2,
    `part ${askedForPart}`);

  askedForPart = undefined;
  const over = await dispatch([{ name: 'listen_to_round', args: { round: '3', part: 9 } }]);
  const r3 = over[0]!.response as Record<string, unknown>;
  check('a part past the end clamps to the last one rather than erroring',
    r3.part === 2 && r3.error === undefined, `part ${r3.part}`);

  listenerAnswer = null;
  const unheard = await dispatch([{ name: 'listen_to_round', args: { round: '3' } }]);
  const rf = unheard[0]!.response as Record<string, unknown>;
  check('a listen nobody could do says so, rather than handing over nothing',
    typeof rf.error === 'string' && /without claiming to know how they sounded/.test(String(rf.error)) &&
      rf.listener_notes === undefined,
    String(rf.error).slice(0, 80));
  listenerAnswer = 'Steady and clear.';

  // A short round must not be dressed up as an excerpt of itself.
  const whole = buildToolDispatcher({
    declared: MENTOR_TOOLS,
    tools: fakeTools,
    catalogue: fakeCatalogue,
    userId: 'u1',
    loadAudio: async () => ({
      audio: { mimeType: 'audio/wav', data: 'AAAA' },
      part: 1, parts: 1, fromSeconds: 0, toSeconds: 600, totalSeconds: 600, split: false,
    }),
    listen: async (_a, o) => {
      listened.push(o);
      return 'Steady and clear.';
    },
  });
  listened.length = 0;
  const short = await whole([{ name: 'listen_to_round', args: {} }]);
  const r4 = short[0]!.response as Record<string, unknown>;
  check('a round that fits is not reported as partial',
    r4.partial === false && r4.parts_total === 1 && r4.next_part === undefined);
  check('...and the listener is not told it is hearing a part', listened[0]?.covers === undefined,
    JSON.stringify(listened[0]));
}

/* ── 5d. a coach socket that goes away while its session is starting ────── */

/**
 * `onStart` awaits the history, the memories and a Live handshake that can
 * take thirty seconds. A socket that closed inside that window, or a second
 * StartSession sent inside it, opened a Live session nothing ever closed.
 */
async function coachStartRace() {
  console.log('\n\x1b[1m5d. a coach start that loses its socket\x1b[0m');

  const make = () => {
    let opened = 0;
    let closed = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gemini = {
      createInterviewSession: async () => {
        opened += 1;
        await gate;
        return { close: () => { closed += 1; } };
      },
    };
    const gw = new CoachGateway(
      {} as never,
      gemini as never,
      { findById: async () => ({ name: 'Alex' }) } as never,
      {} as never,
      { history: async () => [] } as never,
      { listMemories: async () => [] } as never,
      {} as never,
      {} as never,
      { listen: async () => null } as never,
    );
    const client = { OPEN: 1, readyState: 1, send: () => {}, on: () => {}, close: () => {} };
    (gw as never as { identities: WeakMap<object, string> }).identities.set(client, 'u1');
    return {
      gw, client, release,
      counts: () => ({ opened, closed }),
      conn: () => (gw as never as { conns: WeakMap<object, unknown> }).conns.get(client),
    };
  };

  {
    const t = make();
    const start = t.gw.onStart(t.client as never, { scope: 'account' });
    await new Promise((r) => setTimeout(r, 0));
    t.client.readyState = 3;
    await t.gw.handleDisconnect(t.client as never);
    t.release();
    await start;
    check('a socket closed mid-handshake closes the Live session it was opening',
      t.counts().opened === 1 && t.counts().closed === 1 && !t.conn(),
      JSON.stringify(t.counts()));
  }

  {
    const t = make();
    const first = t.gw.onStart(t.client as never, { scope: 'account' });
    const second = t.gw.onStart(t.client as never, { scope: 'account' });
    await new Promise((r) => setTimeout(r, 0));
    t.release();
    await Promise.all([first, second]);
    check('two quick StartSessions open ONE Live session',
      t.counts().opened === 1 && t.counts().closed === 0 && !!t.conn(),
      JSON.stringify(t.counts()));
  }
}

/* ── 5b. a recording queued when the candidate barges in ──────────────────── */

/**
 * Flushes audio queues on turn boundaries and interruptions so held audio
 * is processed even if a turn is interrupted.
 */
function queuedAudioDelivery() {
  console.log('\n\x1b[1m5b. delivering a queued recording\x1b[0m');

  const make = () => {
    const sent: { turnComplete: boolean; hasAudio: boolean }[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as {
      handleMessage: (m: unknown) => void;
      session?: unknown;
    };
    priv.session = {
      sendClientContent: (c: { turns: { parts: Record<string, unknown>[] }[]; turnComplete: boolean }) =>
        sent.push({
          turnComplete: c.turnComplete,
          hasAudio: c.turns[0]!.parts.some((x) => 'inlineData' in x),
        }),
    };
    return { s, priv, sent };
  };

  const audio = { mimeType: 'audio/wav', data: 'AAAA' };

  /**
   * The model greeting. Required before any turn boundary means anything: a
   * `turnComplete` with no audio EVER seen is an empty opening, which is
   * re-sent rather than treated as a boundary — see section 4. The coach
   * always greets before its recording is due, so this is what really happens.
   */
  const greet = (h: { handleMessage: (m: unknown) => void }, s: LiveInterviewSession) =>
    h.handleMessage.call(s, {
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
    });

  const a = make();
  greet(a.priv, a.s);
  a.s.queueAudioNote('part one', audio, { requestReply: true });
  check('a queued recording is not sent immediately', a.sent.length === 0,
    'mid-turn injection is what wedged turn tracking in the first place');
  a.priv.handleMessage.call(a.s, { serverContent: { turnComplete: true } });
  check('a turn boundary delivers it and asks for a reply',
    a.sent.length === 1 && a.sent[0]!.hasAudio && a.sent[0]!.turnComplete === true);

  const b = make();
  greet(b.priv, b.s);
  b.s.queueAudioNote('part one', audio, { requestReply: true });
  b.priv.handleMessage.call(b.s, { serverContent: { interrupted: true } });
  check('a barge-in delivers the recording instead of stranding it',
    b.sent.length === 1 && b.sent[0]!.hasAudio,
    'this is the 2026-09-07 bug: it waited for a boundary that never came');
  check('the barge-in delivery does not request a reply',
    b.sent[0]!.turnComplete === false,
    'the candidate is mid-sentence; a turnComplete there is a competing turn');
  check('a delivered recording is not delivered twice',
    !b.s.hasQueuedAudio && (b.priv.handleMessage.call(b.s, { serverContent: { turnComplete: true } }), b.sent.length === 1),
    `${b.sent.length} sends`);

  // Two parts must not collapse into one slot, and must not go out together —
  // each is separately at the request-size ceiling.
  const c = make();
  greet(c.priv, c.s);
  c.s.queueAudioNote('part one', audio, { requestReply: true });
  c.s.queueAudioNote('part two', audio, { requestReply: true });
  c.priv.handleMessage.call(c.s, { serverContent: { turnComplete: true } });
  check('a second recording does not overwrite the first', c.sent.length === 1 && c.s.hasQueuedAudio);
  c.priv.handleMessage.call(c.s, { serverContent: { turnComplete: true } });
  check('recordings go out one per turn boundary',
    c.sent.length === 2 && !c.s.hasQueuedAudio,
    'two at the size ceiling in one request would be rejected outright');

  // Editor snapshots still coalesce — only the newest buffer matters.
  const d = make();
  greet(d.priv, d.s);
  d.s.sendSnapshotNote('snapshot one');
  d.s.sendSnapshotNote('snapshot two');
  d.priv.handleMessage.call(d.s, { serverContent: { turnComplete: true } });
  check('text notes still coalesce to the newest',
    d.sent.length === 1 && d.sent[0]!.hasAudio === false, `${d.sent.length} sends`);
  d.priv.handleMessage.call(d.s, { serverContent: { interrupted: true } });
  check('a barge-in does not fire a text note out of turn', d.sent.length === 1,
    'only a stranded recording justifies an off-boundary send');
}

/* ── 5c. tool calls read aloud ────────────────────────────────────────────── */

/**
 * Strips verbalized tool call syntax and results from model output before
 * appending to the transcript.
 */
function toolNarration() {
  console.log('\n\x1b[1m5c. tool calls read aloud\x1b[0m');

  const call =
    'save memory kind: pattern content: When explaining complex solutions, you tend ' +
    'to provide a lot of detail instead of focusing on the key steps, leading to long, ' +
    "potentially muddled answers. round: latest That's a good outline of the approach.";
  const a = scrubToolArtifacts(call);
  check('a verbalised tool call is stripped down to the real sentence',
    a.clean === "That's a good outline of the approach." && a.removed !== '', a.clean);

  const resp =
    'response:remember{id:c583f71b-a54b-4a57-b08e-5b1695240e53,merged_into_existing:false,' +
    'saved Understood. I\u2019ve saved that practice method as the "concise recall drill".';
  const b = scrubToolArtifacts(resp);
  check('a verbalised tool result is stripped without eating the next word',
    b.clean.startsWith('Understood.') && b.removed !== '', b.clean.slice(0, 60));

  // The whole point of holding a turn is that ordinary speech must not be
  // touched. A false positive here silently deletes coaching.
  for (const ok of [
    "That's a much clearer summary. You've captured the process of checking substrings.",
    'Remember to breathe before you answer, and name the approach first.',
    'Okay let me listen to that recording now.',
    'Your filler rate went from six to two per hundred words.',
    'What would you like to focus on today?',
  ]) {
    const r = scrubToolArtifacts(ok);
    check(`ordinary speech is untouched: "${ok.slice(0, 34)}…"`,
      r.clean === ok && r.removed === '', r.clean.slice(0, 40));
  }

  // End to end through the session, fragment by fragment the way the API
  // delivers it — the head has to be HELD or the artifact is already on screen.
  // Only a session WITH tools can verbalise one, so only it is sniffed.
  const withTools = { systemInstruction: '', voice: 'Charon', tools: [{ name: 'remember' }] };
  const transcript: string[] = [];
  const s = new LiveInterviewSession(
    {} as never, 'test-model', withTools,
    {
      onReady: () => {}, onAudio: () => {},
      onTranscript: (t) => transcript.push(t.text),
      onTurnComplete: () => {}, onInterrupted: () => {},
      onGoAway: () => {}, onReconnected: () => {},
      onError: () => {}, onClosed: () => {},
    },
  );
  const priv = s as never as { emitOutput: (t: string) => void; settleOutput: () => void };
  for (const frag of ['save', ' memory kind: pattern', ' content: When explaining complex',
                      ' solutions, you ramble. round: latest', " That's a good outline."]) {
    priv.emitOutput.call(s, frag);
  }
  priv.settleOutput.call(s);
  check('nothing of the tool call reaches the transcript',
    !transcript.join('').includes('kind:') && !transcript.join('').includes('save memory'),
    transcript.join('').slice(0, 80));
  check('the speech after the tool call survives',
    transcript.join('').includes("That's a good outline."), transcript.join(''));

  // Real speech must still arrive on the first fragment, not be held.
  const t2: string[] = [];
  const s2 = new LiveInterviewSession(
    {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
    {
      onReady: () => {}, onAudio: () => {},
      onTranscript: (t) => t2.push(t.text),
      onTurnComplete: () => {}, onInterrupted: () => {},
      onGoAway: () => {}, onReconnected: () => {},
      onError: () => {}, onClosed: () => {},
    },
  );
  const priv2 = s2 as never as { emitOutput: (t: string) => void; settleOutput: () => void };
  priv2.emitOutput.call(s2, "That's ");
  check('ordinary speech is still forwarded on its first fragment',
    t2.join('') === "That's ", t2.join('') || 'held');

  // The interviewer has no tools, so it pays neither the hold nor the scrub.
  const t3: string[] = [];
  const s3 = new LiveInterviewSession(
    {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
    {
      onReady: () => {}, onAudio: () => {},
      onTranscript: (t) => t3.push(t.text),
      onTurnComplete: () => {}, onInterrupted: () => {},
      onGoAway: () => {}, onReconnected: () => {},
      onError: () => {}, onClosed: () => {},
    },
  );
  const priv3 = s3 as never as { emitOutput: (t: string) => void };
  priv3.emitOutput.call(s3, 'save memory');
  check('a session with no tools does not hold a head shaped like a tool call',
    t3.join('') === 'save memory', t3.join('') || 'held');
}

/* ── 6. mentor memory deduplication ──────────────────────────────────────── */

function memoryDedup() {
  console.log('\n\x1b[1m6. mentor memory deduplication\x1b[0m');

  // The pair that calibrated the threshold: unmistakably the same observation,
  // scoring 0.57 on significant-word overlap.
  check('a paraphrase of the same observation merges',
    isNearDuplicate(
      'You freeze on graph traversal questions and default to sorting instead.',
      'You freeze on graph problems and reach for sorting rather than traversal.',
    ));

  check('an identical memory merges',
    isNearDuplicate('You rush your complexity analysis.', 'You rush your complexity analysis.'));

  check('two different observations stay separate',
    !isNearDuplicate(
      'Prefers blunt feedback with no softening at all.',
      'Has a Meta onsite scheduled for the third of November.',
    ));

  // The ratio divides by the shorter memory, so without a shared-word floor a
  // terse note would swallow a long unrelated one.
  check('a short memory does not swallow a long unrelated one',
    !isNearDuplicate(
      'Wants shorter answers overall.',
      'You freeze on graph problems and reach for sorting rather than traversal.',
    ));

  check('a topic word in common is not enough',
    !isNearDuplicate(
      'Struggles with graph problems.',
      'Handled the graph question well but rushed the complexity analysis afterwards.',
    ));

  check('empty text never merges', !isNearDuplicate('', 'anything at all here'));

  /**
   * `forget` used a bare 0.5 ratio with no shared-word floor, over a list
   * sorted most-reinforced first — so a short phrase deleted whichever
   * reinforced memory it happened to brush against.
   */
  const memories = [
    { id: 'm1', content: 'You are targeting backend roles at product companies.' },
    { id: 'm2', content: 'You freeze on graph traversal questions and default to sorting instead.' },
    { id: 'm3', content: 'You freeze on graph problems and reach for sorting rather than traversal.' },
  ];
  const short = pickMemoryToForget(memories, 'backend roles');
  check('a two-word phrase deletes nothing', 'candidates' in short && short.candidates.length === 0,
    JSON.stringify(short));
  const byId = pickMemoryToForget(memories, 'm1');
  check('an id deletes exactly that memory', 'target' in byId && byId.target.id === 'm1');
  const byText = pickMemoryToForget(memories, 'you are targeting backend roles at product companies');
  check('the exact text deletes it', 'target' in byText && byText.target.id === 'm1');
  const closest = pickMemoryToForget(memories, 'You freeze on graph traversal and default to sorting.');
  check('one strictly closest near-duplicate is deleted', 'target' in closest && closest.target.id === 'm2',
    JSON.stringify(closest));
  const twins = [
    { id: 't1', content: 'You freeze on graph questions and then panic.' },
    { id: 't2', content: 'You freeze on graph questions but then panic.' },
  ];
  const ambiguous = pickMemoryToForget(twins, 'freeze graph questions then panic');
  check('two equally close memories come back as candidates, nothing deleted',
    'candidates' in ambiguous && ambiguous.candidates.map((m) => m.id).sort().join() === 't1,t2',
    JSON.stringify(ambiguous));

  /* round references: an ordinal is a whole reference, never a digit in a title */
  const day = (d: string) => new Date(`${d}T10:00:00Z`);
  const rounds = [
    { id: 'aaaaaaaa-1', startedAt: day('2026-09-20'), title: 'Two Sum' },
    { id: 'bbbbbbbb-2', startedAt: day('2026-09-10'), title: 'Valid Parentheses' },
    { id: 'cccccccc-3', startedAt: day('2026-09-05'), title: 'Word Ladder' },
    { id: 'dddddddd-4', startedAt: day('2026-09-01'), title: '3Sum' },
  ];
  const ref = (r: string) => matchRoundRef(r, rounds, (i) => rounds[i]!.title);
  check('"3Sum" is the 3Sum round, not the third', ref('3Sum') === 3, String(ref('3Sum')));
  check('"3" is the third most recent', ref('3') === 2, String(ref('3')));
  check('"round 2", "2nd" and "2 rounds back" all count back',
    ref('round 2') === 1 && ref('2nd') === 1 && ref('2 rounds back') === 1,
    [ref('round 2'), ref('2nd'), ref('2 rounds back')].join());
  check('a date still resolves', ref('2026-09-05') === 2, String(ref('2026-09-05')));
  check('latest and first', ref('latest') === 0 && ref('first') === 3);
}

/* ── 7. the interviewer asking the same thing again ───────────────────────── */

/**
 * Replays question repetition scenarios to verify that the repeat guard
 * detects repeated probes and rephrasings without badgering the candidate.
 */
const REAL_ROUND: { speaker: 'ai' | 'user'; text: string }[] = [
  { speaker: 'ai', text: "Given a string s, partition s such that every substring of the partition is a palindrome. What's your approach?" },
  { speaker: 'user', text: 'We will have to go for the brute force solution for this problem. As we are trying to find all the possible combination that exist. So yeah. We will have to use backtracking here.' },
  { speaker: 'ai', text: 'Okay, so you would be expanding the current substring and checking for palindromes. What about the time and space complexity of that approach?' },
  { speaker: 'user', text: 'So, time complexity of that approach will be because here we are having n operations for every possible scenarios. In worst case it could be n factorial because we are picking a character and that character now will not be picked in the subsequent substring.' },
  { speaker: 'ai', text: 'Okay, n factorial. And space complexity?' },
  { speaker: 'user', text: 'We only consider the space taken up by the algorithm itself and here the recursion stack will take the most of the space. So at once we are only going to have O of n depth from the recursion stack. So that is why the space complexity is O of n.' },
  { speaker: 'ai', text: 'Okay, understood. Now, can you start coding that out? Please make sure to consider edge cases as you go.' },
  { speaker: 'user', text: 'Okay, let us do it. So what I am going to do is I am going to create one variable which is result which I am going to return in the end.' },
  { speaker: 'ai', text: 'Thinking about the logic you have, what would happen if the input string was empty?' },
  { speaker: 'user', text: 'In that case it will return an empty array because i is greater than or equal to len s, so it satisfies the condition and pushes an empty partition copy into the result.' },
  // The re-ask. The candidate gave both axes WITH derivations six turns ago.
  { speaker: 'ai', text: 'Understood. Let us stick with your current implementation then. Can you walk me through the time and space complexity of your solution?' },
  { speaker: 'user', text: 'Yeah, give me a minute, okay?' },
  // The output-size spiral.
  { speaker: 'ai', text: 'Regarding the result itself, what is the complexity of storing and returning all those partitions?' },
  { speaker: 'user', text: 'But we do not consider it. Because it is the result we are returning from the algorithm.' },
  { speaker: 'ai', text: 'That makes sense from a problem specification perspective. If you were to describe the size of that result, how would you formulate it?' },
  { speaker: 'user', text: 'Hello.' },
  { speaker: 'ai', text: 'Yes, I am here. I was asking if you were to describe the size of that result, how would you formulate it?' },
  { speaker: 'user', text: 'Yeah, I said n square.' },
  { speaker: 'ai', text: "Could you explain why you think it's n squared?" },
];

function repeatGuard() {
  console.log('\n\x1b[1m7. the interviewer repeating itself\x1b[0m');

  /* ── the real round ───────────────────────────────────────────────────── */
  {
    const g = new RepeatGuard();
    const fired: { at: number; topic: string; level: string; count: number }[] = [];
    REAL_ROUND.forEach((t, i) => {
      if (t.speaker === 'ai') {
        const v = g.observe(t.text);
        if (v) fired.push({ at: i, topic: v.topic, level: v.level, count: v.count });
      } else {
        g.observeCandidate(t.text);
      }
    });

    check('the round is corrected, not left alone', fired.length > 0, `${fired.length} interventions`);
    check(
      're-asking a complexity the candidate already derived is caught',
      fired.some((f) => f.topic === 'complexity:time'),
      fired.map((f) => f.topic).join(', '),
    );
    check(
      'the output-size question is caught on its SECOND ask, not its fifth',
      fired.some((f) => f.topic === 'complexity:output' && f.count === 2),
      fired.filter((f) => f.topic === 'complexity:output').map((f) => `#${f.count}`).join(' '),
    );
    check(
      'asking again after being told escalates to insist',
      fired.some((f) => f.topic === 'complexity:output' && f.level === 'insist'),
    );
    check(
      'a rephrasing does not escape the guard — no two asks shared wording',
      fired.some((f) => f.topic === 'complexity:output'),
    );
    check('the guard does not fire on every turn', fired.length <= 4, `${fired.length} of 10 asks`);
  }

  /* ── what must NOT be corrected ───────────────────────────────────────── */
  {
    const g = new RepeatGuard();
    check('a nudge is not an ask', g.observe('What are you thinking?') === null);
    check('nudging repeatedly never trips the ask guard',
      [1, 2, 3, 4, 5].every(() => g.observe('Take your time. What are you thinking?') === null));
    check('an acknowledgement is not an ask', g.observe('Okay. Understood.') === null);
  }
  {
    const g = new RepeatGuard();
    check('the first ask on a topic passes',
      g.observe('What about the time complexity of that approach?') === null);
    // A bare number, so the one permitted follow-up is still owed.
    g.observeCandidate('It would be n times two to the power n for the time, and order n space.');
    check('one follow-up on the same topic is allowed',
      g.observe('How did you arrive at that time complexity?') === null);
    g.observeCandidate('We are running the loop n times and there are two choices at each character, so that gives two to the n.');
    check('a THIRD ask on the same topic is corrected',
      g.observe('Can you walk me through the time complexity again?') !== null);
    // Terse asks must count. `walk` and `again` are stopwords, so this ask has
    // two content words and an earlier version of the guard ignored it as a
    // nudge — which is why the third ask went uncorrected.
    check('a terse ask that names a topic is still an ask',
      g.countOf('complexity:time') === 3, `counted ${g.countOf('complexity:time')}`);
  }
  {
    // Distinct topics must not pool into one allowance.
    const g = new RepeatGuard();
    check('time, space and output are counted separately', [
      g.observe('What is the time complexity?'),
      g.observe('And the space complexity?'),
      g.observe('What is the size of the result you return?'),
      g.observe('What edge cases matter here?'),
    ].every((v) => v === null));
  }
  {
    // Edge cases are an area, not one fact — three different cases is normal.
    const g = new RepeatGuard();
    check('three different edge-case probes are allowed', [
      g.observe('What would happen if the input string was empty?'),
      g.observe('What other edge cases might be important to consider?'),
      g.observe('What about a string of five identical characters — edge cases there?'),
    ].every((v) => v === null));
  }
  {
    // A refusal is a final answer.
    const g = new RepeatGuard();
    check('first ask on output size passes',
      g.observe('What is the complexity of storing and returning all those partitions?') === null);
    g.observeCandidate('But we do not consider it. Because it is the result we are returning from the algorithm.');
    check('after the candidate declines, the very next ask is corrected',
      g.observe('If you were to describe the size of that result, how would you formulate it?') !== null);
  }
  {
    // "I don't know" is also final.
    const g = new RepeatGuard();
    g.observe('What is the time complexity of your solution?');
    g.observeCandidate("I'm not sure, I haven't worked that out.");
    check('"I am not sure" closes the topic too',
      g.observe('Have another go at the time complexity — what do you think?') !== null);
  }
  {
    // Normalised before matching: a curly apostrophe and "haven't" (not "have
    // not") are how the transcriber actually writes a refusal.
    for (const refusal of [
      'I’m not sure.', "I haven't thought about that.", 'I don’t know.',
      "Let's move on.", "I'd like to move on to the next question.",
      'Can we skip this one?', "I'm stuck.", 'Not sure.',
    ]) {
      const g = new RepeatGuard();
      g.observe('What is the time complexity of your solution?');
      g.observeCandidate(refusal);
      check(`"${refusal}" closes the topic`,
        g.observe('Have another go at the time complexity — what do you think?') !== null);
    }
  }
  {
    /**
     * A refusal phrase INSIDE a real answer is not a refusal. Each of these
     * was filed as declined, which closes the topic at one ask: a bare "move
     * on", "don't include" naming an element, and "I'm not sure" hedging a
     * clause the answer then settled.
     */
    const answers = [
      'We keep a running sum, and then we move on to the next index because the window shrinks from the left whenever the sum goes past the target.',
      'We don’t include the current element in the sum, because it was already counted when the window was extended, so each element is added exactly once.',
      "I'm not sure about the constant factor, but it is linear because every element enters the window once and leaves it once.",
      // A request to move on only where the turn lands, not mid-explanation.
      "When the sum passes the target we shrink from the left, and then let's move on to the next index.",
    ];
    // Edge cases, because an AREA answered keeps a follow-up while a refusal
    // leaves none — a single fact derived "because…" would close either way.
    for (const answer of answers) {
      const g = new RepeatGuard();
      g.observe('What edge cases would you consider for this window?');
      g.observeCandidate(answer);
      check(`an answer is not a refusal: "${answer.slice(0, 40)}..."`,
        g.observe('What about an empty array, any edge cases there?') === null,
        'filed as declined, the topic closes at one ask');
    }
    // ...and the candidate asking to move on still is one.
    const g = new RepeatGuard();
    g.observe('What edge cases would you consider for this window?');
    g.observeCandidate('Can we move on?');
    check('"can we move on" is still a refusal',
      g.observe('What about an empty array, any edge cases there?') !== null);
  }
  {
    // A short non-answer must NOT close a topic the candidate has not addressed.
    const g = new RepeatGuard();
    g.observe('What edge cases would you consider for this problem?');
    g.observeCandidate('Yeah.');
    check('a one-word noise reply does not count as an answer',
      g.observe('Any edge cases at all that come to mind?') === null);
  }
  {
    /**
     * Clarification questions early in a problem are allowed and not flagged
     * as premature repetition.
     */
    const g = new RepeatGuard();
    const asks = [
      "What's your approach?",
      "I'll leave that for the feedback at the end. Let's keep moving — what's your approach?",
      "That's generally correct, yes. So, what's your approach for the partitioning?",
    ];
    const clarifications = [
      'Every substring of the partition is a palindrome. Is that correct?',
      'I have a question regarding the question. The problem statement is saying I need to find all the palindrome from the string, is that correct?',
    ];
    const verdicts = asks.map((a, i) => {
      const v = g.observe(a);
      // Clarifying questions are not answers to "what is your approach".
      if (clarifications[i]) g.observeCandidate(clarifications[i]!);
      return v;
    });
    check('re-asking an UNANSWERED question is never corrected',
      verdicts.every((v) => v === null), JSON.stringify(verdicts.map((v) => v?.topic ?? null)));
  }
  {
    // ...but asking into silence forever still gets stopped.
    const g = new RepeatGuard();
    const verdicts = [1, 2, 3, 4, 5].map(() => g.observe('What is your approach to this problem?'));
    check('asking the same unanswered question five times hits the ceiling',
      verdicts.slice(0, 4).every((v) => v === null) && verdicts[4] !== null,
      JSON.stringify(verdicts.map((v) => (v ? `#${v.count}` : null))));
  }
  {
    // A different question that merely contains a topic phrase.
    const g = new RepeatGuard();
    g.observe('What is your approach to this problem?');
    g.observeCandidate('We will have to use backtracking here, because we are trying to find all the possible combinations that exist for this string.');
    check('"could you modify your approach" is a new question, not a re-ask',
      g.observe('To manage that state correctly, could you modify your approach to avoid popping?') === null);
  }
  {
    // A derivation already given closes the axis — the prompt's own rule.
    const g = new RepeatGuard();
    g.observe('And space complexity?');
    g.observeCandidate(
      'At any point of time the recursion stack will only have O of n frames, because the depth is bounded by the length of the string. So that is why the space complexity is O of n.',
    );
    check('re-asking a derivation the candidate already gave is corrected',
      g.observe("Moving on to space complexity, why do you believe it's O of n?") !== null);
  }
  {
    // A bare number, with no derivation, still earns the one follow-up.
    const g = new RepeatGuard();
    g.observe('What is the time complexity?');
    g.observeCandidate('I would say it is n times two to the power n, and the space is order n.');
    check('a bare answer still leaves the one permitted follow-up',
      g.observe('How did you arrive at that time complexity?') === null);
  }

  /**
   * Catches exact verbatim question repetition even if within overall probe limits.
   */
  const VERBATIM =
    'Understood. We can move on then. Let\'s go back to question one for a moment. ' +
    'You mentioned a backtracking approach for subsets—are there any specific edge ' +
    'cases you should consider with that approach?';
  const ANSWER =
    'No, I mean it will work for all of the cases. I was thinking that it might fail ' +
    'for an empty array, but even if we are having an empty array the backtrack ' +
    'function will get called and the empty array will be added inside res and ' +
    'returned as a response. So it handles all of the cases.';
  {
    const g = new RepeatGuard();
    check('the first ask is fine', g.observe(VERBATIM) === null);
    g.observeCandidate(ANSWER);
    const v = g.observe(VERBATIM);
    check('the SAME question asked again, word for word, is corrected at once',
      v !== null, v ? `#${v.count}, ${v.level}` : 'not caught — repeated questions bug');
  }
  {
    // The allowance exists for a genuine follow-up, and must survive.
    const g = new RepeatGuard();
    g.observe('Are there any edge cases you should consider with that approach?');
    g.observeCandidate(ANSWER);
    check('a narrowing follow-up still spends the allowance rather than firing',
      g.observe('What specifically happens when the input array is empty?') === null,
      'ASKS_ALLOWED is there for exactly this');
  }
  {
    // Nothing fires while the candidate has not answered: re-asking into
    // silence is a different failure with a different remedy.
    const g = new RepeatGuard();
    g.observe(VERBATIM);
    check('an unanswered question may be asked again verbatim',
      g.observe(VERBATIM) === null,
      'the candidate was still thinking');
  }
  {
    /**
     * HR keeps its one extra press. The echo rule must not take it away:
     * pressing once more after a deflection IS the exercise there, which is
     * why `PRESSURE_EXTRA_ASKS` exists at all.
     */
    const Q = 'What are your compensation expectations for this role?';
    const g = new RepeatGuard({ extraAllowance: PRESSURE_EXTRA_ASKS });
    g.observe(Q);
    g.observeCandidate('I am looking for something around forty lakhs base, given the ownership and scope we discussed, and I would want the equity component discussed separately.');
    check('an HR round still gets its one extra identical press',
      g.observe(Q) === null, 'pressing once after an answer IS the exercise');

    const plain = new RepeatGuard();
    plain.observe(Q);
    plain.observeCandidate('I am looking for something around forty lakhs base, given the ownership and scope we discussed, and I would want the equity component discussed separately.');
    check('the same second identical ask fires without the HR allowance',
      plain.observe(Q) !== null, 'so the extra press is HR-only, not a general loophole');
  }
  {
    /**
     * Contraction normalization: ensures contractions like "what's" match approach
     * topics rather than stripping content words.
     */
    const ANSWERED =
      'We can use binary search here, and it will find the target in log n time ' +
      'because the array is already sorted so we discard half of it each step.';
    for (const [name, ask] of [
      ["what's your approach", "What's your approach?"],
      ['what is your approach', 'What is your approach?'],
      ["what's your plan", "What's your plan for cloning it?"],
      ["what's the time complexity", "What's the time complexity?"],
    ] as const) {
      const g = new RepeatGuard();
      let firedAt = 0;
      for (let i = 1; i <= 5 && !firedAt; i++) {
        if (g.observe(ask)) firedAt = i;
        g.observeCandidate(ANSWERED);
      }
      check(`a repeated "${name}" is counted whatever the contraction`,
        firedAt > 0 && firedAt <= 4, firedAt ? `fired on ask ${firedAt}` : 'NEVER fired');
    }
  }
  {
    /**
     * Topic allowance is tracked per problem. Legitimate opening questions for
     * subsequent problems do not share quota with earlier problems.
     */
    const g = new RepeatGuard();
    const ANSWER =
      'I would use a hash map to track which nodes I have already cloned, and then ' +
      'walk the whole graph once with a depth first search from the given node.';
    const COMPLEXITY =
      'It is order n plus e for the time and order n for the space, because the map ' +
      'holds every node we have visited so far.';
    const verdicts: (string | null)[] = [];
    for (let q = 0; q < 3; q++) {
      g.onQuestion(q);
      verdicts.push(g.observe('How would you approach this?')?.level ?? null);
      g.observeCandidate(ANSWER);
      verdicts.push(g.observe("And what's the time complexity?")?.level ?? null);
      g.observeCandidate(COMPLEXITY);
    }
    check('opening each new question with the same two asks never fires',
      verdicts.every((v) => v === null), JSON.stringify(verdicts));

    // ...and the counting still bites WITHIN one problem. One ask has been
    // spent on question three above, so the allowance runs out on the third.
    check('a second ask about the SAME problem is still the permitted follow-up',
      g.observe('Remind me, how would you approach this one?') === null);
    check('but a third ask about the SAME problem fires',
      g.observe('Once more, how would you approach this?') !== null,
      'per-question scoping must not become a general exemption');

    // A backward move must not hand a finished problem a fresh allowance —
    // that re-read is `QuestionScopeGuard`'s to refuse, not a reset.
    const back = new RepeatGuard();
    back.onQuestion(1);
    back.observe('How would you approach this?');
    back.observeCandidate(ANSWER);
    back.observe('How would you approach this?');
    back.onQuestion(0);
    check('going back to an earlier question does not reset its allowance',
      back.observe('How would you approach this?') !== null,
      'onQuestion ignores backward moves');
  }
  {
    /**
     * Echo detection requires sufficient content words so short generic queries
     * do not declare distinct sentences identical.
     */
    const g = new RepeatGuard();
    g.observe('How would you approach that?');
    g.observeCandidate(
      'Let me restate the problem first. I have a two dimensional array and I need to ' +
        'return its values in spiral order as a one dimensional array.',
    );
    check('two different wordings of one short ask are not a verbatim echo',
      g.observe("What's your approach?") === null,
      'one shared content word is a topic match, not an echo');

    // The real echo it must still catch is a long sentence, and the HR case
    // that pins the floor from below keeps exactly three content words.
    const hr = new RepeatGuard();
    const Q = 'What are your compensation expectations for this role?';
    hr.observe(Q);
    hr.observeCandidate('I am looking for something around forty lakhs base, given the ownership and scope we discussed, and I would want the equity component discussed separately.');
    check('a three-content-word ask repeated verbatim still fires',
      hr.observe(Q) !== null, 'MIN_ECHO_WORDS is pinned at three by this case');
  }
  {
    /**
     * A candidate who ENDS on a question has asked, not answered. Both
     * clarifications below clear `MIN_ANSWER_WORDS` several times over, and
     * counting them as answers is what made the guard correct the
     * interviewer's fair second and third ask over the opening minutes.
     */
    const g = new RepeatGuard();
    g.observe("What's your approach?");
    g.observeCandidate(
      'I have a question regarding the question. The problem statement is saying I ' +
        'need to find all the palindromes from the string, is that correct?',
    );
    check('a clarifying question does not close the topic',
      g.observe("Let's come back to that — what's your approach?") === null,
      'the candidate was still working out what the problem meant');

    // An answer that ends by checking itself is still an answer.
    const a = new RepeatGuard();
    a.observe('What is the time complexity?');
    a.observeCandidate(
      'It works out as n log n overall, because we sort the array first and then the ' +
        'single pass over it is linear.',
    );
    check('an answer that happens to be long is still an answer',
      a.observe('And the time complexity again?') !== null);
  }
}

/* ── 10. a round that will never be scored says so ────────────────────────── */

/**
 * Verifies recovery when a session terminates unexpectedly before finalization.
 * Incomplete sessions are identified and reclaimed rather than stalling indefinitely.
 */

/**
 * Minimal drizzle stand-in, keyed by the SELECT's projection rather than by the
 * table object. Identity is not usable here: the script and the service reach
 * `@orvia/db` through different module formats, so `from(sessions) === sessions`
 * is false and every query would silently take the same branch — which is
 * exactly how the first draft of these checks passed while testing nothing.
 */
function readOnlyDb(rows: (columns: string[]) => unknown[]) {
  return {
    select: (projection: Record<string, unknown>) => ({
      from: () => ({ where: async () => rows(Object.keys(projection)) }),
    }),
  };
}

async function missingReport() {
  console.log('\n\x1b[1m10. a round with no report explains itself\x1b[0m');

  const svcFor = (
    sessionStatus: string | null,
    turnCount: number,
    cut: { candidate?: number; durationMs?: number; audioPath?: string | null } = {},
  ) =>
    new EvaluationService(
      readOnlyDb((columns) =>
        columns.includes('n')
          ? [{ n: turnCount, candidate: cut.candidate ?? turnCount }]
          : sessionStatus
            ? [{
                status: sessionStatus,
                durationMs: cut.durationMs ?? 0,
                audioPath: cut.audioPath === undefined ? '/a/s1.wav' : cut.audioPath,
              }]
            : [],
      ) as never,
      { GEMINI_API_KEY: 'test-key' } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  {
    const svc = svcFor('completed', 12);
    // The window between `enqueue` and the row insert — the ONE case where the
    // absence of a row is temporary, and it is read from the in-flight set
    // rather than from a clock.
    (svc as never as { running: Set<string> }).running.add('s1');
    const r = await svc.describeMissing('s1');
    check('a run in flight is reported as pending', r.pending === true && r.reason === null);
  }
  {
    const r = await svcFor('live', 0).describeMissing('s1');
    check('a live round no process here holds is terminal, not pending', r.pending === false && !!r.reason);
    check('a live round offers no re-run', r.evaluable === false);
  }
  {
    // The end screen polls the moment the browser's socket drops, before teardown has finalized the row.
    const svc = svcFor('live', 3);
    svc.roundOpened('s1');
    const closing = await svc.describeMissing('s1');
    check('a live round this process is still closing is pending, so the end screen keeps polling',
      closing.pending === true && closing.evaluable === false, JSON.stringify(closing));
    svc.roundClosed('s1');
    const orphan = await svc.describeMissing('s1');
    check('...and once it lets go, the same row reads as terminal again', orphan.pending === false);
  }
  {
    // Test session state once reclaimed.
    const r = await svcFor('aborted', 0).describeMissing('s1');
    check('an abandoned round is terminal and says it did not finish',
      r.pending === false && /did not finish/.test(r.reason ?? ''));
    check('an abandoned round offers no re-run', r.evaluable === false);
  }
  {
    // The 94s, three-turn round from the test stack: both recordings on disk,
    // and it used to say there was "nothing complete to score".
    const r = await svcFor('aborted', 3, { candidate: 1, durationMs: 94_000 }).describeMissing('s1');
    check('a cut-short round with the candidate on tape offers a re-run',
      r.pending === false && r.evaluable === true, JSON.stringify(r));
    check('...and says it was cut short, and how long it ran',
      r.reason === 'This round was cut short after 1.6 minutes, so it never got a report. ' +
        'You can still score what was recorded.', r.reason ?? '');
  }
  {
    // `run` throws "the candidate did not speak", so the button would be a
    // guaranteed failure.
    const r = await svcFor('aborted', 4, { candidate: 0, durationMs: 60_000 }).describeMissing('s1');
    check('a cut-short round where only the interviewer spoke offers no re-run',
      r.evaluable === false && /did not finish/.test(r.reason ?? ''), JSON.stringify(r));
  }
  {
    const short = await svcFor('aborted', 1, { candidate: 1, durationMs: 20_000 }).describeMissing('s1');
    const silent = await svcFor('aborted', 6, { candidate: 3, durationMs: 76_000, audioPath: null }).describeMissing('s1');
    check('...nor one under two turns, nor one with no recording',
      short.evaluable === false && silent.evaluable === false, JSON.stringify([short, silent]));
  }
  {
    const r = await svcFor('failed', 9, { candidate: 4, durationMs: 300_000 }).describeMissing('s1');
    check('a failed round still offers no re-run', r.evaluable === false && /did not finish/.test(r.reason ?? ''));
  }
  {
    // Mirrors the gate in `InterviewGateway.teardown`: under two turns is never
    // enqueued, so waiting for it is waiting for something nobody will start.
    const r = await svcFor('completed', 1).describeMissing('s1');
    check('a round too short to score is terminal',
      r.pending === false && /enough conversation/.test(r.reason ?? ''));
    check('a round too short to score offers no re-run', r.evaluable === false);
  }
  {
    // Finished, long enough, and still no row: the enqueue died. This is the
    // only case a re-run can actually fix, and the only one that offers it.
    const r = await svcFor('completed', 12).describeMissing('s1');
    check('a scorable round with no run offers a re-run',
      r.pending === false && r.evaluable === true);
  }
  {
    const r = await svcFor(null, 0).describeMissing('s1');
    check('a session that no longer exists is terminal', r.pending === false && r.evaluable === false);
  }

  // The invariant all of the above exist to protect: `pending` is the only
  // thing the client polls on, so every terminal answer must clear it.
  const terminal = await Promise.all(
    [['live', 0], ['aborted', 0], ['failed', 0], ['completed', 0], ['completed', 9]].map(
      ([st, n]) => svcFor(st as string, n as number).describeMissing('s1'),
    ),
  );
  check('no state without a run in flight is left pending',
    terminal.every((r) => r.pending === false && !!r.reason));

  // The re-run race from the test stack: the POST answered before the insert,
  // the report screen's next GET 11ms later read the OLD complete row, and its
  // poll stopped there. The pipeline after the insert is parked on a read that
  // never resolves, so nothing past the row is exercised here.
  {
    let inserted = 0;
    let releaseInsert = () => {};
    const db = {
      select: () => ({
        from: () => ({
          where: () => Object.assign(Promise.resolve([{ id: 's1' }]), { orderBy: () => new Promise(() => {}) }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => new Promise((r) => {
            releaseInsert = () => { inserted++; r([{ id: 'e1' }]); };
          }),
        }),
      }),
    };
    const svc = new EvaluationService(
      db as never, { GEMINI_API_KEY: 'test-key' } as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    let answered = false;
    const first = svc.enqueue('s1').then((v) => { answered = true; return v; });
    await sleep(5);
    check('a re-run does not answer before its evaluations row exists', !answered && inserted === 0);
    check('a second request while one is in flight says so', (await svc.enqueue('s1')) === 'already_running');
    releaseInsert();
    check('...and the first answers started once the row is written',
      (await first) === 'started' && inserted === 1);
  }
  {
    const ctl = (started: string) => new EvaluationController({
      getForSession: async () => null,
      enqueue: async () => started,
    } as never);
    const user = { id: 'u1' } as never;
    const a = await ctl('started').retry(user, 's1');
    const b = await ctl('already_running').retry(user, 's1');
    check('POST answers evaluating for a run it started, already_running for one in flight',
      a.status === 'evaluating' && b.status === 'already_running', JSON.stringify([a, b]));
  }
}

/* ── 11. a restart closes the round it abandoned ──────────────────────────── */

async function abandonedSessions() {
  console.log('\n\x1b[1m11. sessions abandoned by a restart\x1b[0m');

  const HOUR = 60 * 60_000;
  const build = (stale: { id: string; startedAt: Date }[], salvage: unknown) => {
    const updates: Record<string, unknown>[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => stale }) }),
      update: () => ({
        set: (row: Record<string, unknown>) => ({
          where: async () => {
            updates.push(row);
          },
        }),
      }),
    };
    return { updates, svc: new SessionService(db as never, {} as never, salvage as never) };
  };

  {
    const startedAt = new Date(Date.now() - 26 * HOUR);
    const { updates, svc } = build([{ id: 's256', startedAt }], {
      salvage: async () => ({ audioPath: '/a/s256.wav', aiAudioPath: '/a/s256.ai.wav', durationMs: 25860 }),
    });
    await svc.onModuleInit();

    check('an abandoned live session is closed as aborted', updates[0]?.status === 'aborted');
    check('its salvaged recording is recorded on the row',
      updates[0]?.audioPath === '/a/s256.wav' && updates[0]?.aiAudioPath === '/a/s256.ai.wav');
    check('its duration comes from the rescued audio', updates[0]?.durationMs === 25860);
    check('endedAt is startedAt plus that duration',
      (updates[0]?.endedAt as Date).getTime() === startedAt.getTime() + 25860);
  }
  {
    // Unwrappable audio must not leave the row `live` — that IS the bug.
    const { updates, svc } = build([{ id: 's1', startedAt: new Date(Date.now() - 26 * HOUR) }], {
      salvage: async () => {
        throw new Error('no such file');
      },
    });
    await svc.onModuleInit();
    check('a failed salvage still closes the round',
      updates[0]?.status === 'aborted' && updates[0]?.audioPath === null);
  }
  {
    // The sweep must never be able to end a round somebody is sitting in. The
    // query filters by age, so an empty result is what a recent round produces.
    const { updates, svc } = build([], { salvage: async () => ({ durationMs: 0 }) });
    await svc.onModuleInit();
    check('nothing is written when no session is old enough', updates.length === 0);
  }
}

/* ── 11b. playback: ranges, the mix cache, a second finalize ─────────────── */

async function playback() {
  console.log('\n\x1b[1m11b. playback and the end of a round\x1b[0m');

  // RFC 7233 §2.1. A suffix used to be served as its complement ("bytes=-500"
  // as 0-500) and an end past the file was a 416 instead of clamped.
  const r = (h: string | undefined) => JSON.stringify(parseRange(h, 1000));
  check('a suffix range is the LAST n bytes', r('bytes=-500') === JSON.stringify({ start: 500, end: 999 }), r('bytes=-500'));
  check('a suffix longer than the file is the whole file', r('bytes=-5000') === JSON.stringify({ start: 0, end: 999 }));
  check('an end past the file is clamped', r('bytes=900-5000') === JSON.stringify({ start: 900, end: 999 }), r('bytes=900-5000'));
  check('an open-ended range runs to the end', r('bytes=100-') === JSON.stringify({ start: 100, end: 999 }));
  check('a start past the end is 416', parseRange('bytes=1000-', 1000) === 'unsatisfiable');
  check('an empty suffix is 416', parseRange('bytes=-0', 1000) === 'unsatisfiable');
  check('several ranges are ignored, not mangled', parseRange('bytes=0-1,5-9', 1000) === null);
  check('garbage is ignored', parseRange('items=0-1', 1000) === null && parseRange('bytes=9-2', 1000) === null);

  const tmp = await mkdtemp(join(tmpdir(), 'orvia-mix-'));
  try {
    const wav = (samples: number, rate: number) =>
      Buffer.concat([wavHeader(samples * 2, rate, 1, 16), Buffer.alloc(samples * 2, 1)]);
    const mine = join(tmp, 'audio', 's1.wav');
    const theirs = join(tmp, 'audio', 's1.ai.wav');
    await mkdir(join(tmp, 'audio'), { recursive: true });
    await writeFile(mine, wav(16_000, 16_000));
    await writeFile(theirs, wav(30_000, 24_000));

    const out = mixPathFor(tmp, mine);
    check('the mix lives under DATA_DIR/mix, not beside the recordings',
      out === join(tmp, 'mix', 's1.mix.wav'), out);

    const [a, b] = [ensureMixed(mine, theirs, out), ensureMixed(mine, theirs, out)];
    check('concurrent requests share one build', a === b);
    await Promise.all([a, b]);
    const built = await stat(out);
    check('the mix is as long as the longer track', built.size === 44 + 20_000 * 2, `${built.size} bytes`);
    check('no temporary file is left behind',
      (await readdir(join(tmp, 'mix'))).every((f) => !f.endsWith('.tmp')));

    // `ensureLocal` refreshes a restored file's mtime on every access; a fresh
    // mix must not be rebuilt because of it.
    const now = new Date(Date.now() + 60_000);
    await utimes(mine, now, now);
    await ensureMixed(mine, theirs, out);
    check('a touched source does not force a re-mix', (await stat(out)).mtimeMs === built.mtimeMs);

    // The candidate's track is the longer one, so both mixes have one size:
    // a mix built while the interviewer track was missing must not be reused.
    const mine2 = join(tmp, 'audio', 's2.wav');
    const theirs2 = join(tmp, 'audio', 's2.ai.wav');
    await writeFile(mine2, wav(40_000, 16_000));
    await writeFile(theirs2, wav(30_000, 24_000));
    const out2 = mixPathFor(tmp, mine2);
    const solo = await ensureMixed(mine2, null, out2);
    const full = await ensureMixed(mine2, theirs2, out2);
    check('a candidate-only mix is kept apart from the full one',
      solo !== full && full === out2 && !(await readFile(solo)).equals(await readFile(full)), `${solo} ${full}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // A second finalize has no in-memory entry: it must only close a row still
  // `live`, never write duration 0 and null audio over a finished one.
  const wheres: string[] = [];
  const dialect = new PgDialect();
  const db = {
    update: () => ({
      set: () => ({
        where: async (cond: never) => {
          wheres.push(dialect.sqlToQuery(cond).sql);
        },
      }),
    }),
  };
  const svc = new SessionService(db as never, {} as never, {} as never);
  await svc.finalize('gone', 'duplicate stop', undefined);
  check('a finalize with no live state only touches a live row',
    /"status" = \$\d/.test(wheres[0] ?? ''), wheres[0]);
}

/* ── 12. the interviewer going mute mid-round ─────────────────────────────── */

/**
 * Stall watchdog tests for silent interviewer disconnects.
 * Ensures dead sockets are caught while avoiding interruptions when the candidate
 * is thinking or speaking.
 */
function stallWatchdog() {
  console.log('\n\x1b[1m12. the interviewer going mute mid-round\x1b[0m');

  type Priv = {
    handleMessage: (m: unknown) => void;
    checkStall: () => void;
    armStallWatchdog: () => void;
    stallTimer?: NodeJS.Timeout;
    awaitingReply: boolean;
    awaitingSince: number;
    owedQuietMs: number;
    lastInputAt: number;
    lastInputWasFinal: boolean;
    lastOutputAt: number;
    modelTurnOpen: boolean;
    stallStage: number;
    session?: unknown;
  };

  /** Records what the session tried to send upstream instead of a real socket. */
  const make = (o: { toolsNeverAnswer?: boolean } = {}) => {
    const sent: { kind: string; payload: Record<string, unknown> }[] = [];
    const stalls: {
      stage: number; action: string; recovered?: boolean;
      silentMs: number; outageMs: number; firedAt: number;
    }[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onStall: (i) => stalls.push({
          stage: i.stage, action: i.action, recovered: i.recovered,
          silentMs: i.silentMs, outageMs: i.outageMs, firedAt: Date.now() - clockBase,
        }),
        onError: () => {}, onClosed: () => {},
        ...(o.toolsNeverAnswer ? { onToolCall: () => new Promise<never>(() => {}) } : {}),
      },
    );
    const priv = s as never as Priv;
    priv.session = {
      sendClientContent: (p: Record<string, unknown>) => sent.push({ kind: 'clientContent', payload: p }),
      sendRealtimeInput: () => {},
      sendToolResponse: () => {},
      close: () => {},
    };
    return { s, priv, sent, stalls };
  };
  let clockBase = 0;

  /**
   * Driven through the real message path under a controlled clock so internal
   * state transitions are maintained accurately.
   */
  type Driver = ReturnType<typeof make> & {
    at: (ms: number) => void;
    tick: () => void;
    msg: (serverContent?: Record<string, unknown>, raw?: Record<string, unknown>) => void;
    /** The interviewer speaks and yields at the current time. */
    greet: () => void;
    /** The candidate commits an answer that hands nothing back in words. */
    answer: () => void;
  };
  const clocked = (fn: (d: Driver) => void, o: { toolsNeverAnswer?: boolean } = {}) => {
    const m = make(o);
    const realNow = Date.now;
    const base = realNow.call(Date);
    clockBase = base;
    let cur = base;
    Date.now = () => cur;
    try {
      const msg = (serverContent?: Record<string, unknown>, raw?: Record<string, unknown>) =>
        m.priv.handleMessage.call(m.s, raw ?? { serverContent });
      fn({
        ...m,
        at: (ms) => { cur = base + ms; },
        tick: () => m.priv.checkStall.call(m.s),
        msg,
        greet: () => {
          msg({ modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } });
          msg({ turnComplete: true });
        },
        answer: () => msg({ inputTranscription: { text: 'That is my answer.' } }),
      });
    } finally {
      Date.now = realNow;
    }
    return m;
  };

  /**
   * Replays audio and transcription events through `handleMessage` with a controlled clock,
   * testing different interim packet densities to verify ladder triggering.
   */
  type ReplayOpts = {
    /** Interims WITHIN a segment, every this many ms. Absent: one at its start. */
    interimEveryMs?: number;
    /** What each segment's final says. Absent: a neutral "an answer". */
    texts?: string[];
    /**
     * Final timestamps for bursty or delayed transcription arrival.
     */
    finals?: { t: number; text: string }[];
    /** Stream the microphone too: room noise, and speech inside each segment. */
    audio?: boolean;
  };

  /** 100ms of mic PCM: room noise near -50dB, or syllabic speech near -20dB. */
  const micChunk = (voiced: boolean, seed: number) => {
    const n = 1_600;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const noise = (Math.sin((seed * n + i) * 12.9898) * 43758.5453) % 1;
      const amp = voiced ? 0.1 * (0.6 + 0.4 * Math.sin((seed * n + i) * 0.002)) : 0.003;
      buf.writeInt16LE(Math.round((voiced ? Math.sin(i * 0.07) * amp : noise * amp) * 32767), i * 2);
    }
    return buf.toString('base64');
  };

  const replay = (speech: [number, number][], endAt: number, opts: ReplayOpts | number = {}) => {
    const o: ReplayOpts = typeof opts === 'number' ? { interimEveryMs: opts } : opts;
    const { s, priv, sent, stalls } = make();
    const realNow = Date.now;
    const base = realNow.call(Date);
    let firedAt: number | undefined;
    let cur = base;
    (Date as unknown as { now: () => number }).now = () => cur;
    try {
      const at = (ms: number) => { cur = base + ms; };
      // The interviewer's last words, through the real path: audio, then the
      // turn boundary. This is what arms the watchdog and clears any debt.
      at(0);
      priv.handleMessage.call(s, {
        serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
      });
      priv.handleMessage.call(s, { serverContent: { turnComplete: true } });

      type Ev = { t: number; kind: 'interim' | 'final' | 'tick' | 'audio'; text?: string };
      const events: Ev[] = [];
      speech.forEach(([a, b], i) => {
        if (!o.finals) events.push({ t: a, kind: 'interim' });
        if (o.interimEveryMs) {
          for (let t = a + o.interimEveryMs; t < b; t += o.interimEveryMs) {
            events.push({ t, kind: 'interim' });
          }
        }
        if (!o.finals) events.push({ t: b, kind: 'final', text: o.texts?.[i] ?? 'an answer' });
      });
      for (const f of o.finals ?? []) {
        events.push({ t: f.t - 1, kind: 'interim' });
        events.push({ t: f.t, kind: 'final', text: f.text });
      }
      if (o.audio) {
        for (let t = 100; t <= endAt; t += 100) events.push({ t, kind: 'audio' });
      }
      // The watchdog's own 2s tick, exactly as `armStallWatchdog` schedules it.
      for (let t = 0; t <= endAt; t += 2_000) events.push({ t, kind: 'tick' });
      // Input before the tick at the same instant, which is the order a real
      // socket delivers them in.
      events.sort((x, y) => x.t - y.t || (x.kind === 'tick' ? 1 : y.kind === 'tick' ? -1 : 0));

      for (const e of events) {
        if (firedAt !== undefined) break;
        at(e.t);
        if (e.kind === 'interim') {
          priv.handleMessage.call(s, {
            serverContent: { interimInputTranscription: { text: 'still going' } },
          });
        } else if (e.kind === 'final') {
          priv.handleMessage.call(s, {
            serverContent: { inputTranscription: { text: e.text } },
          });
        } else if (e.kind === 'audio') {
          const voiced = speech.some(([a, b]) => e.t > a && e.t <= b);
          s.sendAudio(micChunk(voiced, e.t / 100));
        } else {
          priv.checkStall.call(s);
        }
        if (sent.length > 0) firedAt = e.t;
      }
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
    return { firedAt, sent, stalls, priv };
  };

  /* --- when it must NOT fire ------------------------------------------- */

  {
    // The candidate is thinking at their editor. Nobody is owed anything, and
    // this is exactly the case the reverted "wait through silence" prompt
    // rules were trying to serve — the interviewer must not be prodded into
    // asking "what are you thinking?".
    const { sent } = clocked(({ greet, at, tick }) => {
      greet();
      at(600_000);
      tick();
    });
    check('ten minutes of candidate silence with nothing owed does not nudge',
      sent.length === 0, 'a quiet candidate is thinking, not abandoned');
  }

  {
    const { sent } = clocked(({ greet, answer, msg, at, tick }) => {
      greet();
      answer();
      at(299_000);
      msg({ interimInputTranscription: { text: 'and also' } });   // still mid-sentence
      at(300_000);
      tick();
    });
    check('a candidate who is still talking is never nudged', sent.length === 0,
      'a nudge there would be barge-in on the answer we want replied to');
  }

  {
    // The model has begun replying and the candidate talks over the start of
    // it: owed, and a turn open with no turnComplete yet.
    const { sent } = clocked(({ greet, answer, msg, at, tick }) => {
      greet();
      at(1_000);
      msg({ outputTranscription: { text: 'Right, so' } });
      at(2_000);
      answer();
      at(300_000);
      tick();
    });
    check('an open model turn is never nudged', sent.length === 0,
      'output transcript leads the audio, so the turn is already generating');
  }

  {
    const { sent } = clocked(({ greet, answer, msg, at, tick }) => {
      greet();
      answer();
      at(1_000);
      msg(undefined, { toolCall: { functionCalls: [{ id: 't1', name: 'list_rounds', args: {} }] } });
      at(300_000);
      tick();
    }, { toolsNeverAnswer: true });
    check('a model running tools is never nudged', sent.length === 0,
      'listen_to_round alone can take tens of seconds');
  }

  {
    const { sent } = clocked(({ greet, answer, at, tick }) => {
      greet();
      answer();
      at(24_000);
      tick();
    });
    check('a reply 24s overdue is still left alone', sent.length === 0,
      'p97 of a healthy reply is 24.9s, measured across all 34 rounds');
  }

  /* --- when it must fire ------------------------------------------------ */

  {
    const { sent, stalls } = clocked(({ greet, answer, at, tick }) => {
      greet();
      answer();
      at(26_000);
      tick();
      // Re-checking at the same rung must not re-send: the watchdog ticks every
      // two seconds and would otherwise machine-gun the model.
      at(27_000);
      tick();
      tick();
    });
    check('a reply 26s overdue is nudged', sent.length === 1);
    check('the first nudge is a bare turn-completion',
      sent[0]?.payload.turnComplete === true && sent[0]?.payload.turns === undefined,
      'starts generation on the accumulated prompt, adding nothing to say aloud');
    check('the nudge carries no text the model could read out',
      JSON.stringify(sent[0]?.payload ?? {}).includes('SYSTEM NOTE') === false);
    check('the stall is reported to the gateway', stalls[0]?.stage === 1);
    check('a rung fires exactly once', sent.length === 1);
  }

  {
    const { sent } = clocked(({ greet, answer, at, tick }) => {
      greet();
      answer();
      at(26_000);
      tick();
      at(41_000);
      tick();
      at(61_000);
      tick();
    });
    check('a second silent nudge follows at 40s', sent.length >= 2);
    check('the second nudge is also content-free',
      sent[1]?.payload.turns === undefined);
    const third = sent[2]?.payload.turns as { parts: { text?: string }[] }[] | undefined;
    check('the third rung sends an explicit note asking for a reply',
      !!third && JSON.stringify(third).includes('waiting for you'),
      'the nudge at 40s requested a reply too; its hold lapses before 60s');
    check('that note asks for a reply rather than only adding context',
      sent[2]?.payload.turnComplete === true);
    check('the note forbids apologising or blaming a technical problem',
      JSON.stringify(third ?? []).includes('do not mention any technical problem'),
      'the candidate should never be told the interviewer broke');
  }

  /* --- recovery --------------------------------------------------------- */

  {
    let stageDuring = -1;
    let owedAfter = true as boolean;
    let stageAfter = -1;
    const { sent, stalls } = clocked(({ greet, answer, msg, at, tick, priv }) => {
      greet();
      answer();
      at(26_000);
      tick();
      stageDuring = priv.stallStage;
      // The model speaks again, through the real message path.
      at(27_000);
      msg({ modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } });
      owedAfter = priv.awaitingReply;
      stageAfter = priv.stallStage;
      msg({ turnComplete: true });
      // And the ladder must be climbable again afterwards.
      at(28_000);
      answer();
      at(54_000);
      tick();
    });
    check('a stall is in progress', stageDuring === 1);
    check('output clears the debt', owedAfter === false);
    check('output resets the ladder', stageAfter === 0,
      'so the next stall starts from the cheapest remedy again');
    check('the recovery is reported', stalls.some((x) => x.recovered === true));
    check('a later stall in the same round is caught too', sent.length === 2);
  }

  {
    /**
     * The window is the candidate's wait, not the interviewer's silence. They
     * answer for twenty seconds, hand back, and the reply never comes: the
     * outage runs from the handback, or the budget refund and the evaluator's
     * "measured outage" both count the answer as dead line.
     */
    const { stalls } = clocked(({ greet, msg, at, tick }) => {
      greet();
      at(1_000);
      msg({ interimInputTranscription: { text: 'so my approach' } });
      at(21_000);
      msg({ inputTranscription: { text: 'That is my approach. Can you give me an example?' } });
      for (let t = 22_000; t <= 50_000; t += 2_000) { at(t); tick(); }
    });
    const first = stalls[0];
    check('the outage is timed from the handback, not the interviewer\'s last word',
      !!first && first.outageMs <= 27_000 && first.outageMs >= first.silentMs,
      first ? `outage ${(first.outageMs / 1000).toFixed(0)}s; the interviewer last spoke ${(first.firedAt / 1000).toFixed(0)}s before` : 'never fired');
  }

  /* --- the state feeding it ---------------------------------------------- */

  {
    const { s, priv } = make();
    priv.handleMessage.call(s, {
      serverContent: { inputTranscription: { text: 'that is my answer' } },
    });
    check('a committed utterance puts the model in debt', priv.awaitingReply === true);
    check('the debt is timed from that utterance', priv.awaitingSince > 0);
    const openedAt = priv.awaitingSince;

    priv.handleMessage.call(s, {
      serverContent: { interimInputTranscription: { text: 'and also' } },
    });
    check('an interim keeps the candidate marked as talking',
      Date.now() - priv.lastInputAt < 1_000,
      'this is what stops a nudge landing mid-sentence');

    /**
     * Only the first utterance since the model last spoke opens the debt clock,
     * so subsequent check-ins do not reset the stall timer.
     */
    priv.handleMessage.call(s, {
      serverContent: { inputTranscription: { text: 'can you hear me?' } },
    });
    check('a second utterance does NOT restart the debt clock',
      priv.awaitingSince === openedAt,
      'resetting here makes the stall undetectable');
    check('and the model is still in debt', priv.awaitingReply === true);

    // ...while the model speaking clears both the debt and the quiet banked
    // against it, so the next stall starts from scratch.
    priv.handleMessage.call(s, {
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
    });
    check('the model speaking settles the debt',
      priv.awaitingReply === false && priv.owedQuietMs === 0);
  }

  {
    const { s, priv } = make();
    priv.handleMessage.call(s, {
      serverContent: { outputTranscription: { text: 'Right, what is your approach?' } },
    });
    check('output transcript opens the model turn', priv.modelTurnOpen === true);

    priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
    check('turnComplete closes the model turn', priv.modelTurnOpen === false);
  }

  {
    const { s, priv } = make();
    priv.handleMessage.call(s, {
      serverContent: { outputTranscription: { text: 'Let me ask' } },
    });
    check('a turn is open before the barge-in', priv.modelTurnOpen === true);
    priv.handleMessage.call(s, { serverContent: { interrupted: true } });
    check('a barge-in closes the model turn', priv.modelTurnOpen === false,
      'a barge-in ends a turn without a turnComplete — leaving this set would ' +
      'blind the watchdog for the rest of the round');
  }

  /* --- teardown ---------------------------------------------------------- */

  {
    const { s, priv } = make();
    priv.armStallWatchdog.call(s);
    check('the stall watchdog can be armed', priv.stallTimer !== undefined);
    s.close();
    check('closing clears the stall watchdog', priv.stallTimer === undefined,
      'or it ticks on against a dead socket');
  }

  /* --- replay of the round it was built for ------------------------------ */

  {
    /**
     * Verifies that candidate check-ins on a silent line trigger the stall
     * watchdog within the configured ladder thresholds.
     */
    const OFF = 18_950;
    const segs: [number, number][] = ([
      [21_100, 23_200], [24_000, 24_800], [25_700, 29_500], [30_200, 35_000],
      [36_300, 38_900], [39_400, 40_300], [40_800, 42_500], [43_200, 44_100],
      [45_200, 49_600], [50_200, 51_100], [52_000, 53_400],   // the real answer
      [70_200, 70_600], [72_300, 73_600], [82_500, 86_300], [89_700, 90_300],
      [112_100, 112_400], [112_900, 113_400], [134_700, 139_600],
      [140_900, 144_100], [166_300, 166_800], [167_600, 168_200],
      [168_800, 169_200], [179_600, 179_900], [180_700, 182_400],
    ] as [number, number][]).map(([a, b]) => [a - OFF, b - OFF] as [number, number]);
    const roundEndedAt = 188_121 - OFF;
    /**
     * Their actual words, one per segment. What the floor reads is the part
     * that mattered: an answer, then "I am done", then a line of check-ins.
     */
    const texts = [
      'nobody handles promise rejection then there is nothing to', 'nothing to catch that promise',
      'in that case it will directly go at the top level', 'and crash our running server',
      'to make sure we handle it', 'we need to capture the events', 'like uncaught errors exceptions errors',
      'in this way we we will be able to handle those promises', 'that we might have missed',
      'while writing the code', 'I am done. With my this question answer.',
      'Can you hear me?', 'You are not responding just checking with you.', 'If I am audible or not?',
      'Hello.', 'I am audible?', 'We have started', 'and if I am not able to hear you',
      'we could create time crunch later.', 'So if you can hear me', 'please respond.', 'Okay.',
      'I think I will have to', 'close this down.',
    ];

    const { firedAt, sent, stalls } = replay(segs, roundEndedAt, { texts });
    check('a stall during a long silence is caught at all', firedAt !== undefined,
      'the old measure never reached rung 1 in the whole round');
    check('the first nudge is still the content-free one',
      sent[0]?.payload.turnComplete === true && sent[0]?.payload.turns === undefined);
    check('it is caught within 45s of the candidate finishing',
      firedAt !== undefined && firedAt - (53_400 - OFF) <= 45_000,
      firedAt !== undefined
        ? `fired ${((firedAt - (53_400 - OFF)) / 1000).toFixed(0)}s after the answer ended`
        : '');
    check('it is caught with most of the round still to run',
      firedAt !== undefined && firedAt < roundEndedAt - 80_000,
      'the real round spent 169s of its 188s talking to nothing');
    check('the stall is reported to the gateway', stalls[0]?.stage === 1);

    const dense = replay(segs, roundEndedAt, { texts, interimEveryMs: 500 });
    check('and it is caught just the same with interims streaming',
      dense.firedAt !== undefined && Math.abs(dense.firedAt - (firedAt ?? 0)) <= 2_000,
      'the verdict must not depend on how often the API emits an interim');

    const heard = replay(segs, roundEndedAt, { texts, audio: true });
    check('and just the same when silence is read off the microphone',
      heard.firedAt !== undefined && Math.abs(heard.firedAt - (firedAt ?? 0)) <= 4_000,
      heard.firedAt !== undefined
        ? `fired at ${(heard.firedAt / 1000).toFixed(0)}s against ${((firedAt ?? 0) / 1000).toFixed(0)}s`
        : 'never fired');
    check('...where one burst of late transcription changes nothing',
      replay(segs, roundEndedAt, {
        audio: true,
        finals: [{ t: 40_000, text: texts.slice(0, 13).join(' ') }, { t: 120_000, text: texts.slice(13).join(' ') }],
      }).firedAt !== undefined,
      'the samples say when they stopped; the transcript only says what they said');
  }

  {
    /**
     * Verifies that continuous candidate speech during a dry run or walkthrough
     * does not trigger false stall detections.
     */
    const dryRun: [number, number][] = [
      [0, 1600], [2600, 4500], [5500, 6600], [7600, 7800], [9000, 9300], [9900, 11500],
      [12100, 12400], [13400, 15200], [15900, 16800], [18600, 21400], [22300, 27100],
      [28200, 31200], [32000, 35100], [35800, 35900], [36600, 38700], [40000, 41200],
      [42300, 44200], [45000, 47600], [48900, 51800], [52800, 54400], [55100, 56000],
      [56800, 58400], [59800, 64500], [65400, 66800], [67600, 69400], [70300, 73400],
      [74500, 75800], [76500, 77500], [78200, 81300], [82200, 84900], [85600, 85900],
      [87300, 92300], [94300, 98500], [99600, 99700], [100500, 102800], [104300, 107400],
      [108100, 111400], [112800, 120300], [120900, 122900], [123700, 130200],
      [131100, 137900], [139000, 142500], [143800, 147300], [148300, 150000],
      [151500, 156900], [157600, 158000], [158600, 162500], [163200, 164100],
      [164800, 166100], [167200, 171600], [172900, 174300],
    ];
    // Their words, in the bursts the API actually delivered them in.
    const finals = [
      { t: 19_000, text: 'equals to l I will pop left. Now before I say it completed, let me just run it to the example.' },
      { t: 60_000, text: 'So these are all the answers now let me run it through. I created Q I created S I created L. Now I am checking while Q so Q is empty.' },
      { t: 110_000, text: 'R is greater than equals to K minus one? No it isn\'t. Move on. Is two is greater than one? Yeah it is so I will pop it out and add two.' },
      { t: 160_000, text: 'So minus one is greater than minus three? Yes it is the while loop not run minus three will go there.' },
    ];
    const r = replay(dryRun, 175_000, { audio: true, finals });
    check('a candidate dry-running their code aloud is never nudged', r.firedAt === undefined,
      r.firedAt !== undefined ? `fired at ${(r.firedAt / 1000).toFixed(0)}s` : 'the model was right to sit through all 175 seconds');
    check('...nor is anything banked against it', r.priv.owedQuietMs === 0,
      'the rhetorical questions in a dry run are not put to the interviewer');

    /**
     * Stall 1: "Give me a moment to think about it", then quiet. The nudge that
     * fired here forced out "Take your time. What are you thinking?" — the
     * interviewer nagging somebody who had just asked it not to.
     */
    const moment = replay([[4000, 4200], [8300, 11300], [12100, 12600], [13200, 14200], [15300, 16100],
      [16700, 16800], [17700, 19500]], 90_000, {
      audio: true,
      finals: [{ t: 20_000, text: 'Give me give me a moment to think about it. And summarize my thoughts. So I can explain you the approach.' }],
    });
    check('a candidate who asked for a moment is not nudged', moment.firedAt === undefined,
      'seventy seconds of thinking after "give me a moment" is the request being honoured');

    /**
     * Stall 2, the genuine one: an example asked for mid-code, then "Hello are
     * you there? You are not responding." The model did not answer for 101s,
     * and the old ladder's first nudge is what finally produced the example.
     */
    const stall2: [number, number][] = [
      [700, 2700], [4500, 5400], [6300, 6600], [8600, 8700], [10200, 11800], [13800, 18000],
      [21200, 22900], [23700, 24200], [27800, 29600], [31600, 32000], [33200, 34600],
      [36300, 37100], [38000, 41600], [52800, 52900], [54700, 54800], [60500, 60600],
      [62700, 62800], [67800, 68800], [69400, 69500], [73000, 73100], [74700, 75500],
      [76100, 77300], [80800, 80900], [83100, 83400], [84600, 84700], [86700, 86800],
      [88100, 88200], [95100, 95200],
    ];
    const asked = replay(stall2, 101_000, {
      audio: true,
      finals: [
        { t: 30_000, text: 'less than the current value that is nums q nums r in that case I will do q pop otherwise we are going to append' },
        { t: 43_000, text: 'okay I am checking for this so give can you give me an example so I can while writing the code I can also walk through the actual implementation. Hello are you there? You are not responding.' },
      ],
    });
    check('a candidate who asked and is waiting IS nudged', asked.firedAt !== undefined,
      'the real stall must survive the fix for false ones');
    check('...and sooner than the old ladder managed',
      asked.firedAt !== undefined && asked.firedAt < 100_000,
      asked.firedAt !== undefined ? `nudged at ${(asked.firedAt / 1000).toFixed(0)}s; the reply came at 101s` : '');
    check('...with the content-free rung',
      asked.sent[0]?.payload.turnComplete === true && asked.sent[0]?.payload.turns === undefined);
  }

  {
    /**
     * Narration, then silence while they type. Typing is working: the editor
     * push keeps the ladder off exactly as speech does. Once they ASK, it does
     * not — typing while waiting for an example is still waiting.
     */
    const typing = (question: boolean) => {
      const { s, priv, sent } = make();
      const realNow = Date.now;
      const base = realNow();
      let cur = base;
      Date.now = () => cur;
      try {
        priv.handleMessage.call(s, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
        priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
        for (let t = 100; t <= 60_000; t += 100) {
          cur = base + t;
          s.sendAudio(micChunk(t <= 3_000, t / 100));
          if (t === 3_500) {
            priv.handleMessage.call(s, {
              serverContent: { inputTranscription: { text: question
                ? 'So I will write the loop now. Can you give me an example input?'
                : 'So I will write the loop now and then the window check.' } },
            });
          }
          if (t % 5_000 === 0) s.noteCandidateWorking();
          if (t % 2_000 === 0) priv.checkStall.call(s);
        }
      } finally {
        Date.now = realNow;
      }
      return sent.length;
    };
    check('a minute of silent typing after narration is not nudged', typing(false) === 0,
      'the editor is the candidate working, not waiting');
    check('...but typing after a question does not un-ask it', typing(true) > 0,
      'they are owed the example whatever their hands are doing');
  }

  {
    /**
     * Verifies watchdog triggering during genuine candidate silence.
     */
    const OFF = 151_300;
    const segs: [number, number][] = ([
      [152_300, 157_500], [197_000, 198_300], [214_300, 215_600], [264_800, 266_200],
    ] as [number, number][]).map(([a, b]) => [a - OFF, b - OFF] as [number, number]);
    const roundEndedAt = 304_301 - OFF;

    const { firedAt } = replay(segs, roundEndedAt);
    check('a stall on a dead connection is still caught', firedAt !== undefined);
    check('it is caught within 30s of the unanswered turn',
      firedAt !== undefined && firedAt - (157_500 - OFF) <= 30_000,
      firedAt !== undefined
        ? `fired ${((firedAt - (157_500 - OFF)) / 1000).toFixed(0)}s after the answer ended`
        : '');
    check('it is caught long before the round ran out',
      firedAt !== undefined && firedAt < roundEndedAt - 100_000,
      'the real round spent 153s of its 304s talking to nothing');
  }

  {
    /**
     * Thinking aloud with normal breath pauses must not accumulate silence
     * or trigger spurious interruptions.
     */
    const segs: [number, number][] = [];
    for (let t = 1_000; t < 240_000; t += 6_000) segs.push([t, t + 4_500]);

    const { firedAt, priv } = replay(segs, 240_000);
    check('four minutes of thinking aloud is never interrupted', firedAt === undefined,
      'sub-3s breaths hand the floor back to nobody, so they bank no quiet');
    check('no quiet accumulates across a continuous answer', priv.owedQuietMs === 0);

    const dense = replay(segs, 240_000, 500);
    check('nor when interims stream throughout it', dense.firedAt === undefined);

    /**
     * Single long utterances must not start silence banking at interim arrival.
     */
    const long = replay([[1_000, 15_000], [17_000, 31_000], [33_000, 47_000]], 50_000);
    check('a fourteen-second utterance is not mistaken for silence',
      long.firedAt === undefined && long.priv.owedQuietMs === 0,
      'the stretch between an interim and its final is speech, not a handback');
  }

  {
    /**
     * The other half of the same boundary: the candidate finishes, waits, and
     * the interviewer is merely slow rather than wedged. p97 of a healthy
     * reply measured off the recordings is 24.9s, so 24s of genuine handed-back
     * silence must still be left alone even though it is one uninterrupted gap.
     */
    const { firedAt } = replay([[1_000, 6_000]], 30_000);
    check('a slow-but-alive interviewer is left alone through the real path',
      firedAt === undefined, '24s past the answer is still inside healthy range');
  }
}

/* ── 13. how notes reach the interviewer ──────────────────────────────────── */

/**
 * Guard injection discipline.
 * Mid-round notes injected as client content must not interrupt live turns,
 * corrections are delivered reliably, and barge-ins advance turn boundaries cleanly.
 */
function noteDelivery() {
  console.log('\n\x1b[1m13. how notes reach the interviewer\x1b[0m');

  type Priv = {
    handleMessage: (m: unknown) => void;
    modelTurnOpen: boolean;
    notes: { correctionCount: number; hasSnapshot: boolean };
    everSpoke: boolean;
    session?: unknown;
  };

  const make = (onBoundary?: (s: LiveInterviewSession, how: string) => void) => {
    const sent: { text: string; turnComplete: boolean }[] = [];
    const s: LiveInterviewSession = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onBoundary: (how) => onBoundary?.(s, how),
        onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as Priv;
    priv.session = {
      sendClientContent: (p: { turns?: { parts: { text?: string }[] }[]; turnComplete?: boolean }) => {
        const text = (p.turns?.[0]?.parts ?? []).map((x) => x.text ?? '').join('');
        sent.push({ text, turnComplete: !!p.turnComplete });
      },
      sendRealtimeInput: () => {},
      close: () => {},
    };
    priv.everSpoke = true;
    return { s, priv, sent };
  };

  /** The model is mid-turn: transcript has started, no turnComplete yet. */
  const openTurn = (s: LiveInterviewSession, priv: Priv) =>
    priv.handleMessage.call(s, {
      serverContent: { outputTranscription: { text: 'Right, so what I want to ask is' } },
    });
  const endTurn = (s: LiveInterviewSession, priv: Priv) =>
    priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
  const bargeIn = (s: LiveInterviewSession, priv: Priv) =>
    priv.handleMessage.call(s, { serverContent: { interrupted: true } });

  /* --- barge-in handling ------------------------------------------- */

  {
    const { s, priv, sent } = make();
    openTurn(s, priv);
    check('a turn is open', priv.modelTurnOpen === true);

    s.sendUrgentNote('Stop writing system notes.');
    check('a correction raised mid-turn is NOT sent yet', sent.length === 0,
      'sending here is the barge-in that ended turns');
    check('it is held as urgent', priv.notes.correctionCount === 1);

    endTurn(s, priv);
    check('it goes out at the turn boundary', sent.length === 1);
    check('and asks for a reply', sent[0]?.turnComplete === true,
      'the candidate is owed the turn the fabrication replaced');
  }

  {
    // No turn in flight: the boundary is now, and waiting for one that will
    // never arrive is what leaves the candidate talking to silence.
    const { s, priv, sent } = make();
    check('no turn is open', priv.modelTurnOpen === false);
    s.sendUrgentNote('Respond now.');
    check('a correction with no turn in flight goes immediately', sent.length === 1);
  }

  /* --- a barge-in is a boundary too ------------------------------------- */

  {
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendUrgentNote('Stop writing system notes.');
    bargeIn(s, priv);
    check('a barge-in also delivers the correction', sent.length === 1,
      'a barged turn never produces a turnComplete to wait for');
    check('but does NOT request a reply there', sent[0]?.turnComplete === false,
      'the candidate is mid-sentence; a turnComplete is a competing turn');
  }

  /* --- corrections are never lost --------------------------------------- */

  {
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendUrgentNote('First correction.');
    s.sendUrgentNote('Second correction.');
    check('two corrections both queue', priv.notes.correctionCount === 2,
      'they name different failures; coalescing loses one');

    endTurn(s, priv);
    check('one per boundary', sent.length === 1, 'two turnCompletes in a row compete');
    check('the first goes first', sent[0]?.text.includes('First correction') === true);

    openTurn(s, priv);
    endTurn(s, priv);
    check('the second follows at the next boundary', sent.length === 2 &&
      !!sent[1]?.text.includes('Second correction'));
  }

  {
    // Routine context must not overtake or bury a correction.
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendUrgentNote('Stop writing system notes.');
    s.sendSnapshotNote('Current contents of the editor:\nclass Solution: pass');
    endTurn(s, priv);
    check('the correction wins the boundary over a snapshot',
      sent.length === 1 && !!sent[0]?.text.includes('Stop writing system notes'));
    check('and the snapshot is still pending, not dropped', priv.notes.hasSnapshot);
  }

  /* --- routine context that says nothing new ----------------------------- */

  {
    const { s, priv, sent } = make();
    const snapshot = 'Current contents of the editor:\nclass Solution:\n    pass';

    s.sendSnapshotNote(snapshot);
    openTurn(s, priv); endTurn(s, priv);
    check('the first snapshot is sent', sent.length === 1);

    s.sendSnapshotNote(snapshot);
    openTurn(s, priv); endTurn(s, priv);
    check('an identical snapshot is dropped', sent.length === 1,
      'every injected note is another chance to imitate the format');

    s.sendSnapshotNote(snapshot + '\n    return []');
    openTurn(s, priv); endTurn(s, priv);
    check('a changed snapshot is sent', sent.length === 2);
    check('routine context never requests a reply', sent[1]?.turnComplete === false,
      'a snapshot informs the next question; it does not prompt one');
  }

  /* --- facts a snapshot must not overwrite: clock notes ------------ */

  /**
   * Clock notes must be queued independently of editor snapshots so frequent
   * keystrokes do not overwrite pending time reminders.
   */
  {
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendFactNote('Clock: 10 of 30 minutes have passed.', { key: 'clock' });
    s.sendSnapshotNote('Current contents of the editor:\nclass TimeMap: pass');
    endTurn(s, priv);

    check('a keystroke cannot overwrite the clock',
      sent.length === 1 && !!sent[0]?.text.includes('10 of 30 minutes'),
      'the snapshot took the slot and the clock never arrived');
    check('and the snapshot rides along in the SAME send',
      !!sent[0]?.text.includes('class TimeMap'),
      'two sends at one boundary is the competing-turn shape that wedges VAD');
    check('the joined note does not request a reply', sent[0]?.turnComplete === false);
  }

  {
    // The other half of that round: the note fired while the candidate typed
    // in silence, so the next boundary was 56 seconds away.
    const { s, priv, sent } = make();
    check('no turn is open', priv.modelTurnOpen === false);
    s.sendFactNote('Clock: 5 of 30 minutes have passed.', { key: 'clock' });
    check('a fact with no turn in flight goes immediately', sent.length === 1,
      'a clock note that waits for a boundary minutes away is stale before it lands');
  }

  {
    // Only the newest reading of a KIND is true; different kinds both stand.
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendFactNote('Clock: 5 of 30 minutes have passed.', { key: 'clock' });
    s.sendFactNote('Clock: 10 of 30 minutes have passed.', { key: 'clock' });
    s.sendFactNote('The candidate has switched to question 2.', { key: 'question-switch' });
    s.sendFactNote('There is no next question.');
    s.sendFactNote('You have asked this three times.');
    endTurn(s, priv);

    check('a newer clock reading replaces the stale one',
      sent.length === 1 && !sent[0]!.text.includes('5 of 30'),
      'delivering "5 of 30" after "10 of 30" tells the model something false');
    check('and does so in place, keeping the order',
      sent[0]!.text.indexOf('10 of 30') < sent[0]!.text.indexOf('switched to question 2'));
    check('a different kind of fact is not collapsed with it',
      !!sent[0]?.text.includes('switched to question 2'));
    check('unkeyed facts never collapse into each other',
      !!sent[0]?.text.includes('no next question') &&
        !!sent[0]?.text.includes('asked this three times'),
      'two corrections are two different failures; dropping either loses the only chance to say so');
  }

  {
    // A barge-in strands a fact the same way it stranded a correction.
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendFactNote('Clock: 10 of 30 minutes have passed.', { key: 'clock' });
    s.sendSnapshotNote('Current contents of the editor:\nclass TimeMap: pass');
    bargeIn(s, priv);
    check('a barge-in also delivers the fact', sent.length === 1 &&
      !!sent[0]?.text.includes('10 of 30 minutes'),
      'a barged turn never produces a turnComplete to wait for');
    check('but does NOT request a reply there', sent[0]?.turnComplete === false);
    check('and the snapshot is left behind, not sent', !sent[0]?.text.includes('class TimeMap'),
      'the next keystroke redraws it; sending it here buys a stale buffer for an extra injection');
  }

  {
    // A correction still outranks both, and neither is lost waiting for it.
    const { s, priv, sent } = make();
    openTurn(s, priv);
    s.sendUrgentNote('Stop writing system notes.');
    s.sendFactNote('Clock: 10 of 30 minutes have passed.', { key: 'clock' });
    endTurn(s, priv);
    check('the correction still wins the boundary over a fact',
      sent.length === 1 && !!sent[0]?.text.includes('Stop writing system notes'));

    openTurn(s, priv); endTurn(s, priv);
    check('and the fact follows at the next boundary', sent.length === 2 &&
      !!sent[1]?.text.includes('10 of 30 minutes'));
  }

  /* --- one boundary, one send ------------------------------------------ */

  {
    // What the gateway does at every turnComplete: a clock claim AND a scope
    // correction, found in the turn that just ended.
    const { s, priv, sent } = make((sess, how) => {
      if (how !== 'turnComplete') return;
      sess.sendUrgentNote('You claimed the clock.');
      sess.sendFactNote('There is no next question.');
    });
    openTurn(s, priv);
    endTurn(s, priv);
    check('the boundary checks and the boundary flush are ONE send', sent.length === 1,
      `${sent.length} sends — each correction used to go out on its own straight after the flush`);
    check('...the correction first, the fact waiting its turn',
      !!sent[0]?.text.includes('claimed the clock') && !sent[0]?.text.includes('no next question'));
  }

  {
    const { s, priv, sent } = make((sess, how) => {
      if (how === 'interrupted') sess.sendUrgentNote('You claimed the clock.');
    });
    openTurn(s, priv);
    bargeIn(s, priv);
    check('a correction found at a barge-in goes as context, not a reply request',
      sent.length === 1 && sent[0]?.turnComplete === false,
      'it used to be sent straight after with turnComplete, on top of the candidate talking');
  }

  {
    // No turn open, but a reply has just been asked for and not begun.
    const realNow = Date.now;
    const base = realNow.call(Date);
    let cur = base;
    Date.now = () => cur;
    try {
      const { s, priv, sent } = make();
      s.sendUrgentNote('Respond now.');
      cur = base + 1_000;
      s.sendFactNote('Clock: 5 of 30 minutes have passed.', { key: 'clock' });
      check('a fact does not land on top of a reply just requested', sent.length === 1,
        'modelTurnOpen is false until the reply starts, and that gap is what let it through');
      openTurn(s, priv);
      endTurn(s, priv);
      check('...and goes at the boundary of that reply',
        sent.length === 2 && !!sent[1]?.text.includes('5 of 30'));

      const b = make();
      b.s.sendUrgentNote('Respond now.');
      b.s.sendFactNote('Clock: 10 of 30 minutes have passed.', { key: 'clock' });
      cur = base + 16_000;
      (b.priv as never as { checkStall: () => void }).checkStall.call(b.s);
      check('a requested reply that never begins stops holding notes',
        b.sent.length === 2 && !!b.sent[1]?.text.includes('10 of 30'),
        'a bare turnComplete into a session that owes nothing produces no turn at all');
    } finally {
      Date.now = realNow;
    }
  }

  {
    // Mid-turn, the literal marker: its text is dropped, its audio still plays, so it is reported heard.
    const heard: string[] = [];
    const texts: string[] = [];
    const notes: boolean[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: (d) => heard.push(d),
        onTranscript: (t) => texts.push(t.text),
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {}, onSpuriousNote: (_t, wasHeard) => notes.push(wasHeard),
      },
    );
    const h = (m: unknown) => (s as never as Priv).handleMessage.call(s, m);
    h({ serverContent: { outputTranscription: { text: 'Okay, thanks for walking me through that.' } } });
    h({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    h({ serverContent: { outputTranscription: { text: ' Good. [SYSTEM NOTE] Time is running low.' } } });
    h({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'BBBB' } }] } } });
    h({ serverContent: { outputTranscription: { text: ' Close the round.' } } });
    check('speech before a mid-turn marker is kept', texts.join('').includes('Good.'));
    check('...the marker fragment is not', !/SYSTEM NOTE|running low/.test(texts.join('')), texts.join(''));
    check('...its audio is not cut, since transcript leads audio and a cut silences speech before it',
      heard.join(',') === 'AAAA,BBBB', heard.join(','));
    check('...so the note is reported as heard', notes.join(',') === 'true', notes.join(','));
  }
}

/* ── 14. the interviewer never opening at all ─────────────────────────────── */

/**
 * Unresponsive opening turn handling.
 * Ensures the stall ladder arms even if the model never delivers opening audio
 * or a turnComplete event, while completing remedies within a reasonable wait time.
 */
async function openingStall() {
  console.log('\n\x1b[1m14. the interviewer never opening at all\x1b[0m');

  type Priv = {
    handleMessage: (m: unknown) => void;
    kickoff: () => void;
    checkStall: () => void;
    armStallWatchdog: () => void;
    session?: unknown;
  };

  const make = () => {
    const stalls: {
      stage: number; silentMs: number; action: string; opening?: boolean; recovered?: boolean;
    }[] = [];
    /** One array per upstream socket, so a reconnect is visible as a new one. */
    const sockets: Record<string, unknown>[][] = [];
    const socket = () => {
      const out: Record<string, unknown>[] = [];
      sockets.push(out);
      return {
        sendClientContent: (p: Record<string, unknown>) => out.push(p),
        sendRealtimeInput: () => {},
        close: () => {},
      };
    };
    const ai = { live: { connect: async () => socket() } };
    const s = new LiveInterviewSession(
      ai as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onStall: (i) => stalls.push({
          stage: i.stage, silentMs: i.silentMs, action: i.action,
          opening: i.opening, recovered: i.recovered,
        }),
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as Priv;
    // What `start` does, minus the socket it cannot open here.
    priv.session = socket();
    priv.kickoff.call(s);
    priv.armStallWatchdog.call(s);
    return { s, priv, sent: sockets[0]!, sockets, stalls };
  };

  /** A handle arrives within the first seconds of every real round. */
  const handle = { sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } };
  /** Lets an awaited `forceReconnect` finish before the next assertion. */
  const settle = () => sleep(5);

  const realNow = Date.now;
  const asOf = <T,>(ms: number, fn: () => T): T => {
    const base = realNow();
    Date.now = () => base + ms;
    try {
      return fn();
    } finally {
      Date.now = realNow;
    }
  };
  /** Runs the watchdog as it would run `ms` after the opening was asked for. */
  const at = (priv: Priv, s: LiveInterviewSession, ms: number) =>
    asOf(ms, () => priv.checkStall.call(s));
  /** Delivers a server message as it would have arrived `ms` in. */
  const deliverAt = (priv: Priv, s: LiveInterviewSession, ms: number, msg: unknown) =>
    asOf(ms, () => priv.handleMessage.call(s, msg));

  const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } };
  /**
   * The real shape of a turn starting: audio AND the transcript that clears it
   * through the note gate. Measured over 133 interviewer turns, the transcript
   * arrives first in 66% of them and within 91ms in 95% — so audio with no
   * transcript at all is the exception, and `audio` above is kept to pin what
   * the gate does with it.
   */
  const spoke = {
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
      outputTranscription: { text: 'Hello, I am your interviewer' },
    },
  };
  const [RUNG1, RUNG2, RUNG3, RUNG4, RUNG5] = OPENING_LADDER as [
    number, number, number, number, number,
  ];
  const isPrimer = (p: Record<string, unknown> | undefined) =>
    (p?.turns as { parts: { text?: string }[] }[] | undefined)?.[0]
      ?.parts.some((q) => q.text?.includes('SESSION START')) === true;

  {
    const { s, priv, sent, sockets, stalls } = make();
    priv.handleMessage.call(s, handle);
    check('the opening primer goes out once', sent.length === 1);

    at(priv, s, RUNG1 - 2_000);
    check('a healthy opening is left alone below the first rung', stalls.length === 0,
      `nothing at ${(RUNG1 - 2_000) / 1000}s; measured openings speak by 6.8s`);

    at(priv, s, RUNG1 + 1_000);
    check('a silent opening reaches rung one', stalls.length === 1 && stalls[0]?.stage === 1);
    check('rung one is a bare turn-completion',
      sent.length === 2 && sent[1]?.turnComplete === true && sent[1]?.turns === undefined,
      'it adds nothing to the conversation and cannot be read aloud');
    check('the gateway is told this is an opening, not a stall',
      stalls[0]?.opening === true,
      'the two need different wording — the candidate has heard nothing at all');

    at(priv, s, RUNG2 + 1_000);
    check('rung two re-sends the primer', stalls[1]?.stage === 2 && isPrimer(sent[2]),
      'the first remedy that can actually produce a greeting, at 25s and not 40s');

    at(priv, s, RUNG3 + 1_000);
    check('rung three re-sends it once more', stalls[2]?.stage === 3 && isPrimer(sent[3]),
      `the allowance is ${OPENING_MAX_KICKOFFS} kickoffs including the first`);

    at(priv, s, RUNG4 + 1_000);
    await settle();
    check('rung four throws the socket away', stalls[3]?.stage === 4 && sockets.length === 2,
      'the turn state that will not start generating is server-side');
    check('the re-sent primers did not push this rung out',
      (stalls[3]?.silentMs ?? 0) < RUNG4 + 5_000,
      'the debt is timed from the FIRST ask; re-arming it per kickoff put this past 100s');
    check('the resumed socket is primed, since a round with no history has none to lose',
      isPrimer(sockets[1]?.[0]));

    at(priv, s, RUNG5 + 1_000);
    check('rung five gives up and says so', stalls[4]?.stage === 5,
      'the gateway turns stage five into "end the round and start it again"');
    check('the whole ladder is spent before a real candidate hangs up', RUNG5 < 58_000,
      'session disconnected early');
  }

  {
    const { s, priv, sent, stalls } = make();
    // The healthy path: the model speaks, late but of its own accord.
    priv.handleMessage.call(s, spoke);
    check('a delivered opening ends the debt', s.hasSpoken === true,
      'the transcript cleared the note gate, so the audio went to the candidate');
    at(priv, s, RUNG3 * 2);
    check('an opening that arrived is never nudged', stalls.length === 0 && sent.length === 1,
      'a merely slow greeting must not be interrupted or repeated');
  }

  {
    const { s, priv } = make();
    /**
     * Audio with no transcript yet is HELD, not heard — so the opening debt
     * stands. This is the window the note gate buys, and it is bounded by a
     * wall-clock timer rather than by more audio arriving, because a turn that
     * goes quiet must not stay muted. See `AUDIO_HOLD_MAX_MS`.
     */
    priv.handleMessage.call(s, audio);
    check('audio alone does not end the opening debt', s.hasSpoken === false,
      'until the gate clears it, the candidate has heard nothing');
  }

  {
    const { s, priv, sent, stalls } = make();
    /**
     * Generation has started — output transcript leads the audio — so there IS
     * a turn in flight. Nudging here is the barge-in that made `test:e2e` pass
     * 1 run in 8 when the retry was a wall clock.
     */
    const fragment = { serverContent: { outputTranscription: { text: 'Hello, shall we' } } };
    deliverAt(priv, s, 3_000, fragment);
    at(priv, s, 3_000 + OPENING_DEAD_TURN_MS - 2_000);
    check('an opening still being generated is never interrupted',
      stalls.length === 0 && sent.length === 1,
      'modelTurnOpen is the proof the old wall-clock retry lacked');

    // ...and a turn that keeps producing keeps its reprieve, however long the
    // Healthy opening greeting.
    deliverAt(priv, s, 3_000 + OPENING_DEAD_TURN_MS - 1_000, fragment);
    at(priv, s, 3_000 + OPENING_DEAD_TURN_MS + 1_000);
    check('a turn still producing fragments is left alone past the grace',
      stalls.length === 0 && sent.length === 1,
      'the grace runs from the last fragment, not from when the turn opened');
  }

  {
    const { s, priv, sent, sockets, stalls } = make();
    priv.handleMessage.call(s, handle);
    /**
     * An open model turn without audio or completion must not suspend
     * the stall ladder indefinitely.
     */
    deliverAt(priv, s, 3_000, { serverContent: { outputTranscription: { text: 'Hello, shall we' } } });
    at(priv, s, 3_000 + OPENING_DEAD_TURN_MS + 1_000);
    check('a turn open and silent past the grace is treated as dead',
      stalls.length === 1 && stalls[0]?.opening === true,
      'an open turn proves generation STARTED, never that it is progressing');
    check('the candidate has still heard nothing', s.hasSpoken === false,
      'which is the only measure of the opening that matters');
    check('nothing is sent into the open turn', sent.length === 1,
      'every cheap rung is client content, and that is barge-in while a turn is live');
    await settle();
    check('the remedy is to throw the socket away', sockets.length === 2,
      'it sends nothing upstream and takes the wedged turn state with it');

    // The flag cannot survive the socket it belonged to, or the new one is
    // born blind and the ladder never fires again.
    at(priv, s, RUNG5 + 1_000);
    check('the reconnected socket is not left with a turn stuck open',
      stalls[1]?.stage === 5,
      'the ladder still reaches the rung that tells the candidate to start over');
  }

  {
    const { s, priv, sockets } = make();
    priv.handleMessage.call(s, handle);
    const fragment = { serverContent: { outputTranscription: { text: 'Hello, shall we' } } };
    deliverAt(priv, s, 3_000, fragment);
    at(priv, s, 3_000 + OPENING_DEAD_TURN_MS + 1_000);
    await settle();
    check('the wedged-open reconnect happens once', sockets.length === 2);

    /**
     * A socket that dribbles — one fragment, then nothing, then another — resets
     * `stallStage` through `noteOutput` every time, so the rungs below become
     * available again and the round would recycle sockets until the candidate
     * left. A third one fixes nothing the second did not.
     */
    deliverAt(priv, s, RUNG2, fragment);
    at(priv, s, RUNG2 + OPENING_DEAD_TURN_MS + 1_000);
    await settle();
    check('...and a turn that wedges open again does not recycle the socket',
      sockets.length === 2, 'telling the candidate is what is left');
  }

  {
    const { s, priv, sent, sockets, stalls } = make();
    // No handle yet. The reconnect drops the handle anyway, so it never needed one.
    deliverAt(priv, s, 3_000, { serverContent: { outputTranscription: { text: 'Hello, shall we' } } });
    at(priv, s, 3_000 + OPENING_DEAD_TURN_MS + 1_000);
    await settle();
    check('a wedged turn with no handle sends nothing into it', sent.length === 1,
      'every cheap rung is client content, and that is barge-in while a turn is live');
    check('...and is still reconnected, on a clean socket', sockets.length === 2,
      'the reconnect discards the handle; requiring one left this round with no remedy');
    check('...and the gateway is told', stalls.length === 1);
  }

  {
    const { s, priv, stalls } = make();
    /**
     * The opening arriving is the one event that can clear the banner honestly.
     * A fragment cannot: `noteOutput` clears the rung off something the server
     * produced, while the candidate is still sitting in silence.
     */
    at(priv, s, RUNG1 + 1_000);
    priv.handleMessage.call(s, { serverContent: { outputTranscription: { text: 'Hello there' } } });
    check('a fragment does not announce a recovery',
      stalls.filter((x) => x.recovered).length === 0,
      '"the interviewer is back" while they hear nothing is worse than the banner');

    priv.handleMessage.call(s, {
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
    });
    const done = stalls.filter((x) => x.recovered);
    check('delivered audio does', done.length === 1 && done[0]?.opening === true,
      'everSpoke follows delivery, and so does the message that clears the banner');
  }

  {
    const { s, priv, stalls } = make();
    /**
     * When the candidate is speaking as a rung falls due, nudges defer to avoid barge-in.
     */
    const speaking = { serverContent: { interimInputTranscription: { text: 'am I audible' } } };
    deliverAt(priv, s, RUNG1, speaking);
    at(priv, s, RUNG1 + 1_000);
    check('nothing is sent over the candidate\'s voice', stalls.length === 0,
      'the interim proves they are still talking');

    // ...but their talking must not hold the ladder off for ever, which is the
    // Ensures stalls are caught even if a turn is left open.
    at(priv, s, RUNG1 + 4_000);
    check('the rung lands once they stop', stalls.length === 1 && stalls[0]?.stage === 1,
      'a candidate checking in on a dead line must not postpone recovery');
  }

  {
    const { s, priv, stalls } = make();
    s.close();
    at(priv, s, RUNG3 + 1_000);
    check('a closed session climbs no rungs', stalls.length === 0);
  }

  {
    const { s, sent } = make();
    s.sendFactNote('Clock: 5 of 30 minutes have passed.', { key: 'clock' });
    check('a note does not go out on top of the primer', sent.length === 1,
      'no turn is open yet, but the primer asked for one');
  }
}

/* ── 17. rebuilding a session the upstream can no longer be trusted with ──── */

/**
 * Unresponsive session rebuild and recovery.
 * When an upstream session stops generating, the final ladder rung opens
 * a clean socket, replays transcript history, and resumes cleanly.
 */
async function sessionRebuild() {
  console.log('\n\x1b[1m17. rebuilding the session from our own transcript\x1b[0m');

  type Priv = {
    handleMessage: (m: unknown) => void;
    checkStall: () => void;
    armStallWatchdog: () => void;
    session?: unknown;
  };

  const HISTORY = [
    { role: 'model' as const, text: 'Right, question two. Return the number of islands.' },
    { role: 'user' as const, text: 'Let me restate it. I have a grid of ones and zeros.' },
    { role: 'model' as const, text: 'Correct. What is your approach?' },
    { role: 'user' as const, text: 'A DFS from every unvisited land cell. Can you give me an example?' },
  ];

  const make = (opts: { history?: boolean } = { history: true }) => {
    const stalls: { stage: number; action: string; remedy: string }[] = [];
    const sockets: Record<string, unknown>[][] = [];
    /** Every config the SDK was asked to connect with, to read the handle off. */
    const configs: Record<string, unknown>[] = [];
    const socket = () => {
      const out: Record<string, unknown>[] = [];
      sockets.push(out);
      return {
        sendClientContent: (p: Record<string, unknown>) => out.push(p),
        sendRealtimeInput: () => {},
        close: () => {},
      };
    };
    const ai = {
      live: {
        connect: async (req: { config: Record<string, unknown> }) => {
          configs.push(req.config);
          return socket();
        },
      },
    };
    const s = new LiveInterviewSession(
      ai as never, 'test-model',
      {
        systemInstruction: '', voice: 'Charon',
        ...(opts.history ? { history: async () => HISTORY } : {}),
      },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onStall: (i) => stalls.push({ stage: i.stage, action: i.action, remedy: i.remedy }),
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as Priv;
    priv.session = socket();
    priv.armStallWatchdog.call(s);
    return { s, priv, sockets, configs, stalls };
  };

  const realNow = Date.now;
  const asOf = <T,>(ms: number, fn: () => T): T => {
    const base = realNow();
    Date.now = () => base + ms;
    try {
      return fn();
    } finally {
      Date.now = realNow;
    }
  };
  const settle = () => sleep(5);

  /** Recreates an unresponsive session state where the model has spoken, then stopped. */
  const runToRung5 = async (m: ReturnType<typeof make>) => {
    const { s, priv } = m;
    priv.handleMessage.call(s, { sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    // A real turn, delivered: audio plus the transcript that clears the gate.
    priv.handleMessage.call(s, {
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
        outputTranscription: { text: 'Correct. What is your approach?' },
        turnComplete: true,
      },
    });
    // The candidate answers, and nothing comes back. `STALL_LADDER` is
    // [25, 40, 60, 90, 120]; one check past the last rung climbs straight to it.
    priv.handleMessage.call(s, { serverContent: { inputTranscription: { text: 'a DFS' } } });
    asOf(121_000, () => priv.checkStall.call(s));
    await settle();
  };

  {
    const m = make();
    await runToRung5(m);
    check('this is the MID-ROUND ladder, not the opening one', m.s.hasSpoken === true,
      'the interviewer spoke, then died — the two debts have separate ladders');

    check('the last rung rebuilds the session', m.stalls.at(-1)?.stage === 5 &&
      m.stalls.at(-1)?.remedy === 'rebuild');
    check('on a NEW socket', m.sockets.length === 2);
    check('...opened WITHOUT the resumption handle',
      !!m.configs[0] && (m.configs[0].sessionResumption as { handle?: string })?.handle === undefined,
      'resuming restores the server session that wedged — the one thing never varied');

    const sent = m.sockets[1] ?? [];
    const turns = (sent[0]?.turns ?? []) as { role: string; parts: { text: string }[] }[];
    const replayed = turns[0]?.parts[0]?.text ?? '';
    const lines = HISTORY.map((h) => `${h.role === 'model' ? 'YOU' : 'CANDIDATE'}: ${h.text}`);
    /**
     * Replays context as a single labelled transcript in one user turn.
     */
    check('the round is replayed onto it, as a transcript in one turn',
      turns.length === 1 && turns[0]?.role === 'user' && lines.every((l) => replayed.includes(l)),
      `${HISTORY.length} stored turns and the instruction in one`);
    check('...in order, with the speakers kept straight',
      lines.every((l, i) => i === 0 || replayed.indexOf(l) > replayed.indexOf(lines[i - 1]!)));
    check('...as ONE client content', sent.length === 1,
      'two would be two turns at one boundary, which is the competing-turn problem');

    const instruction = turns.at(-1)?.parts[0]?.text ?? '';
    check('and the model is told it is resuming, not starting',
      /SESSION RESUMED/.test(instruction));
    check('it is forbidden to greet or re-introduce itself',
      /do NOT greet/i.test(instruction) && /do NOT introduce/i.test(instruction),
      'a fresh session that says hello again at minute twenty is its own failure');
    check('it is forbidden to re-ask what it already asked',
      /do NOT ask anything you have already asked/i.test(instruction));
    check('and to mention the fault',
      /Do not\s+mention the connection/i.test(instruction),
      'the candidate is told by the banner; the interviewer narrating it is noise');
  }

  {
    const m = make();
    await runToRung5(m);
    check('the rebuild happens once', m.sockets.length === 2);

    // A model dribbling one fragment per rung resets `stallStage` through
    // `noteOutput`, so without a cap the round would recycle sockets.
    m.priv.handleMessage.call(m.s, { serverContent: { outputTranscription: { text: 'er' } } });
    m.priv.handleMessage.call(m.s, { serverContent: { turnComplete: true } });
    m.priv.handleMessage.call(m.s, { serverContent: { inputTranscription: { text: 'hello?' } } });
    asOf(400_000, () => m.priv.checkStall.call(m.s));
    await settle();
    check('...and never twice', m.sockets.length === 2,
      'a second rebuild fixes nothing the first did not');
  }

  {
    const m = make({ history: false });
    await runToRung5(m);
    check('a session with no history supplier is not rebuilt', m.sockets.length === 1);
    check('...and says so rather than claiming a remedy',
      m.stalls.at(-1)?.action === 'unrecoverable',
      'the coach and mentor sockets have no round to replay');
  }
}

/* ── 18. what a dead interviewer costs the round's budget ─────────────────── */

/**
 * Dead air refunding.
 * Time lost while the model is unresponsive is refunded to the round budget
 * so candidates receive their full allotted working time.
 */
function roundBudget() {
  console.log('\n\x1b[1m18. the round budget a dead interviewer does not get to spend\x1b[0m');

  type Priv = {
    budgetMs: (c: unknown) => number;
    closeStall: (c: unknown, recovered: boolean) => void;
  };
  type TestConn = {
    sessionId: string;
    stallLog: { atMs: number; forMs: number; wallMs?: number; recovered: boolean; opening: boolean }[];
    stallOpen: { atMs: number; startedAt: number; rung: number; action: string; opening: boolean } | null;
    deadMs: number;
  };

  let elapsed = 0;
  const gw = new InterviewGateway(
    {} as never,
    { elapsedMs: () => elapsed } as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  const priv = gw as never as Priv;
  const conn = (): TestConn => ({ sessionId: 's', stallLog: [], stallOpen: null, deadMs: 0 });

  {
    elapsed = 10 * 60_000;
    const c = conn();
    check('a round with no stalls spends every minute it takes',
      priv.budgetMs(c) === elapsed,
      'the thresholds must be identical to the fixed timers this replaced');
  }

  {
    const c = conn();
    elapsed = 16 * 60_000;
    c.stallOpen = {
      atMs: 16 * 60_000, startedAt: Date.now(), rung: 1, action: 'nudge', opening: false,
    };
    // Four minutes pass with the interviewer unresponsive.
    const realNow = Date.now;
    Date.now = () => realNow() + 4 * 60_000;
    elapsed = 20 * 60_000;
    try {
      check('an outage in progress freezes the budget',
        Math.round(priv.budgetMs(c) / 60_000) === 16,
        'twenty minutes on the wall, sixteen of them theirs');

      priv.closeStall(c, false);
      check('...and closing it banks what it cost', Math.round(c.deadMs / 60_000) === 4);
      check('the budget stays where the outage left it',
        Math.round(priv.budgetMs(c) / 60_000) === 16);
      check('the stretch is recorded, unrecovered',
        c.stallLog.length === 1 && c.stallLog[0]?.recovered === false &&
          Math.round((c.stallLog[0]?.forMs ?? 0) / 60_000) === 4,
        'a round that ends mid-silence holds the longest outage of all');

      {
        // A deaf window opens at a time built from fractional audio durations.
        const d = conn();
        d.stallOpen = {
          atMs: 16 * 60_000 + 0.4, startedAt: realNow() + 4 * 60_000 - 82_345.6, rung: 5,
          action: 'rebuild', opening: false,
        };
        priv.closeStall(d, true);
        const rec = d.stallLog[0];
        check('a stall is stored in whole milliseconds, or the integer column refuses the write',
          Number.isInteger(d.deadMs) && Number.isInteger(rec?.forMs) && Number.isInteger(rec?.wallMs) &&
            Number.isInteger(rec?.atMs),
          'test:deaf 2026-10-06 persisted no stall: dead_ms was sent as 82345.6');
      }
    } finally {
      Date.now = realNow;
    }
  }

  {
    const c = conn();
    elapsed = 5 * 60_000;
    priv.closeStall(c, true);
    check('closing a stall nobody opened does nothing',
      c.stallLog.length === 0 && c.deadMs === 0 && priv.budgetMs(c) === elapsed,
      'teardown always calls it, and most rounds never stall');
  }

  {
    const c = conn();
    elapsed = 60_000;
    c.deadMs = 10 * 60_000;
    check('the budget never runs backwards past zero', priv.budgetMs(c) === 0);
  }

  /**
   * A whole forty-minute round, two seconds at a time — the clock decides when
   * a round ENDS, and it was rewritten from fixed timeouts to a poll so that a
   * dead interviewer stops charging the candidate. Nothing else can sit
   * through forty minutes to check it.
   */
  const runRound = (durationMinutes: number, dead: (budgetMs: number) => number) => {
    const totalMs = durationMinutes * 60_000;
    const warnAt = Math.max(totalMs - 3 * 60_000, totalMs * 0.8);
    const notes: number[] = [];
    let nextNoteAt = 5 * 60_000;
    let lowTimeSent = false;
    let lowAt: number | null = null;
    let stoppedAt: number | null = null;

    for (let wall = 0; wall < totalMs * 3; wall += 2_000) {
      const budget = Math.max(0, wall - dead(wall));
      const due = clockDue(budget, { totalMs, warnAt, nextNoteAt, lowTimeSent });
      if (!due) continue;
      if (due.kind === 'stop') { stoppedAt = wall; break; }
      if (due.kind === 'low') { lowTimeSent = true; lowAt = wall; continue; }
      notes.push(due.atMs);
      nextNoteAt = due.nextNoteAt;
    }
    return { notes, lowAt, stoppedAt, warnAt, totalMs };
  };

  {
    const r = runRound(40, () => 0);
    check('a clean forty-minute round is told the time every five minutes',
      r.notes.join(',') === '300000,600000,900000,1200000,1500000,1800000,2100000',
      'seven notes, 5m to 35m — the low-time warning takes over at 37m');
    check('...told the low-time warning once, at the right moment',
      r.lowAt !== null && Math.abs(r.lowAt - r.warnAt) < 2_500,
      'three minutes out, as the fixed timer did');
    check('...and stopped thirty seconds past the planned end',
      r.stoppedAt !== null && Math.abs(r.stoppedAt - (r.totalMs + 30_000)) < 2_500,
      'identical to the timeouts this replaced, which is the point');
  }

  {
    // Unresponsive window to scale: four minutes starting at sixteen.
    const r = runRound(40, (wall) =>
      wall <= 16 * 60_000 ? 0 : Math.min(4 * 60_000, wall - 16 * 60_000));
    check('an outage does not spend the round',
      r.stoppedAt !== null && Math.abs(r.stoppedAt - (r.totalMs + 30_000 + 4 * 60_000)) < 2_500,
      'the round runs four minutes longer on the wall and the same in the candidate\'s hands');
    check('...and the clock notes still say true things',
      r.notes.join(',') === '300000,600000,900000,1200000,1500000,1800000,2100000',
      'a note that states a time the candidate has not had is the bug this exists to stop');
  }

  {
    const r = runRound(40, (wall) => (wall <= 60_000 ? 0 : wall - 60_000));
    check('a round dead from the first minute never closes itself',
      r.stoppedAt === null && r.lowAt === null,
      'the ladder and the banner deal with that; the clock must not call it finished');
  }

  /**
   * Outage windows reach the evaluator as facts so measured dead time
   * is not scored against the candidate.
   */
  const promptBase = {
    mode: 'dsa' as const,
    durationMinutes: 40,
    actualMinutes: 20,
    difficulty: 'standard' as const,
    transcript: [{ speaker: 'ai' as const, text: 'Go ahead and write your code.', startMs: 0 }],
    metrics: {
      totalSpeakingMs: 600_000, wordCount: 900, wordsPerMinute: 90,
      fillerCount: 12, fillerRate: 1.3, fillerBreakdown: { um: 12 },
      medianResponseLatencyMs: 1200, longestSilenceMs: 242_000,
      talkRatio: 0.95, meanTurnWords: 30,
    },
    referenceMaterial: '',
    writtenContext: null,
    hasAudio: false,
    verbatimTranscript: null,
    codeLanguage: 'python',
    assignedQuestions: [],
  };

  {
    // Dead air window from 982s to the end of a 1224s round.
    const withWindows = buildEvaluatorPrompt({
      ...promptBase,
      deadWindows: [{ atMs: 982_000, forMs: 242_000, recovered: false, opening: false }],
    });
    check('the dead window reaches the evaluator', /DEAD for 4m02s/.test(withWindows),
      'measured, next to the planned and actual lengths it is checked against');
    check('...with the minute it started at', /At 16m22s/.test(withWindows),
      'a window it cannot locate is a warning again, not a fact');
    check('...and that the interviewer never came back',
      /never spoke again/.test(withWindows));
    // Collapsed, because the prompt is hard-wrapped prose and a line break
    // falls inside this sentence.
    const flat = withWindows.replace(/\s+/g, ' ');
    check('it forbids scoring the silence as conduct',
      /must not be scored as a conduct, composure, concision or communication problem/
        .test(flat),
      'checking whether you are audible is the correct response to a dead line');

    const clean = buildEvaluatorPrompt({ ...promptBase, deadWindows: [] });
    check('a round that never stalled says nothing about stalls',
      !/DEAD for/.test(clean) && !/interviewer was DEAD/.test(clean),
      'an empty heading is a fact the evaluator will try to interpret');
    check('...and neither does one with no windows supplied at all',
      !/DEAD for/.test(buildEvaluatorPrompt({ ...promptBase })));
  }

  // A cut-short round is scored only on request, and its length alone reads as
  // a candidate who ran dry two minutes in. How it ended is a fact we hold.
  {
    const cut = (by: 'connection' | 'server') =>
      buildEvaluatorPrompt({ ...promptBase, actualMinutes: 2, cutShort: by }).replace(/\s+/g, ' ');
    const left = cut('connection');
    check('a cut-short round tells the evaluator so, and why',
      /This round was CUT SHORT: the candidate's connection dropped or they left the page, after 2 of the planned 40 minutes/.test(left)
        && /the server running the interview stopped/.test(cut('server')));
    check('...and forbids docking what the cut prevented',
      /do not mark the candidate down for any of them/.test(left));
    check('...in place of the "ended EARLY" note, not beside it',
      !/minutes EARLY/.test(left) && /minutes EARLY/.test(buildEvaluatorPrompt({ ...promptBase })));
    check('cutShortBy reads the end reason the gateway and the shutdown hook write',
      cutShortBy({ status: 'aborted', endReason: 'client_disconnected' }) === 'connection'
        && cutShortBy({ status: 'aborted', endReason: API_SHUTDOWN_REASON }) === 'server'
        && cutShortBy({ status: 'aborted', endReason: 'abandoned: the API stopped while this round was live' }) === 'server'
        && cutShortBy({ status: 'completed', endReason: 'time_up' }) === null);
  }
}

/* ── 16. code that does not work reaches the evaluator as a fact ──────────── */

function codeCheckFacts() {
  console.log('\n\x1b[1m16. whether the code works, as a finding\x1b[0m');

  /**
   * Code check findings must reach the evaluator prompt as concrete facts
   * with failing inputs so verified errors are not graded as solved.
   */
  const base = {
    mode: 'dsa' as const,
    durationMinutes: 30,
    actualMinutes: 30,
    difficulty: 'standard' as const,
    transcript: [{ speaker: 'ai' as const, text: 'Hello.', startMs: 0 }],
    metrics: {
      totalSpeakingMs: 600_000, wordCount: 900, wordsPerMinute: 90,
      fillerCount: 12, fillerRate: 1.3, fillerBreakdown: { um: 12 },
      medianResponseLatencyMs: 1200, longestSilenceMs: 8000,
      talkRatio: 0.55, meanTurnWords: 30,
    },
    referenceMaterial: '',
    writtenContext: 'Question 1 — Unique Paths:\n\ndef uniquePaths(m, n): return 0',
    hasAudio: false,
    verbatimTranscript: null,
    codeLanguage: 'python',
    assignedQuestions: [{ id: 'unique-paths', title: 'Unique Paths', difficulty: 'medium' }],
  };

  const broken = buildEvaluatorPrompt({
    ...base,
    codeChecks: [{
      questionId: 'unique-paths', title: 'Unique Paths', verdict: 'incorrect',
      failingInput: 'm = 1, n = 2', expected: '1', actual: '0',
      whatBreaks: 'The base case returns on i >= m-1 or j >= n-1, abandoning the last row.',
    }],
  } as never);

  check('the finding reaches the prompt', broken.includes('Whether the code works'));
  check('it carries the concrete failing input', broken.includes('m = 1, n = 2'),
    'a claim with an input in it can be checked by hand; "looks wrong" cannot');
  check('it carries expected and actual', broken.includes('requires 1') && broken.includes('gives 0'));
  check('it names what broke', broken.includes('abandoning the last row'));
  check('it says plainly that this blocks solved',
    broken.includes('does not work is **not `solved`**'),
    'the whole point — a described plan that was not implemented is partial');
  check('it warns that the interviewer never corrects anyone',
    broken.includes('silence is not agreement'),
    'otherwise the evaluator reads the interviewer moving on as a pass');
  check('it tells the evaluator it may OVERRULE the finding',
    broken.includes('you can overrule it') && broken.includes('score it `solved`'),
    'the check has a measured false-positive rate, and that costs a solved');

  // Correct code must not be described as a defect.
  const fine = buildEvaluatorPrompt({
    ...base,
    codeChecks: [{
      questionId: 'unique-paths', title: 'Unique Paths', verdict: 'correct',
      failingInput: null, expected: null, actual: null, whatBreaks: null,
    }],
  } as never);
  check('correct code is reported as correct', fine.includes('returns the right answer'));
  check('and carries no failing case', !fine.includes('does NOT work'));

  /**
   * No checks, no section. A concepts round has no editor, and a DSA round
   * whose checker was rate-limited has no findings — neither may leave the
   * evaluator reading an empty heading and inferring something from it.
   */
  const none = buildEvaluatorPrompt(base as never);
  check('no section at all when there is nothing to report',
    !none.includes('Whether the code works'),
    'an empty heading is a fact the evaluator will try to interpret');
}

/**
 * The retry after a whole-chain failure. It asked whether ANY model was
 * available — and a failed walk has just put every one on a cooldown, so the
 * answer was always no and a per-minute burst was never retried. Measured: 4
 * of 42 buffers audited six at a time came back unchecked, and every one
 * succeeded minutes later.
 */
async function codeCheckRetry() {
  console.log('\n\x1b[1m16b. retrying a code check the whole chain refused\x1b[0m');
  const reply = JSON.stringify({ trace: 't', verdict: 'correct', failingInput: null, expected: null, actual: null, whatBreaks: null });
  const run = async (quotaId: string, failPasses: number) => {
    const availability = new ModelAvailabilityService();
    (availability as never as { log: unknown }).log = { warn() {}, log() {} };
    const svc = new CodeCheckService({ GEMINI_API_KEY: 'test' } as never, availability);
    const priv = svc as never as { ai: unknown; wait: (ms: number) => Promise<void>; log: unknown };
    const waits: number[] = [];
    let calls = 0;
    const chainLength = MODELS.extractorChain.length;
    priv.log = { warn() {}, log() {}, error() {} };
    priv.wait = async (ms) => { waits.push(ms); };
    priv.ai = { models: { generateContent: async () => {
      calls++;
      if (calls <= failPasses * chainLength) {
        throw Object.assign(new Error(`429 RESOURCE_EXHAUSTED "quotaId": "${quotaId}"`), { status: 429 });
      }
      return { text: reply };
    } } };
    const out = await svc.check([{ id: 'p', title: 'P', prompt: 'Return 1.' }], { p: { code: 'return 1' } });
    return { out, waits, calls };
  };

  const burst = await run('GenerateRequestsPerMinutePerProjectPerModel', 1);
  check('a per-minute burst on every model is retried after a wait',
    burst.out.length === 1 && burst.waits.length === 1, `${burst.calls} calls, waits ${burst.waits.join()}ms`);

  const daily = await run('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 99);
  check('a daily cap on every model is NOT waited out',
    daily.out.length === 0 && daily.waits.length === 0, `${daily.calls} calls, ${daily.waits.length} waits`);
}

/* ── 15. the interviewer telling the candidate the time ───────────────────── */

/**
 * Premature sign-offs spoken when substantial round time remains.
 */
function clockClaims() {
  console.log('\n\x1b[1m15. the interviewer claiming the clock\x1b[0m');

  const invented = [
    "Thank you for walking me through that. We're out of time for this round, so we'll stop here. You'll receive feedback.",
    "Thank you for explaining that. We're out of time for this round, so we'll wrap up here.",
    "We're out of time for this round, so I'll leave the feedback for the report.",
    "We're almost out of time for this round.",
    "The round is scheduled for thirty minutes, and we're at that mark now.",
    // Spelled out, because the interviewer is told to say numbers as words —
    // a digits-only pattern misses every instance that actually occurs.
    "We have about two minutes left, so let's move on.",
    "We only have a couple of minutes, so keep it brief.",
    "There are five minutes remaining in this round.",
    "I think time is up, so let me stop you there.",
    "That's all the time we have for today.",
    "We're running over time, so a quick summary please.",
    // Curly apostrophes, as the transcriber emits them.
    'Time’s up.',
    'We’re almost out of time for this round.',
    "We've only got a few minutes, so let's be quick.",
    // A small quantity is a time-short claim even with no "left".
    "We've got a couple of minutes.",
    "There's about five minutes for this.",
  ];
  for (const turn of invented) {
    check(`caught: "${turn.slice(0, 44)}..."`, findClockClaim(turn, false) !== null,
      'the server had not said time was low, so this claim is invented');
  }

  check('the quote is the sentence, not the whole turn',
    findClockClaim(invented[0]!, false)?.quote.startsWith("We're out of time") === true);

  /**
   * Once the server HAS sent the low-time note the model is not merely allowed
   * to close the round, it has been told to. Firing here would correct it for
   * obeying.
   */
  for (const turn of invented) {
    check(`allowed once the server said so: "${turn.slice(0, 32)}..."`,
      findClockClaim(turn, true) === null);
  }

  /**
   * False positives matter more than misses here: a guard that fires on
   * ordinary interviewing corrects the model for doing its job, and every
   * correction is another injected note for it to imitate.
   */
  const legitimate = [
    "Let's wrap up this question and move on to the complexity.",
    "Good. Let's close out the discussion of the hash map and look at your get function.",
    "Take your time with that.",
    "What is the time complexity of your approach?",
    "Walk me through the time and space cost of that.",
    "In O of n log n time, or better?",
    "How long would that take to run on a million entries?",
    "Let me know when you're done and we can review it together.",
    "That's fine. Take a minute to think about it.",
    "We can come back to that later if there's time.",
    "The set operation runs in constant time.",
    "Your binary search cuts it to log n time.",
    // "a minute" without a remaining-time word is an invitation to think,
    // which is the opposite of a deadline.
    "Take a minute and think it through.",
    "Give it a minute before you answer.",
    "How many minutes would that job take at that throughput?",
    // The introduction the prompt used to ask for — "how long it runs" — states
    // the BOOKING, which is not a claim that time is short.
    'We have about forty minutes for this round.',
    "We've got thirty minutes today, two problems.",
    'This is a forty-five minute round with three problems.',
    "Hi, thanks for joining. I'm Alex, and this round covers two problems.",
    "At the end you'll get feedback in a written report.",
    'If the response time is over two hundred milliseconds, what do you do?',
    'So the loop runs n times over the array.',
    'We have fifteen minutes for each problem.',
  ];
  for (const turn of legitimate) {
    check(`not a clock claim: "${turn.slice(0, 44)}..."`, findClockClaim(turn, false) === null,
      'correcting the model for ordinary interviewing costs another injected note');
  }

  /* ── ending the round nobody cleared it to end ──────────────────────────── */
  console.log('\n\x1b[1m15b. closing a round that is not over\x1b[0m');

  /**
   * Early wrap-ups that assert no numbers or durations must still be detected
   * by premature close phrases.
   */
  const closes = [
    "Understood. Given the time, we'll need to stop there for today. Thanks for coming in, and you'll receive feedback soon.",
    'We do have more problems, but we need to conclude this round now. The feedback report will follow. Thank you again.',
    'I understand your perspective on the timing, but we must conclude the round now. Thank you again for your participation.',
    'Yes, I can hear you clearly. While the interview is concluding, I assure you there is no glitch in the session itself.',
    "I hear you, and I understand it might feel that way. However, I'm proceeding with closing the interview now.",
  ];
  // Closes HEAD caught and a narrower pattern set must not lose: the round as
  // the object, a sentence-final "stop here", and the sign-off forms.
  for (const turn of [
    'That brings us to the end of the interview.',
    "That's the end of the round.",
    "We'll stop here.",
    "We'll wrap up here.",
    "Thanks for your time, we'll end here.",
    "We'll need to stop there.",
    'We should conclude now.',
    "Let's close the session.",
    "I'm going to end the call here.",
    "Thank you for your time today, that's the end of our session.",
    'That concludes our interview.',
    'You will receive feedback soon.',
  ]) {
    check(`caught: "${turn.slice(0, 44)}"`, findFalseClose(turn, false) !== null);
  }
  check('a curly apostrophe does not hide the close',
    findFalseClose('Given the time, we’ll need to stop there for today.', false) !== null);
  for (const turn of closes) {
    check(`caught: "${turn.slice(0, 44)}..."`, findFalseClose(turn, false) !== null,
      'the round was seven minutes into forty');
    check(`...and the clock-CLAIM patterns miss it`, findClockClaim(turn, false) === null,
      'which is why this is a separate detector rather than more patterns');
  }

  /**
   * The authority property, and the whole reason this is decidable: once the
   * server has sent the low-time note, closing is precisely what the
   * interviewer was told to do.
   */
  check('nothing fires once the server has said time is low',
    closes.every((t) => findFalseClose(t, true) === null));

  /**
   * Closing a TOPIC is not closing the round, and this is where a careless
   * pattern would do real damage — "let's wrap up this question" is said
   * constantly in a healthy round.
   */
  const notClosing = [
    ...legitimate,
    "Let's wrap up this question and move on to question two.",
    'Okay, let me move on to the next part of the problem.',
    'Thanks for that explanation. What about the edge cases?',
    "That's all I wanted to ask about the prefix array. What about the suffix?",
    'Understood. Go ahead and start coding when you are ready.',
    // Stopping, ending and closing THINGS is technical speech. Every one of
    // these fired when a bare verb near "here" or "there" was enough.
    'Where would you stop the loop here?',
    'So we need to stop when left crosses right.',
    'We will end up with duplicates.',
    'What happens at the end of the array when there are no more elements?',
    'Should the recursion end there?',
    'How do you close the connection there?',
    'We should close the file handle.',
    'How do you close the session when the socket drops?',
    "Let's stop there for now and look at your code.",
    // What the sentence-final and subject-led patterns must leave alone.
    "Let's stop there and look at your code.",
    'If the pointer passes the end, do we stop there?',
    'We close the session when the user logs out.',
    "At the end of the interview, you'll get feedback in a report.",
    "That's the end of the array, so the loop exits.",
  ];
  for (const turn of notClosing) {
    check(`not a close: "${turn.slice(0, 44)}..."`, findFalseClose(turn, false) === null,
      'firing on ordinary interviewing would correct the model for doing its job');
  }
}

/* ── 19. a correction for a note nobody heard ─────────────────────────────── */

/**
 * Premature time-is-short notes caught with audio held do not need audible
 * spoken corrections if no spurious audio was played. Also ensures repeat
 * requests are honored rather than refused.
 */
async function unheardNoteCorrection() {
  console.log('\n\x1b[1m19. correcting a fabricated note the candidate never heard\x1b[0m');

  const make = () => {
    const notes: { text: string; heard: boolean }[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {},
        onSpuriousNote: (text, heard) => notes.push({ text, heard }),
      },
    );
    const priv = s as never as { handleMessage: (m: unknown) => void };
    return { notes, send: (m: unknown) => priv.handleMessage.call(s, m) };
  };
  const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAAAAAA' } }] } } };
  const text = (t: string) => ({ serverContent: { outputTranscription: { text: t } } });

  {
    // Audio arrives first and is held, followed by the note header.
    const { notes, send } = make();
    send(audio);
    send(text('[SYSTEM NOTE — not spoken by the candidate] Time is running low.'));
    send({ serverContent: { turnComplete: true } });
    check('a note caught while its audio was held is reported as UNHEARD',
      notes.length === 1 && notes[0]?.heard === false,
      'the held audio is dropped, so nothing reached the candidate');
  }

  {
    // Audio that outran the transcript past the hold deadline has PLAYED.
    const { notes, send } = make();
    send(audio);
    await sleep(500);
    send(text('[SYSTEM NOTE — not spoken by the candidate] Time is running low.'));
    check('a note caught after some of its audio played is reported as HEARD',
      notes.length === 1 && notes[0]?.heard === true,
      'AUDIO_HOLD_MAX_MS released it, so the candidate may have heard the start');
  }

  {
    // The mid-turn backstop: the turn opened as real speech and was delivered.
    const { notes, send } = make();
    send(audio);
    send(text('Okay, thanks for walking me through that, it all makes sense to me now.'));
    send(text(' [SYSTEM NOTE] Time is running low.'));
    check('a note mid-way through a delivered turn is reported as HEARD',
      notes.length === 1 && notes[0]?.heard === true);
  }

  {
    const fix = clockNoteCorrection({ heard: false, remainingMin: 25, plannedMin: 50 });
    check('an unheard clock note puts no banner on the candidate\'s screen', fix.banner === null,
      'a banner about a note they never heard is noise at best');
    check('...and the model is NOT told to say it misspoke',
      !/say briefly that you misspoke/i.test(fix.note) && /do NOT say you misspoke/.test(fix.note),
      '"I misspoke; there\'s plenty of time left", out of nowhere');
    check('...but it is still corrected, because the model believes its own note',
      /invented it/.test(fix.note) && /25 of this round's 50 minutes/.test(fix.note));
    check('...and told to answer what the candidate last said',
      /answer what the candidate last said/i.test(fix.note));

    const heard = clockNoteCorrection({ heard: true, remainingMin: 25, plannedMin: 50 });
    check('a HEARD clock note still gets the banner', heard.banner !== null);
    check('...and the on-air correction', /say briefly that you misspoke/.test(heard.note));
  }

  {
    const stamp = "SYSTEM NOTE: The candidate's code is not available. Time elapsed: 24 seconds.";
    check('a bare elapsed-time stamp is not a claim that time is short', !fabricatedNoteClaimsTimeShort(stamp),
      'elapsed-time stamp: "time" alone made it unrationed');
    for (const t of [
      'SYSTEM NOTE Time is running low. Finish this question and close the round.',
      'Pacing note: five minutes remain.',
      'Note: about 3 minutes left in the round.',
      'Timing note: wrap up the interview now.',
    ]) check(`still unrationed: "${t.slice(0, 44)}"`, fabricatedNoteClaimsTimeShort(t));

    const urgent: string[] = [];
    const client = { readyState: 1, send: () => {} };
    const gw = new InterviewGateway(
      {} as never, { elapsedMs: () => 24_000 } as never, {} as never, {} as never, {} as never, {} as never,
    );
    const conn: Record<string, unknown> = {
      sessionId: 'test-session', ending: false, plannedMs: 50 * 60_000, deadMs: 0, clockNotesDue: 0,
      stallOpen: null, lowTimeNoteSent: false, live: { sendUrgentNote: (t: string) => urgent.push(t) },
    };
    attachChecks(gw, client, conn);
    const priv = gw as never as { onSpuriousNote: (n: object, t: string, h: boolean) => void };
    for (let i = 0; i < 13; i++) priv.onSpuriousNote.call(gw, conn, stamp, false);
    check('thirteen elapsed-stamp fabrications draw only the rationed corrections',
      urgent.length === 2, `${urgent.length} corrections`);
    check('...none of which tells the model it wrote "time is running low"',
      !urgent.some((u) => /running low/.test(u)));
  }

  {
    const prompt = buildInterviewerPrompt({
      config: {
        mode: 'dsa', language: 'python', codeEditor: true,
        questionIds: ['sliding-window-maximum', 'two-sum-ii-input-array-is-sorted'],
      } as never,
      options: { durationMinutes: 50, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
      questions: [
        { id: 'sliding-window-maximum', title: 'Sliding Window Maximum', difficulty: 'Hard', prompt: 'Given an array...' },
        { id: 'two-sum-ii-input-array-is-sorted', title: 'Two Sum II', difficulty: 'Medium', prompt: 'Given a sorted array...' },
      ],
    });
    check('the DSA prompt tells the interviewer to repeat the problem when asked',
      /If they ask you to repeat the problem, repeat it/.test(prompt) &&
        /never refuse it/.test(prompt),
      '"I can\'t repeat the question"');
    check('...only the CURRENT problem, never a finished one',
      /CURRENTLY on/.test(prompt) && /Never read a FINISHED problem/.test(prompt));
  }
}

/* ── 20. a finished problem re-read, and a turn the candidate cut into ───── */

/**
 * Re-reads of earlier problems after finishing must be detected even when
 * followed by a candidate barge-in.
 */
function scopeRereadAndBargeIn() {
  console.log('\n\x1b[1m20. a finished problem re-read, and a turn the candidate cut into\x1b[0m');

  const questions = [
    {
      id: 'sliding-window-maximum',
      title: 'Sliding Window Maximum',
      prompt:
        'You are given an array of integers nums, there is a sliding window of size k which is ' +
        'moving from the very left of the array to the very right. You can only see the k ' +
        'numbers in the window. Each time the sliding window moves right by one position. ' +
        'Return the max sliding window.',
    },
    {
      id: 'two-sum-ii-input-array-is-sorted',
      title: 'Two Sum II - Input Array Is Sorted',
      prompt:
        'Given a 1-indexed array of integers numbers that is already sorted in non-decreasing ' +
        'order, find two numbers such that they add up to a specific target number. Let these ' +
        'two numbers be numbers[index 1 ] and numbers[index 2 ] where 1 <= index 1 < index 2 <= ' +
        'numbers.length. Return the indices of the two numbers index 1 and index 2, each ' +
        'incremented by one, as an integer array [index 1, index 2 ] of length 2. The tests are ' +
        'generated such that there is exactly one solution. You may not use the same element ' +
        'twice. Your solution must use only constant extra space.',
    },
  ];

  // Turn 74, verbatim.
  const REREAD =
    "Okay. Let's move on to question two. Given an array of integers nums, there is a sliding " +
    'window of size k which is moving from the very left of the array to the very right. You ' +
    'can only see the k numbers in the window. Each time the sliding window moves right by one ' +
    'position. Return the max sliding window. How would you approach that?';
  // Turn 45, verbatim: the legitimate first reading of question two.
  const Q2_FIRST =
    "Okay. Right, let's move on to question two. Given a 1 indexed array of integers numbers " +
    'that is already sorted in non decreasing order, find two numbers such that they add up to ' +
    'a specific target number. Return the indices of the two numbers index one and index two, ' +
    "each incremented by one. Your solution must use only constant extra space. What's your " +
    'approach for this one?';

  {
    const g = new QuestionScopeGuard(questions);
    check('the first reading of question two is left alone', g.observe(Q2_FIRST, 1) === null);
    const v = g.observe(REREAD, 1);
    check('a finished problem read out again is caught, however long its statement',
      v?.reason === 'restated_finished_problem' && v.question?.id === 'sliding-window-maximum',
      '"Return" is ~240 chars past "given"; the shape check stopped at 200');
  }

  {
    /**
     * Going back to a finished problem to go DEEPER is what the correction note
     * itself asks for, so it must never be corrected. Pair counts measured
     * against this round: 2, 5 (with the statement shape) and 3 — all under
     * `MIN_REREAD_HITS`, and far under the 35 of the real re-read.
     */
    const g = new QuestionScopeGuard(questions);
    g.observe(Q2_FIRST, 1);
    for (const [name, text] of [
      ['a reference back', 'Earlier, on the sliding window problem, you kept indices in a deque. ' +
        'Why indices rather than the values themselves?'],
      ['a constraint variation shaped like a statement', 'Going back to the sliding window: ' +
        'given a window of size k, what would you return if k were larger than the array?'],
      ['a follow-up that changes the problem', 'Suppose the sliding window could also move ' +
        'left by one position. How would your deque change?'],
    ] as const) {
      check(`${name} on a finished problem is not corrected`, g.observe(text, 1) === null);
    }
  }

  {
    // "Can you repeat the question once again?" is owed a straight re-read.
    const g = new QuestionScopeGuard(questions);
    g.observe(Q2_FIRST, 1);
    const onRequest =
      'Sure. Given a 1 indexed array of integers numbers that is already sorted in non ' +
      'decreasing order, find two numbers such that they add up to a specific target number. ' +
      'Return the indices of the two numbers, each incremented by one.';
    check('the current problem re-read on request is not corrected',
      g.observe(onRequest, 1) === null, 'only a re-read dressed as a move counts against it');
  }

  /* --- the barge-in ------------------------------------------------------- */

  check('nothing judged means the whole turn is judged', unjudgedTail('a b', 0) === 'a b');
  check('a judged head is not judged again', unjudgedTail('a b', 1) === 'b');
  check('a fully judged turn leaves nothing', unjudgedTail('a b', 3) === '');
  check('a stale marker past the buffer leaves nothing', unjudgedTail('a', 99) === '');

  {
    const gw = new InterviewGateway(
      {} as never, { elapsedMs: () => 1_490_000 } as never, {} as never, {} as never, {} as never, {} as never,
    );
    const notes: string[] = [];
    const client = {};
    const conn: Record<string, unknown> = {
      sessionId: 's', ending: false, plannedMs: 50 * 60_000, deadMs: 0, stallOpen: null,
      lowTimeNoteSent: false, clockNotesDue: 0,
      live: { sendFactNote: (t: string) => notes.push(t), sendUrgentNote: (t: string) => notes.push(t) },
    };
    const checks = attachChecks(gw, client, conn, { questions });
    checks.state.questions!.select(1);
    checks.scope!.guard.observe(Q2_FIRST, 1);
    checks.state.aiTurn = REREAD;

    checks.boundary('interrupted');
    check('a re-read the candidate cut into is corrected at the barge-in',
      notes.length === 1 && checks.scope!.corrected === 1,
      'it used to wait for a turnComplete a barged turn never sends');

    // The model carries on; the next boundary finds the same text at the head.
    checks.state.aiTurn = `${checks.state.aiTurn} Right, what else would you test?`;
    checks.boundary('turnComplete');
    check('...and not corrected a second time at the next turnComplete',
      notes.length === 1 && checks.scope!.corrected === 1);
    check('consuming the turn resets the marker',
      checks.state.aiTurn === '' && checks.state.aiTurnJudged === 0,
      'a marker left behind would blind the checks to the start of the next turn');
  }

  {
    /**
     * A first reading cut off by a barge-in, then restarted. The fragment is
     * judged at the barge-in, and if it counted as presented the restart would
     * be corrected as "you have already given it to them once".
     */
    const g = new QuestionScopeGuard(questions);
    const cut = Q2_FIRST.slice(0, Q2_FIRST.indexOf('Return'));
    const first = g.observe(cut, 1, { cutOff: true });
    const restart = g.observe(
      'So, moving on to question two. ' + Q2_FIRST.slice(Q2_FIRST.indexOf('Given')), 1);
    check('a first reading cut off by a barge-in is not corrected', first === null);
    check('...and its restart is not called a re-introduction', restart === null,
      restart ? `corrected as ${restart.reason}` : 'the restart is the first full reading');
  }
}

/* ── 21. what the microphone and the candidate's words say ───────────────── */

/**
 * Floor intent and voice activity pacing.
 * Prevents candidate dry-run speech from being misclassified as interviewer silence.
 */
function micAndFloor() {
  console.log('\n\x1b[1m21. what the microphone and the candidate\'s words say\x1b[0m');

  const SR = 16_000;
  /** `ms` of PCM at `db` dBFS: a tone for voice, noise for a room. */
  const pcm = (ms: number, db: number, tone = true) => {
    const n = Math.round((SR * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const amp = 10 ** (db / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const x = tone ? Math.sin(i * 0.07) : ((Math.sin(i * 12.9898) * 43758.5453) % 1) * Math.sqrt(3) / Math.SQRT2;
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x * amp)) * 32767), i * 2);
    }
    return buf;
  };
  /** Feeds a timeline of [ms, dB, tone?] pieces in 100ms chunks; returns the silences reported. */
  const feed = (v: VoiceActivity, plan: [number, number, boolean?][], start = 1_000_000) => {
    let t = start;
    const silences: { from: number; to: number }[] = [];
    for (const [ms, db, tone] of plan) {
      for (let done = 0; done < ms; done += 100) {
        t += 100;
        const g = v.observe(pcm(100, db, tone ?? true), t);
        if (g) silences.push(g);
      }
    }
    return { t, silences };
  };

  {
    const v = new VoiceActivity(SR);
    const { t } = feed(v, [[1_000, -120], [20_000, -49, false], [2_000, -20], [10_000, -49, false]]);
    check('a room at -49dB after a second of digital silence is not voice',
      t - v.lastVoiceAt >= 9_900,
      'opens on -120dB; floor that followed it down read the room as speech');
    check('...and speech over it is', v.voicedMs >= 1_800);
  }

  {
    const v = new VoiceActivity(SR);
    // Settle the floor, speak, then type: 60ms clicks every few seconds.
    const plan: [number, number, boolean?][] = [[5_000, -49, false], [2_000, -20]];
    for (let i = 0; i < 6; i++) plan.push([3_000, -49, false], [100, -25]);
    const before = feed(v, plan);
    check('keyboard clicks are not voice',
      before.t - v.lastVoiceAt >= 18_000,
      'short clicks reset the silence of a candidate waiting on a dead line');
  }

  {
    const v = new VoiceActivity(SR);
    const { silences } = feed(v, [[5_000, -49, false], [2_000, -20], [9_000, -49, false], [1_000, -20]]);
    // The first is the room before anyone spoke; the second is the one that counts.
    const between = silences.at(-1);
    check('a silence between two utterances is reported when voice resumes',
      silences.length === 2 && !!between && Math.abs(between.to - between.from - 9_000) <= 300,
      between ? `${between.to - between.from}ms` : 'none');
    check('...and the new utterance is timed from its start', v.utteranceMs >= 800 && v.utteranceMs <= 1_000);
  }

  {
    const v = new VoiceActivity(SR);
    // A fan switches on. The floor must follow it up rather than call it speech for ever.
    const { t } = feed(v, [[5_000, -55, false], [40_000, -40, false]]);
    check('a room that gets louder is re-learnt as a room', t - v.lastVoiceAt >= 15_000,
      'the floor rises one dB a second, which is slow against speech and fast against a fan');
  }

  /* --- the floor ------------------------------------------------------ */

  const floors: [string, string, string][] = [
    ['hold', 'Give me give me a moment to think about it. And summarize my thoughts. So I can explain you the approach.',
      'nudged into "Take your time. What are you thinking?"'],
    ['hold', 'Can you give me a moment?', 'a request for time phrased as a question is still one'],
    ['hold', 'Aya, I am just thinking through it once I am done. Will give you a proper steps explanation.',
      '"once I am done" promises a handback, it is not one'],
    ['yield', 'Let me think. Could you give me an example?', 'a question after a hold wins'],
    ['neutral', "Is two is greater than one? Yeah it is so I will pop it out and add two. Is minus one greater than two? No it isn't.",
      'a dry run asks itself questions; none is put to the interviewer'],
    ['yield', 'I am done. With my this question answer. Can you hear me? You are not responding just checking with you.',
      'candidate silence'],
    ['yield', "Could you give me an example that I can use to run through this code? Hello, I'm here. If you can hear me, please respond. That will let me know that you are hearing me and we can continue this discussion on question number three.",
      'the handback survives the sentence after it'],
    ['neutral', 'The time complexity of this solution is going to be O(n) and the space complexity will be O(k).',
      'an answer that does not hand back is narration'],
    // Self-talk in the words of a question or a request — none hands back.
    ['neutral', 'then I need a second pointer', '"a second" is a request for time only when it is one'],
    ['neutral', 'we can do a second pass over the array', ''],
    ['neutral', 'can I do better than n squared? yes with a heap', 'a question they answer themselves'],
    ['neutral', 'should I use a set here? probably a map', ''],
    ['neutral', "what would you return if the list is empty? you'd return null", 'generic "you" is narration'],
    ['neutral', 'do you see, the left pointer only moves right', ''],
    ['neutral', 'the server will respond with a 200', 'system design says "respond" constantly'],
    ['neutral', "okay I'm done with the base case, now the recursive step", 'done WITH something is progress'],
    ['neutral', 'this loop will give me the index of the max, now I write it', ''],
    ['yield', 'hello are you there? I did a second pass', 'a check-in beats narration after it'],
    ['yield', "I just wanted to know if I am audible or not as you doesn't seem to be responding.", 'candidate-checkin'],
    ['hold', 'Need need one minute just to think through my thoughts and then summarize it.', 'candidate-hold'],
    ['neutral', 'Also can you tell me the value range? From zero till what value it could be? Okay. So I came up with the approach what I will do is. I will keep track of the maximum jump I can make. And whenever the maximum jump that I can make exceeds the length of the array or becomes equal to it, that means we are able to reach it and we will return true.',
      'an ask forty words back is no longer being waited on'],
    ['yield', 'Also can you tell me the value range? From zero till what value it could be? Okay. So I came up with the approach.',
      '...but one a sentence back still is'],
    ['yield', "Can you hear me? It's been a long time since you responded so. Checking with you. Okay, maybe you are not able to hear me. Still let me state the solution I came up with. What I can do is I will check for new interval initial value with all intervals initial value in the array and if the new interval initial value is less than that current interval initial value that means we should add new interval.",
      'a check-in never lapses, however long they talk after it'],
    ['yield', "That's how I determine the time complexity. If you don't have any question I will start the coding it up.",
      'unmatched ask'],
    ['yield', 'Shall I go ahead and code it?', ''],
    ['hold', "I don't have any questions, let me start coding.", 'the later request for time wins'],
  ];
  for (const [want, text, why] of floors) {
    const got = classifyFloor(text);
    check(`floor ${want}: "${text.slice(0, 48)}…"`, got === want, got === want ? why : `read as ${got} — ${why}`);
  }
  {
    const long = 'Let me think. ' + 'and then the loop goes on to the next index and we compare it again '.repeat(3);
    check('a request for time lapses after thirty words of talk', classifyFloor(long) === 'neutral');
  }

  /* --- the session's use of both ----------------------------------------- */

  type Priv = {
    handleMessage: (m: unknown) => void;
    checkStall: () => void;
    everSpoke: boolean;
    awaitingReply: boolean;
    session?: unknown;
  };
  const session = () => {
    const sent: unknown[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {}, onStall: () => {},
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as Priv;
    priv.session = { sendClientContent: (p: unknown) => sent.push(p), sendRealtimeInput: () => {}, close: () => {} };
    return { s, priv, sent };
  };
  /** Runs `plan` (mic pieces, with optional transcripts or model output at their start) under a fake clock. */
  /** `model` is what the interviewer says at the step's start: true for "Take your time.". */
  type Step = { ms: number; db: number; tone?: boolean; say?: string; model?: boolean | string };
  const run = (steps: Step[]) => {
    const { s, priv, sent } = session();
    const realNow = Date.now;
    let cur = realNow();
    Date.now = () => cur;
    try {
      priv.handleMessage.call(s, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
      priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
      let tick = 0;
      for (const st of steps) {
        if (st.model) {
          const text = st.model === true ? 'Take your time.' : st.model;
          priv.handleMessage.call(s, { serverContent: { outputTranscription: { text } } });
          priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
        }
        if (st.say) priv.handleMessage.call(s, { serverContent: { inputTranscription: { text: st.say } } });
        for (let done = 0; done < st.ms; done += 100) {
          cur += 100;
          s.sendAudio(pcm(100, st.db, st.tone ?? true).toString('base64'));
          if ((tick += 100) % 2_000 === 0) priv.checkStall.call(s);
        }
      }
    } finally {
      Date.now = realNow;
    }
    return { sent, priv };
  };
  const ROOM = -49;

  {
    const r = run([
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 4_000, db: -20 },
      { ms: 90_000, db: ROOM, tone: false, say: 'Give me a moment to think it through and then I will walk you through my approach.', model: false },
    ]);
    check('a candidate thinking after "give me a moment" is never nudged', r.sent.length === 0);
  }

  {
    const r = run([
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 4_000, db: -20, say: 'Give me a moment to think it through.' },
      // "Take your time." — and then ninety seconds of thinking, with mutters.
      { ms: 30_000, db: ROOM, tone: false, model: true },
      { ms: 2_000, db: -25 },
      { ms: 30_000, db: ROOM, tone: false },
      { ms: 3_500, db: -25 },
      { ms: 30_000, db: ROOM, tone: false },
    ]);
    check('"take your time" does not end the request it grants',
      r.sent.length === 0, 'the hold carries past the acknowledgement and through the mutters');
  }

  {
    // Candidate hold followed by candidate talking.
    // and checks in for minutes whose transcript never arrives.
    const steps: Step[] = [
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 3_000, db: -20, say: "give me a second I'm just trying" },
      { ms: 2_000, db: ROOM, tone: false, model: true },
    ];
    for (let i = 0; i < 8; i++) steps.push({ ms: 4_000, db: -20 }, { ms: 12_000, db: ROOM, tone: false });
    const r = run(steps);
    check('...but talking again does, with or without a transcript', r.sent.length > 0,
      'fifteen seconds of speech since the hold ends it; a wedge may withhold the words');
  }

  {
    /**
     * A request for time belongs to ONE exchange. It used to survive every
     * later one: "give me a moment", "take your time", an answer, a question,
     * another answer — and then the interviewer died and nothing fired, because
     * the old words still read as a hold. Found in review, not in a round.
     */
    const r = run([
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 2_000, db: -20, say: 'Give me a moment to think.' },
      { ms: 10_000, db: ROOM, tone: false, model: true },
      { ms: 3_000, db: -20, say: 'Okay I would use a hash map to count.' },
      { ms: 3_000, db: ROOM, tone: false, model: 'Good. What is the time complexity?' },
      { ms: 2_000, db: -20, say: 'It is O of n.' },
      { ms: 120_000, db: ROOM, tone: false },
    ]);
    check('an old request for time does not outlive the exchange it belonged to',
      r.sent.length > 0, 'the interviewer asking something new ends it');
  }

  {
    /**
     * Interviewer floor grants: when the interviewer invites the candidate to think,
     * the floor is held for candidate reasoning before nudging.
     */
    const r = run([
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 3_000, db: -20, say: 'I have just not got a confirmation on how to proceed.' },
      { ms: 2_000, db: ROOM, tone: false, model: "I can't confirm that, but I'm here to listen to your approach when you're ready." },
      { ms: 1_500, db: -20, say: "I'm sure, let's find." },
      { ms: 60_000, db: ROOM, tone: false },
    ]);
    check('time the interviewer granted is not nudged either', r.sent.length === 0,
      'narration inside a hold does not end it');
  }

  {
    /**
     * A candidate asks for an example and the reply is a fabricated note the
     * gate drops before a byte is played. Output settles a debt on ARRIVAL, so
     * the note used to wipe it: owed a reply, and nothing watching for it.
     */
    const { s: sess, priv, sent } = session();
    const realNow = Date.now;
    let cur = realNow();
    Date.now = () => cur;
    const heard: boolean[] = [];
    (sess as never as { events: { onSpuriousNote: (t: string, h: boolean) => void } })
      .events.onSpuriousNote = (_t, h) => heard.push(h);
    try {
      priv.handleMessage.call(sess, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
      priv.handleMessage.call(sess, { serverContent: { turnComplete: true } });
      for (let t = 0; t < 30; t++) { cur += 100; sess.sendAudio(pcm(100, ROOM, false).toString('base64')); }
      for (let t = 0; t < 20; t++) { cur += 100; sess.sendAudio(pcm(100, -20).toString('base64')); }
      priv.handleMessage.call(sess, { serverContent: { inputTranscription: { text: 'Can you give me an example?' } } });
      cur += 500;
      // The note: audio first, held; then the text that condemns it.
      priv.handleMessage.call(sess, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAAAAAA' } }] } } });
      priv.handleMessage.call(sess, { serverContent: { outputTranscription: { text: '[SYSTEM NOTE] Time is running low.' } } });
      priv.handleMessage.call(sess, { serverContent: { turnComplete: true } });
      check('the dropped note is reported unheard', heard.length === 1 && heard[0] === false);
      check('...and the question it did not answer is still owed', priv.awaitingReply === true);
      for (let t = 0; t < 600; t++) {
        cur += 100;
        sess.sendAudio(pcm(100, ROOM, false).toString('base64'));
        if (t % 20 === 0) priv.checkStall.call(sess);
      }
      check('...and the ladder still climbs for it', sent.length > 0);
    } finally {
      Date.now = realNow;
    }
  }

  {
    // The wedge that also stalls transcription: speech, and no transcript at all.
    const r = run([
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 5_000, db: -20 },
      { ms: 40_000, db: ROOM, tone: false },
    ]);
    check('a sentence heard with no transcript still puts the interviewer in debt',
      r.priv.awaitingReply === true && r.sent.length > 0,
      'the transcript arrived late, together with the reply');
  }

  {
    const r = run([
      { ms: 3_000, db: ROOM, tone: false },
      { ms: 1_500, db: -25 },
      { ms: 40_000, db: ROOM, tone: false },
    ]);
    check('...but a mutter does not', r.priv.awaitingReply === false && r.sent.length === 0,
      'untranscribed pause while thinking');
  }
}

/* ── 22. replacing the upstream socket ────────────────────────────────────── */

/**
 * Every path that swaps the socket used to check `closing` only on entry and
 * trust whatever came back from its awaits: a round ended mid-reconnect could
 * be handed a fresh socket nobody would close, a replaced socket's late close
 * re-entered the resume path, and a reconnect that failed left the round
 * silently dead under a "Reconnected. Carry on." banner.
 */
async function socketReplacement() {
  console.log('\n\x1b[1m22. replacing the upstream socket\x1b[0m');

  type Cb = { onmessage: (m: unknown) => void; onclose: (e: { reason?: string }) => void };
  type Sock = { closed: boolean; sendClientContent: () => void; sendRealtimeInput: () => void; close: () => void };
  const make = (plan: ('ok' | 'fail' | 'hang')[], extra: { history?: () => Promise<never> } = {}) => {
    const callbacks: Cb[] = [];
    const sockets: Sock[] = [];
    const errors: boolean[] = [];
    const stalls: { remedy: string; stage: number }[] = [];
    let reconnected = 0;
    let release: (() => void) | undefined;
    const ai = {
      live: {
        connect: (req: { callbacks: Cb }) => {
          callbacks.push(req.callbacks);
          const step = plan.shift() ?? 'ok';
          const sock: Sock = {
            closed: false,
            sendClientContent: () => {},
            sendRealtimeInput: () => {},
            close: () => { sock.closed = true; },
          };
          sockets.push(sock);
          if (step === 'fail') return Promise.reject(new Error('connect refused'));
          if (step === 'hang') return new Promise<Sock>((r) => { release = () => r(sock); });
          return Promise.resolve(sock);
        },
      },
    };
    const s = new LiveInterviewSession(
      ai as never, 'test-model', { systemInstruction: '', voice: 'Charon', ...extra },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => { reconnected += 1; },
        onStall: (i) => stalls.push({ remedy: i.remedy, stage: i.stage }),
        onError: (_e, fatal) => errors.push(fatal), onClosed: () => {},
      },
    );
    const priv = s as never as {
      forceReconnect: (keep?: boolean) => Promise<void>;
      rebuild: () => Promise<void>;
    };
    return {
      s, priv, callbacks, sockets, errors, stalls,
      reconnected: () => reconnected,
      release: () => release?.(),
    };
  };
  const handle = { sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } };

  {
    const m = make(['hang']);
    const starting = m.s.start().then(() => 'opened', () => 'refused');
    m.s.close();
    m.release();
    check('a socket that finishes opening after close() is closed, not adopted',
      (await starting) === 'refused' && m.sockets[0]?.closed === true,
      'nothing else would ever close it, and it bills for the life of the process');
  }

  {
    const m = make(['ok', 'ok']);
    await m.s.start();
    m.callbacks[0]!.onmessage(handle);
    await m.priv.forceReconnect.call(m.s);
    check('a forced reconnect opens exactly one new socket', m.sockets.length === 2 && m.reconnected() === 1);
    m.callbacks[0]!.onclose({ reason: 'late close of the replaced socket' });
    await sleep(400);
    check('the replaced socket closing later does not trigger a resume',
      m.sockets.length === 2 && m.errors.length === 0,
      'its callbacks carry the generation they were opened under');
    m.callbacks[0]!.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    m.callbacks[0]!.onmessage({ serverContent: { turnComplete: true } });
    check('...and nothing it still says is listened to', m.s.hasSpoken === false);
    m.s.close();
  }

  {
    const m = make(['ok', 'fail', 'fail', 'ok']);
    await m.s.start();
    m.callbacks[0]!.onmessage(handle);
    m.callbacks[0]!.onclose({ reason: 'recycled' });
    await sleep(2_500);
    check('a dropped socket is resumed through failed attempts, not given up after one',
      m.reconnected() === 1 && m.sockets.length === 4 && m.errors.length === 0,
      `${m.sockets.length - 1} attempts, ${m.errors.length} fatal`);
    m.s.close();
  }

  {
    const m = make(['ok'], { history: async () => { throw new Error('db down'); } });
    await m.s.start();
    await m.priv.rebuild.call(m.s);
    check('a rebuild that cannot proceed says so rather than "carry on"',
      m.stalls.at(-1)?.remedy === 'unrecoverable' && m.reconnected() === 0,
      'the round used to continue silently dead');
    m.s.close();
  }

  {
    // Mid-round rung four with no handle: nothing to resume from, and it says so.
    const sent: unknown[] = [];
    const stalls: { remedy: string; stage: number }[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onStall: (i) => stalls.push({ remedy: i.remedy, stage: i.stage }),
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as { handleMessage: (m: unknown) => void; checkStall: () => void; session?: unknown };
    priv.session = { sendClientContent: (p: unknown) => sent.push(p), sendRealtimeInput: () => {}, close: () => {} };
    const realNow = Date.now;
    const base = realNow.call(Date);
    let cur = base;
    Date.now = () => cur;
    try {
      priv.handleMessage.call(s, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
      priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
      priv.handleMessage.call(s, { serverContent: { inputTranscription: { text: 'That is my answer.' } } });
      cur = base + 91_000;
      priv.checkStall.call(s);
    } finally {
      Date.now = realNow;
    }
    check('rung four with no handle reports that it did nothing',
      stalls.at(-1)?.stage === 4 && stalls.at(-1)?.remedy === 'none',
      'it used to report "forced reconnect", and the banner said "Reconnecting"');
  }
}

/* ── 23. the interview socket's own lifecycle ─────────────────────────────── */

async function gatewayLifecycle() {
  console.log('\n\x1b[1m23. the interview socket\'s own lifecycle\x1b[0m');

  const finalized: string[] = [];
  const statuses: string[] = [];
  let finalizeDelayMs = 0;
  const saved: (string | undefined)[] = [];
  let finalizeThrows = false;
  const modelsSet: string[] = [];
  const sessionSvc = {
    setModel: async (_id: string, model: string) => { modelsSet.push(model); },
    create: async () => ({
      id: 's1',
      questions: [{ id: 'two-sum', title: 'Two Sum', difficulty: 'Easy', prompt: '' }],
      systemInstruction: '', silenceDurationMs: 1400, prefixPaddingMs: 600,
    }),
    historyFor: async () => [],
    elapsedMs: () => 0,
    saveStalls: async () => {},
    saveResumptionHandle: async () => {},
    setAiSpeakingMs: async () => {},
    finalize: async (_id: string, reason: string, _audio?: string, status?: string) => {
      if (finalizeDelayMs) await sleep(finalizeDelayMs);
      finalized.push(reason);
      statuses.push(status ?? 'completed');
      if (finalizeThrows) throw new Error('db down');
      return { durationMs: 1, turnCount: 0 };
    },
    saveContext: async (_id: string, _k: string, _c: string, _l: string, qid?: string) => { saved.push(qid); },
    recordFragment: () => {},
    flush: async () => {},
    markInterrupted: async () => {},
  };
  const recorder = {
    begin: async () => {}, finalize: async () => ({}), abort: async () => {},
    append: () => {}, appendAi: () => {},
  };
  const lives: { closed: number }[] = [];
  let release: (() => void) | undefined;
  const gemini = {
    createInterviewSession: () => new Promise((r) => {
      release = () => {
        const live = {
          closed: 0, handle: undefined, modelId: 'fallback-model',
          close() { live.closed += 1; }, sendSnapshotNote() {}, noteCandidateWorking() {},
        };
        lives.push(live);
        r(live);
      };
    }),
  };
  const gw = new InterviewGateway(
    gemini as never, sessionSvc as never, recorder as never,
    { verifyToken: async () => ({ sub: 'u1' }) } as never,
    { enqueue: async () => 'started', roundOpened: () => {}, roundClosed: () => {} } as never,
    // A plain round carries nothing extra: no drill, no commitments, no loop.
    { prepare: async (_u: string, input: unknown) => ({ input, extras: {}, ready: {} }) } as never,
  );
  const priv = gw as never as { conns: WeakMap<object, unknown> };
  const client = () => {
    const out: { event: string; data: Record<string, unknown> }[] = [];
    return { out, readyState: 1, on: () => {}, close: () => {}, send: (raw: string) => out.push(JSON.parse(raw)) };
  };
  const connect = async (c: ReturnType<typeof client>) =>
    gw.handleConnection(c as never, { headers: { cookie: 'orvia_session=t' } } as never);
  const body = { config: { mode: 'behavioural', questionIds: ['two-sum'] }, options: {} };

  {
    const c = client();
    await connect(c);
    const starting = gw.onStart(c as never, body);
    await sleep(5);
    await gw.handleDisconnect(c as never);
    release?.();
    await starting;
    check('a candidate who leaves while the interviewer connects leaks no socket',
      lives[0]?.closed === 1 && !priv.conns.get(c),
      'the live session used to be attached, and its timers started, on a torn-down round');
    check('...and the round is finalized once, as abandoned',
      finalized.join(',') === 'client_disconnected', finalized.join(','));
  }

  {
    const c = client();
    await connect(c);
    const starting = gw.onStart(c as never, body);
    await sleep(5);
    release?.();
    await starting;
    const ready = c.out.find((x) => x.event === S2C.SessionReady);
    check('SessionReady names the model that actually connected',
      ready?.data.model === 'fallback-model', String(ready?.data.model));
    check('...and the session row records it, not the preferred model',
      modelsSet.join(',') === 'fallback-model', modelsSet.join(','));
    const clock = c.out.find((x) => x.event === S2C.Clock);
    check('the server clock is sent with SessionReady',
      !!clock && clock.data.remainingMs === 30 * 60_000 && clock.data.budgetMs === 0,
      JSON.stringify(clock?.data));

    await gw.onContext(c as never, { kind: 'code', content: 'x', questionId: 'not-this-round' });
    await gw.onContext(c as never, { kind: 'code', content: 'x', questionId: 'two-sum' });
    check('a one-question round refuses a question id that is not its own',
      saved[0] === undefined && saved[1] === 'two-sum', JSON.stringify(saved));

    finalizeThrows = true;
    await gw.onStop(c as never, {});
    check('a round whose finalize throws still ends for the browser',
      c.out.some((x) => x.event === S2C.SessionEnded) && !priv.conns.get(c),
      'otherwise the socket reports "session already running" for ever');
    finalizeThrows = false;
  }

  // SIGTERM mid-round on the test stack: Nest closed the socket, called
  // `handleDisconnect` without awaiting it, and ended the pool; the row stayed
  // `live` over headerless `.pcm`. The hook must FINISH the teardown — the
  // finalize here is slow, so a hook that only started it returns first.
  {
    const c = client();
    await connect(c);
    const starting = gw.onStart(c as never, body);
    await sleep(5);
    release?.();
    await starting;
    finalized.length = 0;
    statuses.length = 0;
    finalizeDelayMs = 30;
    await gw.beforeApplicationShutdown();
    const poolOpenAtReturn = finalized.length;
    finalizeDelayMs = 0;
    check('a shutdown finalizes the live round before its hook returns',
      poolOpenAtReturn === 1 && finalized[0] === API_SHUTDOWN_REASON && statuses[0] === 'aborted',
      JSON.stringify({ finalized, statuses }));
    const ended = c.out.find((x) => x.event === S2C.SessionEnded);
    check('...and the browser is sent the end screen, saying the API stopped',
      ended?.data.reason === API_SHUTDOWN_REASON, String(ended?.data.reason));
    await gw.handleDisconnect(c as never);
    check('...and the socket close that follows does not finalize it twice',
      finalized.length === 1, finalized.join(','));

    const late = client();
    await connect(late);
    await gw.onStart(late as never, body);
    check('no round starts once the API is stopping',
      !priv.conns.get(late) && late.out.some((x) => x.event === S2C.Error),
      'it would open after the hook and be torn down while the pool closes');
  }
}

/* ── 24. a wedge the candidate keeps checking in on ─────────────────────── */

/**
 * Stall recovery when a candidate repeatedly checks in during an outage.
 * Verifies that candidate check-ins do not prevent escalation and that
 * rebuilt sessions preserve valid state.
 */
async function f836Stalls() {
  console.log('\n\x1b[1m24. a wedge the candidate keeps checking in on\x1b[0m');

  check('the wall clock alone asks for nothing inside thirty seconds', yieldCeilingRung(29_999, 0) === 0);
  check('...reaches the reconnect at thirty seconds, once the free nudge has been tried',
    yieldCeilingRung(30_000, 1) === 4 && yieldCeilingRung(30_000, 0) === 1,
    'a candidate checking in can be short of the first rung\'s quiet, and the ladder never reorders');
  check('...and the rebuild at fifty, once the reconnect has been tried',
    yieldCeilingRung(50_000, 4) === 5 && yieldCeilingRung(55_000, 1) === 4,
    'it skips rungs; it never reorders them');

  const SR = 16_000;
  const pcm = (ms: number, db: number, tone = true) => {
    const n = Math.round((SR * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const amp = 10 ** (db / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const x = tone ? Math.sin(i * 0.07) : ((Math.sin(i * 12.9898) * 43758.5453) % 1) * Math.sqrt(3) / Math.SQRT2;
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x * amp)) * 32767), i * 2);
    }
    return buf.toString('base64');
  };
  const VOICE = pcm(100, -20);
  const ROOM = pcm(100, -49, false);

  type Step = { ms: number; voice?: boolean; say?: string; model?: string; typing?: boolean };
  const run = async (steps: Step[], opts: { resumeContext?: LiveOptions['resumeContext'] } = {}) => {
    const sockets: Record<string, unknown>[][] = [];
    const stalls: { stage: number; remedy: string; action: string; at: number }[] = [];
    const socket = () => {
      const out: Record<string, unknown>[] = [];
      sockets.push(out);
      return { sendClientContent: (p: Record<string, unknown>) => out.push(p), sendRealtimeInput: () => {}, close: () => {} };
    };
    const realNow = Date.now;
    const base = realNow.call(Date);
    let cur = base;
    const s = new LiveInterviewSession(
      { live: { connect: async () => socket() } } as never, 'test-model',
      {
        systemInstruction: '', voice: 'Charon',
        history: async () => [{ role: 'model' as const, text: 'What is your approach?' }],
        ...opts,
      },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {}, onGoAway: () => {}, onReconnected: () => {},
        onStall: (i) => stalls.push({ stage: i.stage, remedy: i.remedy, action: i.action, at: cur - base }),
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as { handleMessage: (m: unknown) => void; checkStall: () => void; session?: unknown };
    priv.session = socket();
    Date.now = () => cur;
    try {
      priv.handleMessage.call(s, { sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
      let t = 0;
      for (const st of steps) {
        if (st.model) {
          priv.handleMessage.call(s, {
            serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] }, outputTranscription: { text: st.model } },
          });
          priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
        }
        for (let done = 0; done < st.ms; done += 100) {
          cur += 100;
          t += 100;
          s.sendAudio(st.voice ? VOICE : ROOM);
          if (st.typing && done % 2_000 === 0) s.noteCandidateWorking();
          if (t % 2_000 === 0) {
            priv.checkStall.call(s);
            await sleep(1);
          }
        }
        if (st.say) priv.handleMessage.call(s, { serverContent: { inputTranscription: { text: st.say } } });
      }
    } finally {
      Date.now = realNow;
      s.close();
    }
    return { stalls, sockets };
  };

  {
    // Stall 6 at 2369s: a restatement that ends in a check-in, then a line of them.
    const opening: Step[] = [
      { ms: 3_000, model: 'Right, let us move on to question three. Insert the new interval and merge any overlaps.' },
      { ms: 10_000, voice: true, say: 'So I have been given an intervals array and a new interval. Is that right? Hello, can you hear me?' },
    ];
    const checkIns = (n: number): Step[] => {
      const out: Step[] = [];
      for (let i = 0; i < n; i++) out.push({ ms: 22_000 }, { ms: 2_500, voice: true, say: 'Can you hear me?' });
      return out;
    };
    const contexts: boolean[] = [];
    const r = await run([...opening, ...checkIns(6)], {
      resumeContext: ({ withCode }) => {
        contexts.push(withCode);
        return withCode ? 'You are on question 3 of 5. Their editor holds: def insert(): pass' : 'You are on question 3 of 5.';
      },
    });
    const yieldAt = 13_000;
    const reconnect = r.stalls.find((x) => x.remedy === 'reconnect');
    const rebuild = r.stalls.find((x) => x.remedy === 'rebuild');
    check('a candidate checking in on a dead line gets the reconnect within thirty seconds of asking',
      !!reconnect && reconnect.at - yieldAt <= 32_000,
      reconnect ? `at ${((reconnect.at - yieldAt) / 1000).toFixed(0)}s` : 'never');
    check('...and the rebuild within fifty seconds',
      !!rebuild && rebuild.at - yieldAt <= 54_000,
      rebuild ? `at ${((rebuild.at - yieldAt) / 1000).toFixed(0)}s` : 'never');
    check('...each marked as the wall clock\'s doing in what is persisted',
      /wall-clock ceiling/.test(reconnect?.action ?? '') && /wall-clock ceiling/.test(rebuild?.action ?? ''),
      reconnect?.action);
    check('...and in the ladder\'s order', !!reconnect && !!rebuild && reconnect.at < rebuild.at);

    const quiet = await run([...opening, { ms: 150_000 }]);
    const quietAt = quiet.stalls.find((x) => x.remedy === 'reconnect')?.at;
    check('the check-ins do not push the reconnect later than silence would',
      quietAt !== undefined && !!reconnect && reconnect.at - quietAt <= 2_000,
      `${((reconnect?.at ?? 0) / 1000).toFixed(0)}s with check-ins, ${((quietAt ?? 0) / 1000).toFixed(0)}s without`);

    const note = JSON.stringify(r.sockets[1] ?? []);
    check('the resumed socket is told where the round stands, without the code it already saw',
      /Where the round stands now/.test(note) && /question 3 of 5/.test(note) && !/def insert/.test(note) &&
        contexts[0] === false);
    const rebuilt = JSON.stringify(r.sockets[2] ?? []);
    check('the rebuilt socket is told that AND handed the editor',
      /SESSION RESUMED/.test(rebuilt) && /question 3 of 5/.test(rebuilt) && /def insert/.test(rebuilt) &&
        contexts[1] === true,
      'rebuilt with the spoken turns only, then moved question three on with no code');
  }

  {
    /**
     * 531-761s: an answer, a question in passing, then the loop written aloud,
     * pausing to type. The ask was read as a handback for all of it and the
     * pauses banked as a dead line.
     */
    const lines = [
      'Yeah, sure it does. So what I was thinking is from the current index I can go to at max that index after adding the current value.',
      'Also can you tell me the value range? From zero till what value it could be?',
      'Okay. So I came up with the approach what I will do is. I will keep track of the maximum jump I can make.',
      'And whenever the maximum jump that I can make exceeds the length of the array or becomes equal to it, then we will return true.',
      'So let me do that. Max jump equals to num zero. Now for i in range of len nums.',
      'Now I need to do max jump equals to max of max jump comma i plus nums i.',
      'Now if max jump becomes greater than equals to len nums minus one we return true.',
      'In your example we had two three one one four, so we have five elements and we need to reach the fourth index.',
      'And otherwise we are going to return false.',
    ];
    const steps: Step[] = [{ ms: 2_000, model: 'The input size can be up to ten to the fourth elements. Does that information affect your approach?' }];
    for (let k = 0; k < 3; k++) {
      for (const say of lines) steps.push({ ms: 6_000, voice: true, say }, { ms: 5_500, typing: true });
    }
    const r = await run(steps);
    check('a candidate writing their loop aloud after a passing question is not nudged',
      r.stalls.length === 0,
      r.stalls.length ? `fired rung ${r.stalls[0]!.stage} at ${(r.stalls[0]!.at / 1000).toFixed(0)}s` : 'logged silence as a dead interviewer');

    // Pauses banked while the ask stood, then they talk on past it: those
    // pauses were not waiting either, so one more ordinary pause is not a stall.
    const lapsed = await run([
      { ms: 2_000, model: 'What is your approach?' },
      { ms: 3_000, voice: true, say: 'Can you give me an example input?' },
      { ms: 7_000 }, { ms: 1_500, voice: true }, { ms: 7_000 }, { ms: 1_500, voice: true }, { ms: 7_000 },
      { ms: 8_000, voice: true, say: lines.slice(2, 6).join(' ') },
      { ms: 7_000 },
    ]);
    check('...and what was banked while the ask stood is spent when it lapses', lapsed.stalls.length === 0,
      lapsed.stalls.length ? `fired at ${(lapsed.stalls[0]!.at / 1000).toFixed(0)}s on 21s banked under a lapsed ask` : '');
  }

  {
    /**
     * Handback followed by silence: candidate stating they will code quietly
     * should not be nudged while working.
     */
    const r = await run([
      { ms: 2_000, model: 'Right. You can begin writing your code now.' },
      { ms: 4_000, voice: true, say: 'Okay. I am going to write this quietly for few minutes then I will walk you through the whole thing. Is that fine with you?' },
      { ms: 2_000, model: "That sounds good. Go ahead. I'll be watching your progress." },
      { ms: 4_000, voice: true },
      { ms: 70_000, typing: true },
    ]);
    check('an answer with no question in it ends the handback it answered', r.stalls.length === 0,
      r.stalls.length ? `fired at ${(r.stalls[0]!.at / 1000).toFixed(0)}s` : 'candidate was nudged');

    const hold = await run([
      { ms: 2_000, model: 'What is your approach?' },
      { ms: 3_000, voice: true, say: 'Give me a moment to think.' },
      { ms: 2_000, model: 'Sure.' },
      { ms: 4_000, voice: true },
      { ms: 70_000 },
    ]);
    check('...but leaves a request for time alone', hold.stalls.length === 0,
      '"Sure." after "give me a moment" is still their time');
  }

  {
    /**
     * Stalls following conversational handbacks must be caught and escalated promptly.
     */
    const restated = 'Let me restate the problem. So, I need to implement a class with two functions, add word and search word. ' +
      'In the search function the input can also have a dot, which can be any character. Is that right?';
    const s1 = await run([
      { ms: 3_000, model: 'Design a data structure that supports adding new words and finding if a string matches any previously added string.' },
      { ms: 30_000, voice: true, say: restated },
      { ms: 70_000 },
    ]);
    const r1 = s1.stalls.find((x) => x.remedy === 'reconnect');
    check('stall 1: a question to a dead line gets the reconnect within thirty seconds',
      !!r1 && r1.at - 33_000 <= 32_000,
      r1 ? `at ${((r1.at - 33_000) / 1000).toFixed(0)}s` : 'never');

    const handback = 'Here n is the word length. So whenever we add a word we go through each of the characters. ' +
      "That's how I determine the time complexity. If you don't have any question I will start the coding it up.";
    const mutter: Step[] = [];
    for (let i = 0; i < 6; i++) mutter.push({ ms: 4_000 }, { ms: 1_000, voice: true });
    const s2 = await run([
      { ms: 2_000, model: 'Understood. How did you arrive at those complexities?' },
      { ms: 20_000, voice: true, say: handback },
      { ms: 18_000 },
      ...mutter,
      { ms: 60_000, typing: true },
    ]);
    const r2 = s2.stalls.find((x) => x.remedy === 'reconnect');
    check('stall 2: "if you don\'t have any question" is a handback the wall clock times',
      !!r2 && r2.at - 22_000 <= 32_000,
      r2 ? `reconnect at ${((r2.at - 22_000) / 1000).toFixed(0)}s` : `first remedy: ${s2.stalls[0] ? `${s2.stalls[0].remedy} at ${((s2.stalls[0].at - 22_000) / 1000).toFixed(0)}s` : 'none'}`);
  }

  /* --- what a window costs ------------------------------------------------ */

  {
    const v = new VoiceActivity(SR);
    let t = 1_000_000;
    const feed = (ms: number, db: number, tone = true) => {
      for (let done = 0; done < ms; done += 100) {
        t += 100;
        v.observe(Buffer.from(pcm(100, db, tone), 'base64'), t);
      }
    };
    feed(5_000, -49, false);
    const from = t;
    feed(10_000, -20);
    feed(5_000, -49, false);
    const voiced = v.voicedBetween(from, t);
    check('the voice inside a window is measured off the microphone',
      Math.abs(voiced - 10_000) <= 300, `${voiced}ms of a 10s utterance`);
    check('...and only the part inside it', Math.abs(v.voicedBetween(from + 5_000, t) - 5_000) <= 300);
  }

  {
    let elapsed = 0;
    const gw = new InterviewGateway(
      {} as never, { elapsedMs: () => elapsed } as never, {} as never, {} as never, {} as never, {} as never,
    );
    const priv = gw as never as {
      budgetMs: (c: unknown) => number;
      closeStall: (c: unknown, recovered: boolean) => void;
      resumeContext: (c: unknown, q: { id: string; title: string }[], withCode: boolean) => string | undefined;
    };
    const realNow = Date.now;
    const base = realNow.call(Date);
    Date.now = () => base + 126_000;
    try {
      elapsed = 761_000;
      const c = {
        sessionId: 's', stallLog: [] as { forMs: number; wallMs?: number }[], deadMs: 0,
        stallOpen: { atMs: 635_000, startedAt: base, rung: 1, action: 'nudge', opening: false },
        live: { candidateVoicedMs: (f: number, to: number) => (f === base && to === base + 126_000 ? 110_000 : -1) },
      };
      check('an open window charges the budget only for the waiting in it',
        priv.budgetMs(c) === 761_000 - 16_000, `${priv.budgetMs(c)}ms`);
      priv.closeStall(c, true);
      check('closing it banks the wait, not the talk',
        c.deadMs === 16_000 && c.stallLog[0]?.forMs === 16_000 && c.stallLog[0]?.wallMs === 126_000,
        'refunded window while candidate was coding aloud');
    } finally {
      Date.now = realNow;
    }

    const questions = [
      { id: 'jump-game', title: 'Jump Game', prompt: '' },
      { id: 'insert-interval', title: 'Insert Interval', prompt: '' },
      { id: 'merge-intervals', title: 'Merge Intervals', prompt: '' },
    ];
    elapsed = 40 * 60_000;
    const conn: Record<string, unknown> = {
      sessionId: 's', stallOpen: null, deadMs: 10 * 60_000, plannedMs: 80 * 60_000,
    };
    const { state } = attachChecks(gw, {}, conn, {
      questions,
      starters: { 'insert-interval': ['class Solution:\n    def insert(self, intervals, newInterval):\n        '] },
    });
    state.questions!.select(1);
    state.codeByQuestion.set('jump-game', 'def canJump(): ...');
    const bare = priv.resumeContext(conn, questions, true) ?? '';
    check('a replaced socket is told which question it is on',
      /question 2 of 3, "Insert Interval"/.test(bare), bare.split('\n')[0]);
    check('...that it has no code yet, so is not finished',
      /not written any code/.test(bare) && !/canJump/.test(bare));
    check('...and the clock off the budget, not the wall',
      /30 of 80 minutes have passed, so about 50 minutes remain/.test(bare),
      'forty on the wall, ten of them dead');
    state.codeByQuestion.set('insert-interval', 'class Solution:\n    def insert(self, intervals, newInterval):\n        ');
    check('a buffer still holding only the starter counts as no code',
      /not written any code/.test(priv.resumeContext(conn, questions, true) ?? ''));
    state.codeByQuestion.set('insert-interval', 'def insert(self, intervals, newInterval):\n  res = []\n  return res');
    check('once there is code, the rebuild is handed it',
      /Their editor currently holds:\s+def insert/.test(priv.resumeContext(conn, questions, true) ?? ''));
    check('...and a resume, which saw it, is not',
      !/def insert|not written/.test(priv.resumeContext(conn, questions, false) ?? ''));
  }
}

/* ── 25. leaving early, closing early, describing unwritten code ─────────── */

/**
 * Edge cases: leaving early, closing early, and describing unwritten code.
 */
async function f836Flow() {
  console.log('\n\x1b[1m24. leaving early, closing early, describing unwritten code\x1b[0m');

  const QS = [
    { id: 'jump-game', title: 'Jump Game', prompt:
      'You are given an array of non-negative integers where each element represents your maximum ' +
      'jump length from that position. Starting at the first index, determine if you can reach the ' +
      'final index of the array.' },
    { id: 'partition-equal-subset-sum', title: 'Partition Equal Subset Sum', prompt:
      'Given an integer array nums, return true if you can partition the array into two subsets ' +
      'such that the sum of the elements in both subsets is equal or false otherwise.' },
    { id: 'insert-interval', title: 'Insert Interval', prompt:
      'You are given an array of non-overlapping intervals intervals where intervals[i] = [start i, ' +
      'end i ] represent the start and the end of the i^th interval and intervals is sorted in ' +
      'ascending order by start i. You are also given an interval newInterval = [start, end] that ' +
      'represents the start and end of another interval. Two intervals are considered overlapping ' +
      'if they share at least one point. Insert newInterval into intervals such that intervals is ' +
      'still sorted in ascending order by start i and intervals still does not have any overlapping ' +
      "intervals (merge overlapping intervals if necessary). Return intervals after the insertion. " +
      "Note that you don't need to modify intervals in-place. You can make a new array and return it." },
    { id: 'merge-intervals', title: 'Merge Intervals', prompt:
      'Given a list of intervals represented by start and end times, merge all overlapping intervals ' +
      'and return a list of non-overlapping intervals that cover the same overall ranges. Note that ' +
      'intervals touching at an endpoint, like one ending at four and another starting at four, are ' +
      'considered overlapping.' },
    { id: 'pacific-atlantic-water-flow', title: 'Pacific Atlantic Water Flow', prompt:
      "There is an m x n rectangular island that borders both the Pacific Ocean and Atlantic Ocean. " +
      "The Pacific Ocean touches the island's left and top edges, and the Atlantic Ocean touches the " +
      "island's right and bottom edges. The island is partitioned into a grid of square cells. You are " +
      'given an m x n integer matrix heights where heights[r][c] represents the height above sea level ' +
      'of the cell at coordinate (r, c). The island receives a lot of rain, and the rain water can flow ' +
      "to neighboring cells directly north, south, east, and west if the neighboring cell's height is " +
      "less than or equal to the current cell's height. Water can flow from any cell adjacent to an " +
      'ocean into the ocean. Return a 2D list of grid coordinates result where result[i] = [r i, c i ] ' +
      'denotes that rain water can flow from cell (r i, c i ) to both the Pacific and Atlantic oceans.' },
  ];

  const T10 = "Right now I haven't I don't have a clear approach. I'm just thinking through them.";
  const T11 =
    "Understood. Let's move on to question two. Given an integer array nums, return true if you can " +
    'partition the array into two subsets such that the sum of the elements in both subsets is ' +
    'equal, or false otherwise. What are your thoughts on this one?';
  const T28 =
    'I am done. Now with the solution but time complexity will be linear in time and space ' +
    'complexity will be constant in space.';
  const T30 = "We are iterating through the array only once. So that's why the time complexity is linear.";
  const T31 =
    "Understood. Right, let's move on to question two. Given an integer array nums, return true if " +
    'you can partition the array into two subsets such that the sum of the elements in both subsets ' +
    'is equal, or false otherwise. What are your initial thoughts on this';
  const T35 =
    "Right. Understood. Let's move on to question two. Given an integer array nums, return true if " +
    'you can partition the array into two subsets such that the sum of the elements in both subsets ' +
    "is equal, or false otherwise. What's your approach?";
  const T90 = 'Now 3 with 3 3 + 1 becomes 4 target return to immediately. Yeah I am done with this solution.';
  const T98 =
    'Create a new array by adding new intervals in the intervals. And then I will sort that new ' +
    'array. And after that I will run through that new array and create again a new array that ' +
    'will have a non overlapping with all intervals and then return it. Time complexity of the ' +
    'solution is n log n space. Complexity is. O of n.';
  const T100 = 'Because you are we are using one array to store the intervals.';
  const T127 = "Yeah, let's do it. Can you ask me the question four?";
  const T135 =
    'Yeah, after sorting the array of intervals. We already know that all of the start value of ' +
    'each interval is in sorted order. That means the main thing we will have to check is the end ' +
    'value. And the next interval start value to check if they are overlapping or not. Do you have ' +
    'any other question? I am almost done with my code. So if you have, I can clarify.';
  const T144 =
    "Right. We're about out of time, so let's wrap up here. Thanks for coming in today, and you'll " +
    'receive a feedback report from the team. Enjoy the rest of your day.';
  const T150 = "I see you've written the DFS function and the loops to call it. Can you explain";
  const T156 = "You've added a visited parameter to your DFS function. How do you plan to use that in your traversal?";
  const T166 =
    'Then again this and this and yeah I am that do you have any questions? Or we can wrap it up.';
  const T167 = 'Okay. Thanks for your time today. The feedback report will follow shortly.';
  const T184 =
    "Right, let's move on to question two. Given an integer array nums, return true if you can " +
    'partition the array into two subsets such that the sum of the elements in both subsets is ' +
    'equal, or false otherwise.';
  const T186 =
    'I misspoke, thank you for catching that. Time is running low, so we\'ll wrap things up here. ' +
    'Thank you for your time, and you can expect the feedback report shortly.';

  const INSERT_STARTER =
    'class Solution:\n    def insert(self, intervals: List[List[int]], newInterval: List[int]) -> List[List[int]]:\n        ';
  // 2509791, the only insert-interval buffer before the move at 2806s.
  const INSERT_AT_2806 =
    'class Solution:\n    def insert(self, intervals: List[List[int]], newInterval: List[int]) -> List[List[int]]:\n      ';
  const JUMP_FINAL =
    'class Solution:\n    def canJump(self, nums: List[int]) -> bool:\n      maxJump = 0\n\n' +
    '      for i in range(len(nums)):\n        if maxJump < i:\n          return False\n' +
    '        maxJump = max(maxJump, i+nums[i])\n        if maxJump >= (len(nums)-1):\n' +
    '          return True\n\n      return False ';
  const PAC_3927106 =
    'class Solution:\n    def pacificAtlantic(self, heights: List[List[int]]) -> List[List[int]]:\n      ';
  const PAC_4127571 =
    'class Solution:\n    def pacificAtlantic(self, heights: List[List[int]]) -> List[List[int]]:\n' +
    '      m, n = len(heights), len(heights[0])\n      atl, pac = set(), set()\n\n      def dfs()\n' +
    '      \n      for i in range(m):';
  const PAC_FINAL =
    'class Solution:\n    dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]]\n' +
    '    def pacificAtlantic(self, heights: List[List[int]]) -> List[List[int]]:\n' +
    '      m, n = len(heights), len(heights[0])\n      atl, pac = set(), set()\n\n' +
    '      def dfs(i, j, oce):\n        oce.add((i, j))\n\n        for dir in self.dirs:\n' +
    '          r, c = dir[0]+i, j+dir[1]\n          if r < 0 or c < 0 or r >=m or c >=n or ' +
    'heights[i][j] > heights[r][c] or (r, c) in oce:\n            continue\n          dfs(r, c, oce)\n' +
    '      for i in range(m):\n        dfs(i, 0, pac)\n        dfs(i, n-1, atl)\n';

  /* --- the pure decision ------------------------------------------------- */

  check('leaving question one on "I don\'t have a clear approach" is premature',
    prematureAdvance({ code: undefined, starters: [], sinceQuestion: T10, lastTurn: T10 }) === 'said_unfinished',
    'f836 turn 11, 357s');
  check('leaving question three with only its signature written is premature',
    prematureAdvance({
      code: INSERT_AT_2806, starters: [INSERT_STARTER], sinceQuestion: `${T98} ${T100}`, lastTurn: T100,
    }) === 'nothing_written',
    'f836 turn 101, 2806s');
  check('leaving question four on "I am almost done with my code" is premature',
    prematureAdvance({ code: JUMP_FINAL, starters: [], sinceQuestion: T135, lastTurn: T135 }) === 'said_unfinished',
    'f836 turn 136, 3682s — written code does not outrank what they said');
  check('"Yeah I am done with this solution" licenses the move',
    prematureAdvance({ code: undefined, starters: [], sinceQuestion: T90, lastTurn: T90 }) === false,
    'f836 turn 91');
  check('"Can you ask me the question four?" licenses the move',
    prematureAdvance({ code: INSERT_AT_2806, starters: [INSERT_STARTER], sinceQuestion: T127, lastTurn: T127 }) === false,
    'f836 turn 128');
  check('an "I am done" earlier on the same problem still licenses it',
    prematureAdvance({ code: JUMP_FINAL, starters: [], sinceQuestion: `${T28} ${T30}`, lastTurn: T30 }) === false,
    'f836 turn 31');
  check('real code and no word either way is left to the interviewer',
    prematureAdvance({ code: JUMP_FINAL, starters: [], sinceQuestion: T30, lastTurn: T30 }) === false);
  check('"the next one" in narration is not a request for the next problem',
    candidateSignal('then I compare its end with the next one and merge') === null);
  check('the starter skeleton alone is not work', codeUnstarted(INSERT_AT_2806, [INSERT_STARTER]));
  check('...nor is a signature with no starter to compare against', codeUnstarted(PAC_3927106, []));
  check('a written solution is work', !codeUnstarted(JUMP_FINAL, []));

  /* --- the gateway refusing the move -------------------------------------- */

  type Priv = {
    conns: WeakMap<object, Record<string, unknown>>;
    onLiveTranscript: (c: object, conn: unknown, t: { speaker: 'ai' | 'user'; text: string; final: boolean }) => void;
    onLiveBoundary: (c: object, how: 'turnComplete' | 'interrupted') => void;
  };
  let elapsed = 357_000;
  const makeRound = () => {
    const out: { event: string; data: Record<string, unknown> }[] = [];
    const urgent: string[] = [];
    const facts: string[] = [];
    const client = { readyState: 1, send: (raw: string) => out.push(JSON.parse(raw)) };
    const gw = new InterviewGateway(
      {} as never,
      { elapsedMs: () => elapsed, recordFragment: () => {}, setCurrentQuestion: async () => {} } as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    const priv = gw as never as Priv;
    const conn: Record<string, unknown> = {
      sessionId: 'f836', ending: false, plannedMs: 80 * 60_000, deadMs: 0, stallOpen: null,
      lowTimeNoteSent: false, clockNotesDue: 0,
      live: { sendUrgentNote: (t: string) => urgent.push(t), sendFactNote: (t: string) => facts.push(t) },
    };
    const checks = attachChecks(gw, client, conn, { questions: QS });
    priv.conns.set(client, conn);
    const user = (text: string) => priv.onLiveTranscript.call(gw, client, conn, { speaker: 'user', text, final: true });
    // Fragments of a few words, the way output transcription arrives.
    const ai = (text: string) => {
      const w = text.split(' ');
      for (let i = 0; i < w.length; i += 5) {
        priv.onLiveTranscript.call(gw, client, conn, { speaker: 'ai', text: w.slice(i, i + 5).join(' '), final: true });
      }
    };
    const boundary = (how: 'turnComplete' | 'interrupted') => priv.onLiveBoundary.call(gw, client, how);
    const tracker = checks.state.questions!;
    const moves = () => out.filter((x) => x.event === S2C.QuestionChanged);
    const log = () => checks.guardLog;
    return { gw, priv, client, conn, checks, out, urgent, facts, user, ai, boundary, tracker, moves, log };
  };

  {
    const r = makeRound();
    r.user(T10);
    r.ai(T11);
    check('the move off an unfinished question one is refused',
      r.tracker.index === 0 && r.moves().length === 0,
      `index ${r.tracker.index}, ${r.moves().length} QuestionChanged — the screen never moves`);
    check('...with one correction asking it to say so aloud',
      r.urgent.length === 1 && r.urgent[0]!.includes('NOT finished question 1') &&
        r.urgent[0]!.includes("I don't have a clear approach"),
      'later fragments of the same statement are held, not corrected again');
    check('...and it is on the guard log as corrected',
      r.log().length === 1 && r.log()[0]!.kind === 'premature_advance' && r.log()[0]!.corrected);
    r.boundary('interrupted');
    check('the refused statement is not left for the repeat guard',
      r.checks.state.aiTurn === '', 'its "what are your thoughts?" read as another ask about question one');

    // They finish, then the interviewer moves on for real.
    r.checks.state.codeByQuestion.set('jump-game', JUMP_FINAL);
    r.user(T28);
    r.ai(T31);
    r.boundary('turnComplete');
    check('once they say they are done, the same move goes through',
      r.tracker.index === 1 && r.moves().length === 1 && r.urgent.length === 1);
    check('...and its reading of question two is not corrected as a re-introduction',
      r.facts.length === 0 && r.checks.scope!.corrected === 0,
      'the refused reading was forgotten at its boundary — `forgetAfter`');
  }

  {
    const r = makeRound();
    r.user(T10);
    r.ai(T11);
    r.boundary('turnComplete');
    r.user('Okay.');
    r.ai(T11);
    check('a second attempt to leave the same problem goes through',
      r.tracker.index === 1 && r.urgent.length === 1,
      'corrected once per problem, not a tug of war the candidate can hear');
    check('...and is logged as uncorrected', r.log().length === 2 && r.log()[1]!.corrected === false);
  }

  {
    // A candidate who goes back by hand makes the next reading a first one.
    const g = new QuestionScopeGuard(QS);
    g.observe(T31, 1, { cutOff: true });
    check('a statement barged into on its closing words counts as delivered',
      g.observe(T35, 1)?.reason === 'reintroduced_current_problem',
      'f836 turns 31 then 35: the third reading of Partition counted as the first');
    const g2 = new QuestionScopeGuard(QS);
    g2.observe(T31, 1, { cutOff: true });
    g2.forgetAfter(0);
    check('...unless the round has gone back before it', g2.observe(T35, 1) === null);
  }

  /* --- closes ------------------------------------------------------------ */

  check('"Time is running low" is a clock claim',
    findClockClaim('Time is running low, so we will keep this short.', false) !== null, 'f836 turn 186');
  for (const s of [
    'The running time is low for small inputs.',
    'The time complexity is getting worse as n grows.',
  ]) check(`...but "${s}" is not`, findClockClaim(s, false) === null);
  check('a close straight after "or we can wrap it up" is the candidate\'s call',
    findFalseClose(T167, false, T166) === null && findFalseClose(T167, false) !== null, 'f836 4522s');
  for (const s of [
    'We can stop when the two pointers cross.',
    "Let's end up with a sorted array first.",
    'Yeah I am done with this solution.',
    "Let's move on to the next question.",
  ]) check(`"${s}" does not offer to end the round`, !candidateOfferedToEnd(s));
  check('"should we end the interview here?" does', candidateOfferedToEnd('Should we end the interview here?'));

  {
    const r = makeRound();
    elapsed = 4_019_000;
    const say = (turn: string, candidate = '') => {
      r.checks.state.aiTurn = turn;
      r.checks.state.aiTurnJudged = 0;
      r.checks.state.candidateTurn = candidate;
      r.checks.clock.judge();
    };
    for (let i = 0; i < 3; i++) say('We only have about two minutes left.');
    check('ordinary clock claims keep their allowance of two', r.urgent.length === 2);
    say(T144);
    say(T167, T166);
    const banners = r.out.filter((x) => x.event === S2C.SessionWarning).length;
    say(T186);
    check('a close past that allowance is still corrected',
      r.urgent.length === 4,
      'f836 ended on its third close, uncorrected, three seconds before the candidate stopped');
    check('the close the candidate asked for gets no correction and no banner',
      banners === 4 && r.log().filter((e) => e.kind === 'false_close').length === 2);
    check('every claim is on the guard log with whether it was answered',
      r.log().map((e) => `${e.kind}:${e.corrected}`).join(',') ===
        'clock_claim:true,clock_claim:true,clock_claim:false,false_close:true,false_close:true',
      r.log().map((e) => `${e.kind}:${e.corrected}`).join(','));
  }

  {
    const r = makeRound();
    elapsed = 4_677_000;
    r.tracker.select(4);
    r.checks.state.aiTurn = T184;
    r.checks.scope!.judge();
    check('re-reading a finished problem is still corrected', r.facts.length === 1);
    check('...and the correction no longer invites a close',
      !r.facts[0]!.includes('let the candidate lead') && r.facts[0]!.includes('never a reason to close'),
      'f836 turn 186 answered the old ending with "we\'ll wrap things up here"');
    check('...and it is logged as going backward', r.log()[0]?.kind === 'scope_backward');
  }

  {
    const r = makeRound();
    elapsed = 50 * 60_000;
    r.tracker.select(4);
    r.user('Yeah I am done with this solution.');
    r.boundary('turnComplete');
    r.user('I am done.');
    check('finishing the last problem early tells the interviewer the time left, once',
      r.facts.length === 1 && r.facts[0]!.includes('About 30 of') && r.facts[0]!.includes('never a reason to close'));
    const early = makeRound();
    early.user('Yeah I am done with this solution.');
    check('...and finishing an earlier one does not', early.facts.length === 0);
  }

  /* --- code that is not there -------------------------------------------- */

  check('"you\'ve written the DFS function" over an empty body is caught',
    findCodeClaim(T150, PAC_3927106)?.missing === 'dfs function', 'f836 4102s');
  check('"a visited parameter to your DFS function" over `def dfs()` is caught',
    findCodeClaim(T156, PAC_4127571)?.missing === 'parameter on dfs', 'f836 4168s');
  for (const [name, turn, code] of [
    ['the same claim once the function exists', T150, PAC_FINAL],
    ['a role word for a parameter named otherwise', T156, PAC_FINAL],
    ['a hypothetical', "Once you've written the DFS function, walk me through it.", PAC_3927106],
    ['a question', 'Have you written the helper function yet?', PAC_3927106],
    ['a structure written without its name', "You've added a hash set to track the sums.", 'seen = set()\nseen.add(0)'],
  ] as const) check(`${name} is not a code claim`, findCodeClaim(turn, code) === null);
  check('with no snapshot ever sent there is nothing to check', findCodeClaim(T150, undefined) === null);

  {
    const r = makeRound();
    r.tracker.select(4);
    r.checks.state.codeByQuestion.set('pacific-atlantic-water-flow', PAC_3927106);
    r.checks.state.aiTurn = T150;
    r.checks.code.judge();
    check('the gateway corrects it as a fact, never a reply request',
      r.facts.length === 1 && r.urgent.length === 0 && r.facts[0]!.includes('no dfs function'),
      'a reply requested now would talk over a candidate who is typing');
    check('...and logs it', r.log()[0]?.kind === 'code_claim');
  }

  {
    const prompt = buildInterviewerPrompt({
      config: { mode: 'dsa', language: 'python', codeEditor: true, questionIds: QS.map((q) => q.id) } as never,
      options: { durationMinutes: 80, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
      questions: QS.map((q) => ({ ...q, difficulty: 'Medium' })),
    } as never);
    check('the allowed acknowledgements no longer include moving on',
      !prompt.includes('"Right, let\'s move on."'));
    check('the prompt says leaving a problem is the candidate\'s call',
      prompt.includes('Move on only when the CANDIDATE is finished'));
  }
}

/* ── 25. a server that stopped hearing the microphone ───────────────────── */

/**
 * From 1520s the server transcribed nothing and answered only our text notes,
 * so every ladder rung "recovered"; its handle-resume restored the deaf
 * session and the one clean rebuild was already spent. Driven through
 * `sendAudio` and `handleMessage` under a stubbed clock, never private fields.
 */
async function deafServer() {
  console.log('\n\x1b[1m25. a server that stopped hearing the microphone\x1b[0m');

  const SR = 16_000;
  const tone = (ms: number, db: number) => {
    const n = Math.round((SR * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const amp = 10 ** (db / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i * 0.07) * amp * 32767), i * 2);
    return buf;
  };
  const room = (ms: number) => {
    const n = Math.round((SR * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const amp = 10 ** (-49 / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const x = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * Math.sqrt(3) / Math.SQRT2;
      buf.writeInt16LE(Math.round(x * amp * 32767), i * 2);
    }
    return buf;
  };

  /** One piece of the mic timeline; `heard` delivers a transcript at its start. */
  type Piece = { ms: number; voice?: boolean; heard?: boolean };
  const talk = (n: number, voiceMs: number, pauseMs: number, heard = false): Piece[] =>
    Array.from({ length: n }, () => [{ ms: voiceMs, voice: true }, { ms: pauseMs, heard }]).flat();

  /* --- the detector on its own ------------------------------------------- */

  const detect = (plan: Piece[], playbackEndsAt = 0) => {
    const v = new VoiceActivity(SR);
    const lv = new InputLiveness();
    let t = 1_000_000;
    let deafAt = 0;
    for (const p of [{ ms: 3_000 }, ...plan]) {
      if (p.heard) lv.heard(t + 2_000);
      for (let done = 0; done < p.ms; done += 100) {
        t += 100;
        const ended = v.observe(p.voice ? tone(100, -20) : room(100), t);
        const reading = { lastVoiceAt: v.lastVoiceAt, voicedBetween: (a: number, b: number) => v.voicedBetween(a, b) };
        if (ended) lv.observe(t, reading, playbackEndsAt, ended);
        if (t % 2_000 === 0 && lv.observe(t, reading, playbackEndsAt) && !deafAt) deafAt = t;
      }
    }
    return { lv, deafAt };
  };

  {
    const { deafAt } = detect(talk(12, 5_000, 4_000, true));
    check('a transcribed candidate who pauses is never deaf', deafAt === 0);
  }
  {
    const { deafAt, lv } = detect(talk(DEAF_MISSED_COMMITS, 5_000, 4_000).concat({ ms: DEAF_COMMIT_WAIT_MS }));
    check(`${DEAF_MISSED_COMMITS} untranscribed pauses in a row are deaf`, deafAt > 0,
      `missed ${lv.missedCommits}; healthy rounds reach two across 42 recorded ones`);
    check('...and the lost speech is measured', lv.missedVoiceMs >= DEAF_MISSED_COMMITS * 4_500,
      `${lv.missedVoiceMs}ms`);
  }
  {
    const { deafAt, lv } = detect(talk(DEAF_MISSED_COMMITS - 1, 5_000, 4_000).concat({ ms: DEAF_COMMIT_WAIT_MS }));
    check('one fewer is not', deafAt === 0 && lv.missedCommits === DEAF_MISSED_COMMITS - 1);
  }
  {
    const plan = [...talk(2, 5_000, 4_000), { ms: 5_000, voice: true }, { ms: 4_000, heard: true },
      ...talk(DEAF_MISSED_COMMITS - 1, 5_000, 4_000), { ms: DEAF_COMMIT_WAIT_MS }];
    check('a transcript that arrives resets the run', detect(plan).deafAt === 0,
      'only CONSECUTIVE misses count');
  }
  {
    // Dry run: continuous candidate speech with short pauses.
    const { deafAt, lv } = detect(talk(60, 1_400, 1_500).concat({ ms: 2_000 }));
    check('continuous talk with no pause the server would commit at is not deaf',
      deafAt === 0 && lv.missedCommits <= 1,
      'transcription went quiet while the candidate dry-ran and the server was healthy');
  }
  {
    const { deafAt } = detect(talk(12, 600, 4_000));
    check('coughs and "mm"s under a second do not count', deafAt === 0);
  }
  {
    const lv = new InputLiveness();
    const reading = { lastVoiceAt: 0, voicedBetween: () => 0 };
    const at = (ms: number) => 1_000_000 + ms;
    // Four missed points by hand, each five seconds of voice then silence.
    for (let i = 0; i < DEAF_MISSED_COMMITS - 1; i++) {
      const end = at(i * 20_000 + 5_000);
      lv.observe(end + 3_000, { lastVoiceAt: end, voicedBetween: () => 5_000 }, 0);
      lv.observe(end + DEAF_COMMIT_WAIT_MS, { lastVoiceAt: end, voicedBetween: () => 5_000 }, 0);
    }
    const before = lv.missedCommits;
    lv.resumed(at(70_000));
    check('a socket resumed from a handle keeps the count', lv.missedCommits === before && before > 0,
      'the handle-resume restored the deaf session');
    lv.reset(at(71_000));
    lv.observe(at(72_000), reading, 0);
    check('...a clean socket clears it', lv.missedCommits === 0);
  }

  /* --- the session's use of it ------------------------------------------- */

  type Priv = {
    handleMessage: (m: unknown) => void;
    checkStall: () => void;
    armStallWatchdog: () => void;
    rebuilt: boolean;
    session?: unknown;
  };
  const HISTORY = [
    { role: 'model' as const, text: 'The points array length is between one and one thousand.' },
  ];

  const run = async (plan: Piece[], opts: { history?: boolean; failover?: (m: string) => string | undefined } = { history: true }) => {
    const stalls: { stage: number; remedy: string; action: string; deaf?: boolean }[] = [];
    const sockets: Record<string, unknown>[][] = [];
    const audioIn: number[] = [];
    const configs: Record<string, unknown>[] = [];
    const models: string[] = [];
    const socket = () => {
      const out: Record<string, unknown>[] = [];
      const n = sockets.push(out) - 1;
      audioIn[n] = 0;
      return {
        sendClientContent: (p: Record<string, unknown>) => out.push(p),
        sendRealtimeInput: (p: { audio?: unknown }) => { if (p.audio) audioIn[n]! += 1; },
        close: () => {},
      };
    };
    const ai = {
      live: {
        connect: async (req: { model: string; config: Record<string, unknown> }) => {
          configs.push(req.config);
          models.push(req.model);
          return socket();
        },
      },
    };
    const s = new LiveInterviewSession(
      ai as never, 'deaf-model',
      {
        systemInstruction: '', voice: 'Charon',
        ...(opts.history ? { history: async () => HISTORY } : {}),
        ...(opts.failover ? { failover: opts.failover } : {}),
      },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {},
        onStall: (i) => stalls.push({ stage: i.stage, remedy: i.remedy, action: i.action, deaf: i.deaf }),
        onError: () => {}, onClosed: () => {},
      },
    );
    const priv = s as never as Priv;
    priv.session = socket();

    const realNow = Date.now;
    let cur = realNow();
    Date.now = () => cur;
    try {
      priv.armStallWatchdog.call(s);
      priv.handleMessage.call(s, { sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
      priv.handleMessage.call(s, {
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
          outputTranscription: { text: HISTORY[0]!.text },
          turnComplete: true,
        },
      });
      let tick = 0;
      for (const p of [{ ms: 3_000 }, ...plan]) {
        if (p.heard) priv.handleMessage.call(s, { serverContent: { inputTranscription: { text: 'so the approach is' } } });
        for (let done = 0; done < p.ms; done += 100) {
          cur += 100;
          s.sendAudio((p.voice ? tone(100, -20) : room(100)).toString('base64'));
          if ((tick += 100) % 2_000 === 0) {
            priv.checkStall.call(s);
            await sleep(0);
          }
        }
      }
    } finally {
      Date.now = realNow;
    }
    await sleep(5);
    return { stalls, sockets, audioIn, configs, models, priv, s };
  };

  const deafPlan = talk(DEAF_MISSED_COMMITS + 1, 5_000, 4_000).concat({ ms: DEAF_COMMIT_WAIT_MS + 2_000 });

  {
    const r = await run(deafPlan);
    const deaf = r.stalls.find((x) => x.deaf);
    check('a deaf server is caught mid-round', !!deaf, r.stalls.map((x) => x.action).join(' | ') || 'no stall');
    check('...and goes straight to a clean rebuild', deaf?.remedy === 'rebuild',
      'every other rung talks to the deaf session, and a model that answers text reads as recovered');
    check('...on a new socket', r.sockets.length === 2);
    check('...opened WITHOUT the resumption handle',
      (r.configs[0]?.sessionResumption as { handle?: string } | undefined)?.handle === undefined,
      'the handle-resume restored the deaf session');
    check('...without spending the wedge ladder\'s one rebuild', r.priv.rebuilt === false,
      'backlog was already exhausted');

    const turns = (r.sockets[1]?.[0]?.turns ?? []) as { parts: { text: string }[] }[];
    const instruction = turns.at(-1)?.parts[0]?.text ?? '';
    /**
     * Replays candidate audio from the backlog to a clean socket after
     * a deaf socket disconnect.
     */
    check('what was said into the deaf socket is replayed onto the clean one',
      (r.audioIn[1] ?? 0) >= 1, `${r.audioIn[1]} chunks so far (paced at 4x)`);
    check('the model is told the latest words follow as audio', /follow this note as audio/i.test(instruction));
    check('...and is not asked for a reply on top of them',
      r.sockets[1]?.[0]?.turnComplete === false && !/reply to the candidate's last message/i.test(instruction),
      'a requested reply would be answered and then barged into by the replay');
    check('...and still not to greet', /do NOT greet/i.test(instruction));

    const unheld = (r.priv as never as {
      resumeText: (o: { owed: boolean; missedVoiceMs?: number; audioFollows: boolean }) => string;
    }).resumeText.call(r.s, { owed: true, missedVoiceMs: 30_000, audioFollows: false });
    check('with nothing held to replay, the model is told it missed what the candidate said',
      /none of it\s+reached you/i.test(unheld));
    check('...and to ask for it again rather than answer a stale turn',
      /take you through it again/i.test(unheld) && !/reply to the candidate's last message/i.test(unheld));
  }

  {
    const marked: string[] = [];
    const r = await run(deafPlan, {
      history: true,
      failover: (m) => { marked.push(m); return 'hearing-model'; },
    });
    check('a deaf MODEL is reported, and the rebuild moves to another one',
      marked[0] === 'deaf-model' && r.models.at(-1) === 'hearing-model' && r.s.modelId === 'hearing-model',
      '2026-09-30: gemini-3.1-flash-live-preview ignored audio while the 2.5 fallback heard the same clip');
    check('...and says so in the persisted action', /on hearing-model \(deaf-model marked deaf\)/.test(
      r.stalls.find((x) => x.deaf)?.action ?? ''));
  }

  {
    const r = await run(deafPlan, { history: true, failover: () => undefined });
    check('with no other model, it still rebuilds on a clean socket of the same one',
      r.models.length === 1 && r.sockets.length === 2 && r.s.modelId === 'deaf-model',
      'connect is called on the new socket only; the first was stubbed in');
  }

  {
    const cfg = (model: string) =>
      (new LiveInterviewSession({} as never, model, { systemInstruction: '', voice: 'Charon' }, {} as never) as never as {
        buildConfig: () => { realtimeInputConfig: { automaticActivityDetection: Record<string, unknown> } };
      }).buildConfig().realtimeInputConfig.automaticActivityDetection;
    check('the fallback model is not configured deaf',
      !('startOfSpeechSensitivity' in cfg(LIVE_25)),
      '2.5 with START_SENSITIVITY_LOW missed a -19dB clip 3 of 3 times, and heard it 3 of 3 without');
    check('...while the primary keeps its low onset sensitivity',
      cfg(MODELS.interviewer).startOfSpeechSensitivity === 'START_SENSITIVITY_LOW',
      'a breath or a click must not barge in on the interviewer');

    // The ladder's first rung on a model that drops the socket on a bare turnComplete.
    const sent: Record<string, unknown>[] = [];
    const stalls: string[] = [];
    const s = new LiveInterviewSession({} as never, LIVE_25, { systemInstruction: '', voice: 'Charon' }, {
      onReady: () => {}, onAudio: () => {}, onTranscript: () => {}, onTurnComplete: () => {}, onInterrupted: () => {},
      onGoAway: () => {}, onReconnected: () => {}, onStall: (i) => stalls.push(i.action), onError: () => {}, onClosed: () => {},
    });
    const p = s as never as Priv;
    p.session = { sendClientContent: (c: Record<string, unknown>) => sent.push(c), sendRealtimeInput: () => {}, close: () => {} };
    const realNow = Date.now;
    const base = realNow();
    try {
      Date.now = () => base;
      p.armStallWatchdog.call(s);
      p.handleMessage.call(s, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] }, outputTranscription: { text: 'What is your approach?' }, turnComplete: true } });
      p.handleMessage.call(s, { serverContent: { inputTranscription: { text: 'a DFS. can you give me an example?' } } });
      Date.now = () => base + 26_000;
      p.checkStall.call(s);
    } finally {
      Date.now = realNow;
    }
    check('no bare turnComplete is sent to a model that closes the socket on one',
      !sent.some((c) => c.turnComplete && !c.turns) && /no silent nudge/.test(stalls[0] ?? ''),
      '2.5: "Request contains an invalid argument", and the ladder re-sent it at every rung-one stall');
  }

  {
    // 2.5's input transcript for "Hello my approach is to use a hash map", as the probe received it.
    const pieces = [' He', 'llo', ' my', ' app', 'roach', ' is', ' to', ' use', ' ', 'a ha', 'sh', ' map'];
    const said = (model: string) => {
      const got: string[] = [];
      const s = new LiveInterviewSession({} as never, model, { systemInstruction: '', voice: 'Charon' }, {
        onReady: () => {}, onAudio: () => {}, onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => {}, onError: () => {}, onClosed: () => {},
        onTranscript: (t) => { if (t.speaker === 'user') got.push(t.text); },
      });
      const p = s as never as Priv;
      for (const text of pieces) p.handleMessage.call(s, { serverContent: { inputTranscription: { text } } });
      p.handleMessage.call(s, { serverContent: { turnComplete: true } });
      return got;
    };
    const glued = said(LIVE_25);
    check('the fallback\'s sub-word pieces reach consumers as whole words',
      glued.join(' ') === 'Hello my approach is to use a hash map',
      `"${glued.join(' ')}" — stored as "du plica te" before`);
    check('...and the primary\'s fragments pass through untouched', said(MODELS.interviewer).length === pieces.length);
  }

  {
    const a = new ModelAvailabilityService();
    a.noteDeaf('m1');
    check('a deaf model is skipped by new rounds', !a.isAvailable('m1') && a.order(['m1', 'm2'])[0] === 'm2');
    a.noteSuccess('m1');
    check('...even after it connects, which a deaf model does fine', !a.isAvailable('m1'));
    check('...and /api/health says why', a.status()[0]?.reason === 'not hearing audio');
  }

  {
    const r = await run(talk(20, 5_000, 4_000, true));
    check('a transcribed round is never rebuilt', r.sockets.length === 1 && !r.stalls.some((x) => x.deaf));
  }

  {
    const again = deafPlan.concat(deafPlan, deafPlan, deafPlan);
    const r = await run(again);
    const deaf = r.stalls.filter((x) => x.deaf);
    const rebuilds = deaf.filter((x) => x.remedy === 'rebuild').length;
    check('deaf rebuilds are capped', rebuilds === 2 && r.sockets.length === 3, `${rebuilds} rebuilds, ${r.sockets.length} sockets`);
    check('...and then the candidate is told, once', deaf.filter((x) => x.remedy === 'unrecoverable').length === 1);
  }

  {
    const r = await run(deafPlan, { history: false });
    check('a session with no round to rebuild does not use it', !r.stalls.some((x) => x.deaf),
      'the coach and mentor keep the ordinary ladder');
  }

  const EVAL_BASE = {
    mode: 'dsa' as const,
    durationMinutes: 40,
    actualMinutes: 35,
    difficulty: 'standard' as const,
    transcript: [{ speaker: 'ai' as const, text: 'Does that provide what you need?', startMs: 1_500_000 }],
    metrics: {
      totalSpeakingMs: 600_000, wordCount: 900, wordsPerMinute: 90,
      fillerCount: 12, fillerRate: 1.3, fillerBreakdown: { um: 12 },
      medianResponseLatencyMs: 1200, longestSilenceMs: 60_000,
      talkRatio: 0.6, meanTurnWords: 30,
    },
    referenceMaterial: '',
    writtenContext: null,
    hasAudio: false,
    verbatimTranscript: null,
    codeLanguage: 'python',
    assignedQuestions: [],
  };
  {
    const prompt = buildEvaluatorPrompt({
      ...EVAL_BASE,
      deadWindows: [{ atMs: 1_520_000, forMs: 563_000, recovered: false, opening: false, deaf: true }],
    });
    check('the evaluator is told a deaf window\'s speech is missing, not absent',
      /MISSING from the transcript/.test(prompt) && /unassessed, not\s+unsolved/.test(prompt));
    const plain = buildEvaluatorPrompt({
      ...EVAL_BASE,
      deadWindows: [{ atMs: 1_520_000, forMs: 63_000, recovered: true, opening: false }],
    });
    check('...and an ordinary dead window is not', !/MISSING from the transcript/.test(plain));
  }
}

/* ── 26. drills, commitments, loops and styles reach the round correctly ──── */

/**
 * The interviewer is handed a drill's QUESTION and nothing about how it went,
 * a style changes what is probed and nothing for `general`, and the gateway
 * runs what `RoundPracticeService.prepare` resolved rather than what the
 * client sent — a drill's config is rebuilt server-side.
 */
async function practiceRounds() {
  console.log('\n\x1b[1m26. drills, commitments, loops and interviewer styles\x1b[0m');

  const QS = [{ id: 'two-sum', title: 'Two Sum', difficulty: 'Easy', prompt: 'Return the indices of two numbers adding to target.' }];
  const cfg = { mode: 'dsa', language: 'python', codeEditor: true, questionIds: ['two-sum'] } as never;
  const opts = { durationMinutes: 30, difficulty: 'standard', persona: 'neutral', voice: 'Charon' } as const;
  const build = (options: object, drill?: { question: string; narrowed: boolean }) =>
    buildInterviewerPrompt({ config: cfg, options: { ...opts, ...options }, questions: QS, drill } as never);

  const none = build({});
  check('a round with no style is byte-identical to one styled general',
    none === build({ style: 'general' }), 'rounds recorded before styles keep their exact instruction');
  check('...and says nothing about a loop style', !none.includes('Style of the loop'));
  const amazon = build({ style: 'amazon' });
  check('an Amazon round probes the leadership principles', amazon.includes('Leadership Principles'));
  check('...and is told never to name one as a hint', amazon.includes('Never name a principle to the candidate'));
  check('every style is its own instruction',
    new Set(['amazon', 'google', 'meta', 'startup'].map((st) => build({ style: st }))).size === 4);

  const retried = 'Walk me through the time and space complexity of your approach.';
  const drill = build({}, { question: retried, narrowed: false });
  check('a drill puts exactly the retried question', drill.includes(retried) && drill.includes('ONLY this one question'));
  check('...opens by saying it is a short single-question round, not with a full introduction',
    drill.includes('short round on a single question') && !drill.includes('Start now with your introduction'));
  check('...and forbids implying an earlier attempt', drill.includes('Do not say or imply that they have answered it before'));
  const narrowed = build({}, { question: retried, narrowed: true });
  check('a narrowed drill points at the one question left in the list', narrowed.includes('narrowed to the single question'));
  check('a round that is not a drill has no drill section', !none.includes('focused round on ONE question'));

  /* The gateway: what `prepare` resolved is what runs. */
  const created: unknown[][] = [];
  const sessionSvc = {
    setModel: async () => {},
    create: async (...args: unknown[]) => {
      created.push(args);
      return {
        id: 'd1', questions: [{ id: 'two-sum', title: 'Two Sum', difficulty: 'Easy', prompt: '' }],
        systemInstruction: '', silenceDurationMs: 1400, prefixPaddingMs: 600,
      };
    },
    historyFor: async () => [], elapsedMs: () => 0, saveStalls: async () => {},
    saveResumptionHandle: async () => {}, setAiSpeakingMs: async () => {},
    finalize: async () => ({ durationMs: 1, turnCount: 0 }), saveContext: async () => {},
    recordFragment: () => {}, flush: async () => {}, markInterrupted: async () => {},
  };
  const recorder = { begin: async () => {}, finalize: async () => ({}), abort: async () => {}, append: () => {}, appendAi: () => {} };
  const gemini = {
    createInterviewSession: async () => ({
      handle: undefined, modelId: MODELS.interviewer, close() {}, sendSnapshotNote() {}, noteCandidateWorking() {},
    }),
  };
  const focus = [{ key: 'drill:1', text: 'Name the complexity before coding', source: 'drill' }];
  const resolved = {
    config: { mode: 'dsa', questionIds: ['two-sum'], codeEditor: true, language: 'python' },
    options: { ...opts, durationMinutes: 15 },
  };
  const practice = {
    prepare: async () => ({
      input: resolved,
      extras: { focus, drill: { record: { question: retried }, narrowed: true } },
      ready: { focus, drill: { label: 'Two Sum', question: retried, advice: 'x', beforeScore: 4, outOf: 10 } },
    }),
  };
  const gw = new InterviewGateway(
    gemini as never, sessionSvc as never, recorder as never,
    { verifyToken: async () => ({ sub: 'u1' }) } as never, { enqueue: async () => 'started', roundOpened: () => {}, roundClosed: () => {} } as never, practice as never,
  );
  const out: { event: string; data: Record<string, unknown> }[] = [];
  const c = { readyState: 1, on: () => {}, close: () => {}, send: (raw: string) => out.push(JSON.parse(raw)) };
  await gw.handleConnection(c as never, { headers: { cookie: 'orvia_session=t' } } as never);
  // The CLIENT asks for a 90-minute round of a different problem; the drill it names wins.
  await gw.onStart(c as never, {
    config: { mode: 'dsa', questionIds: ['lru-cache'], codeEditor: true, language: 'python' },
    options: { durationMinutes: 90 },
    drill: { sessionId: '00000000-0000-4000-8000-000000000000', momentId: 'q:1' },
  });
  const ready = out.find((x) => x.event === S2C.SessionReady);
  check('the round runs the setup the server resolved, not the one the client sent',
    ready?.data.durationMinutes === 15 &&
      JSON.stringify((created[0]?.[1] as { config: { questionIds: string[] } }).config.questionIds) === '["two-sum"]',
    `${ready?.data.durationMinutes} min`);
  check('...and the session is created with the drill and its focus',
    !!(created[0]?.[3] as { drill?: unknown }).drill && (created[0]?.[3] as { focus: unknown[] }).focus.length === 1);
  check('SessionReady tells the screen what the round is working on',
    JSON.stringify(ready?.data.focus) === JSON.stringify(focus) &&
      (ready?.data.drill as { beforeScore?: number } | undefined)?.beforeScore === 4);
  // Ended, or its clock and opening timers keep the suite alive for ever.
  await gw.onStop(c as never, {});

  const refused = new InterviewGateway(
    gemini as never, sessionSvc as never, recorder as never,
    { verifyToken: async () => ({ sub: 'u1' }) } as never, { enqueue: async () => 'started', roundOpened: () => {}, roundClosed: () => {} } as never,
    { prepare: async () => { throw new Error('The next round of this loop is System design, not DSA.'); } } as never,
  );
  const out2: { event: string; data: Record<string, unknown> }[] = [];
  const c2 = { readyState: 1, on: () => {}, close: () => {}, send: (raw: string) => out2.push(JSON.parse(raw)) };
  await refused.handleConnection(c2 as never, { headers: { cookie: 'orvia_session=t' } } as never);
  const before = created.length;
  await refused.onStart(c2 as never, { config: resolved.config, options: {} });
  const err = out2.find((x) => x.event === S2C.Error);
  check('a round prepare refuses never creates a session, and says why',
    created.length === before && err?.data.fatal === true && String(err?.data.message).includes('next round of this loop'),
    String(err?.data.message));
}

/* ── 27. a database behind the code is refused at boot ────────────────────── */

function schemaCheck() {
  console.log('\n\x1b[1m27. a database behind the code\x1b[0m');
  const expected = expectedColumns();
  check('the expected columns are read from the schema itself',
    expected.includes('sessions.kind') && expected.includes('profiles.target_company') && expected.includes('focus_checks.key'),
    `${expected.length} columns`);
  const behind = expected.filter((c) => c !== 'sessions.kind' && c !== 'profiles.target_company');
  check('a missing column is named', JSON.stringify(schemaDrift(expected, behind)) === '["profiles.target_company","sessions.kind"]');
  check('a column the database has and the code does not is not drift',
    schemaDrift(expected, [...expected, 'sessions.legacy_note']).length === 0);
}

/* ── 28. a session the server refuses, and one kept small enough that it does not ── */

/**
 * Context window management and refusal handling.
 * Bounds accumulated token size and restores sessions with text transcripts
 * when large audio contexts cause upstream refusal.
 */
async function upstreamBudget() {
  console.log('\n\x1b[1m28. a session the server refuses, and one kept small enough that it does not\x1b[0m');

  check('a 1011 close is a refusal', classifyClose(1011, '', false) === 'refused');
  check('...and so is the wording, whatever the code',
    classifyClose(undefined, 'Internal error encountered.', false) === 'refused' &&
      classifyClose(1006, 'Resource has been exhausted (e.g. check quota).', false) === 'refused');
  check('a clean close is the server recycling the socket', classifyClose(1000, '', false) === 'handover');
  check('an abnormal close is a drop, unless a goAway announced it',
    classifyClose(1006, '', false) === 'dropped' && classifyClose(1006, '', true) === 'handover');

  const b = liveModelQuirks(LIVE_31).contextBudget;
  check('3.1 renews well short of where the probes were refused', b.renewAt === 20_000 && b.renewAtHandover === 12_000,
    `${b.renewAt} / ${b.renewAtHandover}; refusals began past ~25k`);
  check('3.8 renews no later than 3.1, inside the 29k it ran to unrefused',
    liveModelQuirks('gemini-3.8-live').contextBudget.renewAt <= b.renewAt);
  check('every model in the interviewer chain has its own quirks entry, not the primary\'s by default',
    new Set(MODELS.interviewerChain.map((m) => liveModelQuirks(m))).size === MODELS.interviewerChain.length);
  check('below the budget nothing is due', !renewalDue(19_999, b, false));
  check('at the budget a renewal is due', renewalDue(20_000, b, false));
  check('a handover lowers the bar', renewalDue(12_000, b, true) && !renewalDue(12_000, b, false));
  check('a socket that STARTED near the budget must grow before renewing again',
    !renewalDue(20_500, b, false, 15_000) && renewalDue(21_000, b, false, 15_000),
    'a 13k coach prompt would otherwise renew at every pause');
  check('the fallback model has its own, larger budget',
    liveModelQuirks(LIVE_25).contextBudget.renewAt > b.renewAt);
  check('held audio is replayed at 4x to 3.8 and 3.1 but in real time to 2.5',
    liveModelQuirks('gemini-3.8-live').replaySpeed === 4 && liveModelQuirks(LIVE_31).replaySpeed === 4 &&
      liveModelQuirks(LIVE_25).replaySpeed === 1,
    '2.5 heard a 4x replay and answered it 0 of 3 times; at 1x every time');
  {
    const voiceOn = (model: string, voice: string) =>
      (new LiveInterviewSession({} as never, model, { systemInstruction: '', voice }, {} as never) as never as {
        buildConfig: () => { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } };
      }).buildConfig().speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
    check('3.8 is asked for the stand-in that sounds like the 3.1 voice',
      voiceOn('gemini-3.8-live', 'Charon') === 'Alnilam' && voiceOn('gemini-3.8-live', 'Aoede') === 'Callirrhoe' &&
        voiceOn('gemini-3.8-live', 'Kore') === 'Achernar',
      '3.8\'s own Charon is 3.3 semitones deeper than 3.1\'s, its Aoede 2.8');
    check('...and a failover to 3.1 or 2.5 gets the original name back',
      voiceOn(LIVE_31, 'Charon') === 'Charon' && voiceOn(LIVE_25, 'Aoede') === 'Aoede' && voiceOn(LIVE_31, 'Kore') === 'Kore');
    check('...while a voice with no stand-in is passed through on 3.8',
      voiceOn('gemini-3.8-live', 'Puck') === 'Puck' && voiceOn('gemini-3.8-live', 'Fenrir') === 'Fenrir');
  }
  check('refusal backoff is immediate, then doubling to a cap',
    [1, 2, 3, 4, 5, 9].map(refusalBackoffMs).join(',') === '0,1000,2000,4000,8000,8000');
  {
    const rt = new RefusalTracker();
    rt.record(0);
    rt.record(60_000);
    check('refusals older than the window are forgotten', rt.record(130_000) === 2);
  }

  const SR = 16_000;
  const tone = (ms: number, db = -20) => {
    const n = Math.round((SR * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const amp = 10 ** (db / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i * 0.07) * amp * 32767), i * 2);
    return buf;
  };
  const room = (ms: number) => {
    const n = Math.round((SR * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const amp = 10 ** (-49 / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const x = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * Math.sqrt(3) / Math.SQRT2;
      buf.writeInt16LE(Math.round(x * amp * 32767), i * 2);
    }
    return buf;
  };

  {
    const bl = new MicBacklog();
    const va = new VoiceActivity(SR);
    let t = 1_000_000;
    for (let i = 0; i < 30; i++) {
      const buf = i < 10 ? room(100) : tone(100);
      t += 100;
      va.observe(buf, t);
      bl.push(buf.toString('base64'), t, false);
    }
    const replay = bl.takeForReplay((a, z) => va.voicedBetween(a, z), 'all');
    check('a replay starts just before the first voiced moment, not with the silence ahead of it',
      replay.length >= 20 && replay.length <= 27, `${replay.length} of 30 chunks`);
    check('...and what was handed over counts as sent', bl.unsentMs === 0);
    for (let i = 0; i < 5; i++) {
      const buf = tone(100);
      t += 100;
      va.observe(buf, t);
      bl.push(buf.toString('base64'), t, false);
    }
    check('a resumed socket is given only what no socket received',
      bl.takeForReplay((a, z) => va.voicedBetween(a, z), 'unsent').length === 5);
    bl.committed(t);
    check('a transcript accounts for everything before it, less the overlap', bl.heldMs < 1_500 + 101,
      `${bl.heldMs}ms held, to the nearest 100ms chunk`);
    for (let i = 0; i < 1_200; i++) bl.push(tone(100).toString('base64'), (t += 100), false);
    check('the backlog is bounded', bl.heldMs <= BACKLOG_MAX_MS, `${bl.heldMs}ms`);
  }

  {
    /**
     * At 1x — the 2.5 fallback — live audio queued behind a replay could never
     * catch up, and the interviewer would stay a minute late for the rest of
     * the round. Dropping the tail of each pause is what closes the gap.
     */
    const sent: boolean[] = [];
    const s = new LiveInterviewSession({} as never, LIVE_25, { systemInstruction: '', voice: 'Charon' }, {
      onReady: () => {}, onAudio: () => {}, onTranscript: () => {}, onTurnComplete: () => {}, onInterrupted: () => {},
      onGoAway: () => {}, onReconnected: () => {}, onError: () => {}, onClosed: () => {},
    });
    const p = s as never as { session?: unknown; startReplay: (c: { data: string; voiced: boolean }[]) => void; replayQueue: unknown[] };
    const voice = Buffer.alloc(3_200, 1).toString('base64');
    const quiet = Buffer.alloc(3_200, 0).toString('base64');
    const queue = [
      ...Array.from({ length: 10 }, () => ({ data: voice, voiced: true })),
      ...Array.from({ length: 60 }, () => ({ data: quiet, voiced: false })),
      ...Array.from({ length: 10 }, () => ({ data: voice, voiced: true })),
    ];
    p.session = {
      sendRealtimeInput: (c: { audio: { data: string } }) => sent.push(c.audio.data === voice),
      sendClientContent: () => {}, close: () => {},
    };
    p.startReplay.call(s, queue);
    await sleep(4_600);
    const silent = sent.filter((v) => !v).length;
    check('a real-time replay catches up by sending only the start of each long pause',
      p.replayQueue.length === 0 && sent.length === 40 && silent === 20,
      `${sent.length} of 80 chunks sent, ${silent} of the pause's 60 — 8s of audio in ${(4.6).toFixed(1)}s`);
    s.close();
  }

  const HISTORY = [
    { role: 'model' as const, text: 'Right, question one. Design a data structure that adds and searches words.' },
    { role: 'user' as const, text: 'I would use a trie.' },
  ];
  type Cb = { onmessage: (m: unknown) => void; onclose: (e: { reason?: string; code?: number }) => void };
  const realNow = Date.now;
  let cur = realNow.call(Date);
  const make = (o: { history?: boolean; failover?: (m: string) => string | undefined } = { history: true }) => {
    const callbacks: Cb[] = [];
    const configs: Record<string, unknown>[] = [];
    const models: string[] = [];
    const contents: Record<string, unknown>[][] = [];
    const audio: number[] = [];
    const upstream: UpstreamEvent[] = [];
    let reconnected = 0;
    const ai = {
      live: {
        connect: async (req: { model: string; config: Record<string, unknown>; callbacks: Cb }) => {
          callbacks.push(req.callbacks);
          configs.push(req.config);
          models.push(req.model);
          const n = contents.push([]) - 1;
          audio[n] = 0;
          return {
            sendClientContent: (c: Record<string, unknown>) => contents[n]!.push(c),
            sendRealtimeInput: (c: { audio?: unknown }) => { if (c.audio) audio[n]! += 1; },
            sendToolResponse: () => {},
            close: () => {},
          };
        },
      },
    };
    const s = new LiveInterviewSession(
      ai as never, MODELS.interviewer,
      {
        systemInstruction: '', voice: 'Charon',
        ...(o.history ? { history: async () => HISTORY } : {}),
        ...(o.failover ? { failover: o.failover } : {}),
      },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: () => {},
        onTurnComplete: () => {}, onInterrupted: () => {},
        onGoAway: () => {}, onReconnected: () => { reconnected += 1; },
        onUpstream: (e) => upstream.push(e),
        onError: () => {}, onClosed: () => {},
      },
    );
    const last = () => callbacks.at(-1)!;
    const speak = (text = 'Next question.') => {
      last().onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] }, outputTranscription: { text } } });
      last().onmessage({ serverContent: { turnComplete: true } });
    };
    const talk = (ms: number, voiced = true) => {
      for (let done = 0; done < ms; done += 100) {
        cur += 100;
        s.sendAudio((voiced ? tone(100) : room(100)).toString('base64'));
      }
    };
    const usage = (n: number) => last().onmessage({ usageMetadata: { promptTokenCount: n } });
    const until = async (cond: () => boolean, ms = 6_000) => {
      const end = realNow.call(Date) + ms;
      while (!cond() && realNow.call(Date) < end) await sleep(20);
    };
    const priv = s as never as { checkStall: () => void };
    return {
      s, configs, models, contents, audio, upstream, last, speak, talk, usage, until, priv,
      reconnected: () => reconnected,
      handle: () => last().onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } }),
      instruction: (i: number) =>
        String(((contents[i]?.[0]?.turns as { parts: { text: string }[] }[] | undefined)?.at(-1)?.parts[0]?.text) ?? ''),
    };
  };
  const handleOf = (cfg?: Record<string, unknown>) => (cfg?.sessionResumption as { handle?: string } | undefined)?.handle;

  Date.now = () => cur;
  try {
    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.last().onclose({ code: 1011, reason: 'Internal error encountered.' });
      await m.until(() => m.configs.length === 2);
      await sleep(20);
      check('a refused socket is replaced by ONE clean one', m.configs.length === 2);
      check('...opened WITHOUT the handle, which restores the refused session', handleOf(m.configs[1]) === undefined,
        'a resumed refused session came back holding 14k of a 36k context');
      check('...and given the conversation from our own record, as one client content',
        ((m.contents[1]?.[0]?.turns as unknown[]) ?? []).length === 1 && m.contents[1]?.length === 1 &&
          HISTORY.every((h) => m.instruction(1).includes(h.text)));
      check('...told not to greet or restart', /do NOT greet/i.test(m.instruction(1)));
      check('the candidate is told it reconnected', m.reconnected() === 1);
      check('the close is recorded with its code, and the renewal with why',
        m.upstream.some((e) => e.kind === 'closed' && e.code === 1011 && e.why === 'refused') &&
          m.upstream.some((e) => e.kind === 'renewed' && e.why === 'refused'));
      m.s.close();
    }

    {
      const marked: string[] = [];
      const m = make({ history: true, failover: (from) => { marked.push(from); return 'hearing-model'; } });
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      for (let i = 1; i <= REFUSALS_BEFORE_FAILOVER; i++) {
        m.last().onclose({ code: 1011, reason: 'Internal error encountered.' });
        await m.until(() => m.configs.length === i + 1, 9_000);
      }
      check(`${REFUSALS_BEFORE_FAILOVER} refusals in the window fail the model over`,
        marked[0] === MODELS.interviewer && m.models.at(-1) === 'hearing-model' && m.s.modelId === 'hearing-model',
        m.models.join(' -> '));
      check('...and the failover is recorded', m.upstream.some((e) => e.kind === 'failover'));
      m.s.close();
    }

    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.usage(6_000);
      m.last().onclose({ code: 1000, reason: '' });
      m.talk(1_000);
      await m.until(() => m.configs.length === 2);
      await sleep(30);
      check('a recycled socket with a small context still resumes from its handle', handleOf(m.configs[1]) === 'h1',
        'the healthy path the probes took every nine minutes is unchanged');
      check('...and is given the speech said while there was no socket', (m.audio[1] ?? 0) >= 1 &&
        m.upstream.some((e) => e.kind === 'backlog_replayed' && (e.replayedMs ?? 0) >= 500),
        `${m.audio[1]} chunks; it used to go to nobody`);
      m.s.close();
    }

    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.usage(5_000);
      m.usage(21_000);
      cur += 3_000;
      m.speak('What is the time complexity?');
      await m.until(() => m.configs.length === 2);
      await sleep(20);
      check('past the budget, the session is renewed at the turn boundary', m.configs.length === 2 && handleOf(m.configs[1]) === undefined);
      check('...silently: no reconnect banner for a planned renewal', m.reconnected() === 0);
      check('...asking the model for nothing, since nothing is owed',
        m.contents[1]?.[0]?.turnComplete === false && /Say nothing until they speak/.test(m.instruction(1)));
      check('...and recorded with the context it was decided on',
        m.upstream.some((e) => e.kind === 'renewed' && e.why === 'budget' && e.tokens === 21_000));
      m.s.close();
    }

    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.usage(5_000);
      m.usage(21_000);
      m.talk(1_000);
      m.speak('Go on.');
      await sleep(50);
      check('a renewal never cuts in while the candidate is speaking', m.configs.length === 1);
      m.usage(25_500);
      m.talk(500);
      m.priv.checkStall.call(m.s);
      await m.until(() => m.configs.length === 2);
      await sleep(30);
      check('...unless it is overdue, when it goes anyway', m.configs.length === 2,
        'a candidate narrating without a pause is how a session reaches the refusal zone');
      check('...and what they were saying is replayed onto the new socket', (m.audio[1] ?? 0) >= 1, `${m.audio[1]} chunks`);
      check('...with the model told their words follow as audio', /follow this note as audio/i.test(m.instruction(1)));
      m.s.close();
    }

    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.usage(5_000);
      m.usage(13_000);
      cur += 3_000;
      m.last().onmessage({ goAway: { timeLeft: '50s' } });
      await m.until(() => m.configs.length === 2);
      check('a handover warning past the lower bar renews instead of resuming', m.configs.length === 2 && handleOf(m.configs[1]) === undefined);
      m.s.close();
    }

    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.usage(5_000);
      m.usage(8_000);
      cur += 3_000;
      m.last().onmessage({ goAway: { timeLeft: '50s' } });
      await sleep(50);
      check('a handover with a small context waits for the server to close', m.configs.length === 1);
      m.last().onclose({ code: 1000, reason: '' });
      await m.until(() => m.configs.length === 2);
      check('...and then resumes from the handle', handleOf(m.configs[1]) === 'h1');
      m.s.close();
    }

    {
      const m = make();
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.last().onclose({ code: 1011, reason: 'Internal error encountered.' });
      await m.until(() => m.configs.length === 2);
      check('before the first word there is no record to rebuild from, so the opening keeps the handle',
        handleOf(m.configs[1]) === 'h1');
      m.s.close();
    }

    {
      const m = make({ history: false });
      await m.s.start();
      // A real microphone opens on the room; `VoiceActivity` learns its floor from it.
      m.talk(2_000, false);
      m.handle();
      m.speak('Right, question one.');
      m.last().onclose({ code: 1011, reason: 'Internal error encountered.' });
      await m.until(() => m.configs.length === 2);
      check('a session with no history can still only resume from the handle', handleOf(m.configs[1]) === 'h1');
      m.s.close();
    }

    {
      // Statement that broke off into an early refusal.
      const m = make({ history: false });
      await m.s.start();
      m.last().onmessage({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
          outputTranscription: { text: 'an infinite number of each kind. I am just a language model.' },
        },
      });
      m.last().onmessage({ serverContent: { turnComplete: true, turnCompleteReason: 'RESPONSE_REJECTED' } });
      m.speak('What is your approach?');
      m.last().onmessage({ serverContent: { turnComplete: true, turnCompleteReason: 'NEED_MORE_INPUT' } });
      m.last().onmessage({ serverContent: { turnComplete: true, turnCompleteReason: 'TURN_COMPLETE_REASON_UNSPECIFIED' } });
      const reasons = m.upstream.filter((e) => e.kind === 'turn_reason');
      check('a rejected turn is persisted with the words it broke off on',
        reasons[0]?.why === 'RESPONSE_REJECTED' && /language model/.test(reasons[0]?.reason ?? ''),
        'the cause of its opening could only be guessed at');
      check('...a routine reason without them, and the default not at all',
        reasons.length === 2 && reasons[1]?.why === 'NEED_MORE_INPUT' && reasons[1]?.reason === undefined,
        `${reasons.map((r) => r.why).join(', ')}`);
      m.s.close();
    }
  } finally {
    Date.now = realNow;
  }

  {
    let captured: Record<string, unknown> | undefined;
    const gemini = {
      createInterviewSession: async (opts: Record<string, unknown>) => {
        captured = opts;
        return { close: () => {}, modelId: 'm' };
      },
    };
    const gw = new CoachGateway(
      {} as never, gemini as never, { findById: async () => ({ name: 'Alex' }) } as never, {} as never,
      { history: async () => [] } as never, { listMemories: async () => [] } as never, {} as never, {} as never,
      { listen: async () => null } as never,
    );
    const client = { OPEN: 1, readyState: 1, send: () => {}, on: () => {}, close: () => {} };
    (gw as never as { identities: WeakMap<object, string> }).identities.set(client, 'u1');
    await gw.onStart(client as never, { scope: 'account' });
    const conn = (gw as never as { conns: WeakMap<object, { log: { push: (s: string, t: string, f: boolean) => void } }> }).conns.get(client);
    conn?.log.push('user', 'How am I doing?', true);
    conn?.log.push('ai', 'Better on composure.', true);
    const history = await (captured?.history as (() => Promise<{ role: string; text: string }[]>) | undefined)?.();
    check('the mentor can be rebuilt from its own conversation, so a refusal is not a fresh start',
      history?.length === 2 && history[0]?.role === 'user' && history[1]?.role === 'model',
      '2026-10-03: it restarted as a new conversation at 5:44');
    const note = (captured?.resumeNote as ((o: { owed: boolean; audioFollows: boolean }) => string) | undefined)?.({ owed: false, audioFollows: false }) ?? '';
    check('...and is told to carry on, not greet, and to fetch again what it had looked up',
      /CONVERSATION CONTINUES/.test(note) && /do NOT greet/i.test(note) && /call the tool again/.test(note) &&
        !/restate the problem/.test(note));
    check('no raw recording is handed to a live session any more', captured?.deferredAudio === undefined && captured?.primer !== undefined);
  }

  check('the coach is told plainly when nobody could listen',
    /Nobody could listen/.test(coachListeningNote(null)) && /say\s+plainly/.test(coachListeningNote(null)));
  check('...and given the notes, marked partial, when someone did',
    coachListeningNote('Rushed.', 'only the first 15 minutes').includes('Rushed.') &&
      coachListeningNote('Rushed.', 'only the first 15 minutes').includes('only the first 15 minutes'));
}

/* ── 29. markup the interviewer writes, and wrap-up asks over an empty editor ── */

/**
 * Guards against the model hallucinating code snapshots or asking for
 * wrap-up before code has actually been written.
 */
async function inventedMarkupAndWrapUp() {
  console.log('\n\x1b[1m29. markup the interviewer writes, and wrap-up asks over an empty editor\x1b[0m');

  const NQUEENS_TURN = "[CODE SNAPSHOT: {\"code\":\"class Solution:\\n def solveNQueens(self, n: int) -> List[List[str]]:\\n board = [[\\\".\\\"] * n for _ in range(n)]\\n res = []\\n \\n def backtrack(r):\\n if r == n:\\n res.append([\\\"\\\".join(row) for row in board])\\n return\\n \\n for c in range(n):\\n if isValid(r, c):\\n board[r][c] = \\\"Q\\\"\\n backtrack(r + 1)\\n board[r][c] = \\\".\\\"\\n \\n def isValid(r, c):\\n pass\"}] Take your time. What are you thinking?";
  const HEAP_TURN = "[CODE SNAPSHOT: {\"code\":\"import heapq\\n\\nclass Solution:\\n def findKthLargest(self, nums: List[int], k: int) -> int:\\n heapq.heapify(nums)\\n for i in range(len(nums) - k):\\n heapq.heappop(nums)\\n return heapq.heappop(nums)\"}]Understood. Walk me through what this code is doing.";
  /** What the candidate's editor really held when HEAP_TURN was said: the starter. */
  const HEAP_EDITOR = "class Solution:\n    def findKthLargest(self, nums: List[int], k: int) -> int:\n      ";
  const COIN_STARTER = "class Solution:\n    def coinChange(self, coins: List[int], amount: int) -> int:\n        ";

  const filtered = (text: string, size: number) => {
    const f = new MarkupFilter();
    let out = '';
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
    return { out: out + f.end(), removed: f.takeRemoved() };
  };
  for (const size of [1, 5, 40, 10_000]) {
    const n = filtered(NQUEENS_TURN, size);
    check(`an invented snapshot leaves only what was spoken (fragments of ${size})`,
      n.out.trim() === 'Take your time. What are you thinking?' && n.removed.length === 1,
      'the recording holds only this sentence');
  }
  check('...brackets inside its JSON strings do not end it early',
    filtered(HEAP_TURN, 3).out === 'Understood. Walk me through what this code is doing.');
  for (const speech of [
    'Then a of i is compared with a[j] and swapped.',
    'Say the input is [1, 2, 3].',
    'Use dp[0] as the base case.',
    'Is that [right]?',
  ]) check(`speech with brackets is untouched: "${speech}"`, filtered(speech, 2).out === speech);
  check('a bare "[SESSION ENDS]" goes', filtered('[SESSION ENDS] Goodbye.', 4).out === ' Goodbye.', 'session ends marker');
  check('a span the model never closes is dropped with the rest of the turn',
    filtered('Okay. [CODE SNAPSHOT: {"code":"x', 3).out === 'Okay. ');

  {
    const transcript: string[] = [];
    const invented: string[] = [];
    const spurious: string[] = [];
    const s = new LiveInterviewSession(
      {} as never, 'test-model', { systemInstruction: '', voice: 'Charon' },
      {
        onReady: () => {}, onAudio: () => {}, onTranscript: (t) => transcript.push(t.text),
        onTurnComplete: () => {}, onInterrupted: () => {}, onGoAway: () => {}, onReconnected: () => {},
        onError: () => {}, onClosed: () => {},
        onSpuriousNote: (t) => spurious.push(t), onInventedMarkup: (m) => invented.push(m),
      },
    );
    const priv = s as never as { handleMessage: (m: unknown) => void };
    const say = (text: string) => {
      const words = text.split(/(?= )/);
      for (let i = 0; i < words.length; i += 4) {
        priv.handleMessage.call(s, { serverContent: { outputTranscription: { text: words.slice(i, i + 4).join('') } } });
      }
      priv.handleMessage.call(s, { serverContent: { turnComplete: true } });
    };
    say(HEAP_TURN);
    check('the live transcript never shows an invented snapshot',
      transcript.join('').trim() === 'Understood. Walk me through what this code is doing.',
      transcript.join('').slice(0, 80));
    check('...and the gateway is told, once, what was removed',
      invented.length === 1 && invented[0]!.startsWith('[CODE SNAPSHOT:') && spurious.length === 0);
    transcript.length = 0;
    say('[SYSTEM NOTE — not spoken by the candidate] Time is running low.');
    check('a fabricated system note is still the note sniff\'s, suppressed whole',
      transcript.length === 0 && spurious.length === 1 && invented.length === 1);
  }

  const round = (questions: { id: string; title: string; prompt: string }[], starters: Record<string, string[]>) => {
    const facts: string[] = [];
    const checks = new TurnChecks({
      sessionId: 't', mode: 'dsa', questionIds: questions.map((q) => q.id), questions, starters,
      effects: {
        fact: (n) => facts.push(n), urgent: (n) => facts.push(n), warn: () => {}, questionChanged: () => {},
        saveQuestion: () => {}, elapsedMs: () => 0, ended: () => false,
        clock: () => ({ remainingMin: 30, secondsLeft: 1800, plannedMin: 40, lowTimeSent: false, notesSent: 0 }),
        log: { log: () => {}, warn: () => {}, error: () => {} },
      },
    });
    const ai = (text: string, how: 'turnComplete' | 'interrupted' = 'turnComplete') => {
      for (const w of text.split(' ')) checks.interviewerFragment(w);
      checks.boundary(how);
    };
    return { checks, facts, ai, user: (t: string) => checks.candidateFragment(t) };
  };

  {
    const heap = [{ id: 'kth-largest-element-in-an-array', title: 'Kth Largest Element in an Array', prompt: '' }];
    const r = round(heap, {});
    r.checks.state.codeByQuestion.set(heap[0]!.id, HEAP_EDITOR);
    r.checks.inventedMarkup(HEAP_TURN.slice(0, HEAP_TURN.indexOf(']}') + 2));
    check('an invented snapshot over an empty editor is corrected with the truth',
      r.facts.length === 1 && /still holds only the starter code/.test(r.facts[0]!),
      '"walk me through what this code is doing" — "I haven\'t even written it"');
    check('...and recorded for the evaluator', r.checks.guardLog[0]?.kind === 'invented_markup');
    r.checks.state.codeByQuestion.set(heap[0]!.id, 'import heapq\nclass Solution:\n  def f(self):\n    heapq.heapify(nums)\n    return nums[0]');
    for (let i = 0; i < 4; i++) r.checks.inventedMarkup('[CODE SNAPSHOT: {}]');
    check('...while once there is code it is rationed like a fabricated note',
      r.facts.length === 2 && r.checks.guardLog.length === 5 && r.checks.guardLog.at(-1)?.corrected === false,
      `${r.facts.length} corrections for five`);
  }

  const COIN = { id: 'coin-change', title: 'Coin Change', prompt: 'You are given an integer array coins representing coins of different denominations.' };
  const WORDS = { id: 'design-add-and-search-words-data-structure', title: 'Design Add and Search Words Data Structure', prompt: 'Design a data structure that supports adding new words and finding if a string matches any previously added string.' };

  {
    const r = round([COIN, WORDS], { 'coin-change': [COIN_STARTER] });
    r.checks.state.codeByQuestion.set('coin-change', COIN_STARTER);
    r.user('Yeah, so n is length of coin. And m is the amount value.');
    r.ai('Okay. Are you ready to move on to the next question?');
    check('"ready to move on?" over the starter code is caught',
      r.checks.guardLog.map((g) => g.kind).join() === 'premature_wrapup',
      '"But I haven\'t even coded it yet."');
    check('...corrected as a fact, naming the problem',
      r.facts.length === 1 && r.facts[0]!.includes('"Coin Change"') && r.facts[0]!.includes('only the starter code'));
    r.ai('Okay. Are you happy with this solution?');
    check('...once per problem', r.facts.length === 1);
  }

  {
    const r = round([COIN, WORDS], {});
    r.checks.state.codeByQuestion.set('coin-change', 'class Solution:\n  def coinChange(self, coins, amount):\n    dp = [0] * (amount + 1)\n    return dp[amount]');
    r.user('Give me a minute.');
    r.ai('Okay. Are you happy with this solution?');
    check('with code written, "are you happy with this one?" is the prompt\'s own check, not a fault',
      r.checks.guardLog.length === 0 && r.facts.length === 0, 'candidate answered "Yeah"');
  }

  {
    const r = round([COIN, WORDS], {});
    r.checks.state.codeByQuestion.set('coin-change', 'class Solution:\n  def coinChange(self, coins, amount):\n    dp = [0] * (amount + 1)\n    return dp[amount]');
    // Without an indication of completion, nothing licenses the wrap-up ask.
    r.user('Yeah. Also, do you have any follow-ups or any other question regarding the implementation of mine?');
    r.ai("I don't have any follow ups Are you ready to move on to question two?");
    check('...(the ask itself did move the round)', r.checks.state.questions!.index === 1);
    check('an ask that moves the round is judged against the problem it left, not the empty one it reached',
      r.checks.guardLog.every((g) => g.kind !== 'premature_wrapup'), 'wrap-up after code is written');
  }

  {
    const prompt = buildInterviewerPrompt({
      config: { mode: 'dsa', language: 'python', codeEditor: true, questionIds: [COIN.id, WORDS.id] } as never,
      options: { durationMinutes: 40, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
      questions: [COIN, WORDS].map((q) => ({ ...q, difficulty: 'Medium' })),
    } as never);
    check('the prompt asks "are you happy with this one?" only once code is written',
      prompt.includes('If they have written\ntheir code and you are unsure') && prompt.includes('never before they have written it'));
    check('...says the editor starts empty until a snapshot shows otherwise',
      prompt.includes("Each problem's editor starts with only the starter code"));
    check('...and that it never writes a snapshot itself', prompt.includes('never write one yourself'));
  }

  check('the report names both new faults as the interviewer\'s',
    /invented editor contents you had not written once/.test(
      interviewerFaultSentence({ deadMs: 0, guardEvents: [{ atMs: 0, kind: 'invented_markup', said: '', corrected: true }] }) ?? '',
    ) &&
      /asked whether you were done before you had written your code twice/.test(
        interviewerFaultSentence({
          deadMs: 0,
          guardEvents: [0, 1].map((atMs) => ({ atMs, kind: 'premature_wrapup' as const, said: '', corrected: true })),
        }) ?? '',
      ));
}

/**
 * An experience round aimed at a role. A posting reads like a list of claims, so
 * the role must reach the interviewer and the evaluator under its own heading,
 * never inside the background, and a round without one must not change at all.
 */
async function experienceForRole() {
  console.log('\n\x1b[1m30. an experience round aimed at a role\x1b[0m');

  const background = 'Led the conversational AI platform at 250 requests a second; owned the Kubernetes and Kafka deployment.';
  const posting = 'Senior Full Stack Engineer. Must have React, Node, AWS, OAuth2. Nice to have Terraform, RAG and LangChain.';
  const opts = { durationMinutes: 30, difficulty: 'standard', persona: 'neutral', voice: 'Charon' } as const;
  const build = (config: object, roleBrief?: string) =>
    buildInterviewerPrompt({ config: { mode: 'experience', ...config }, options: opts, brief: background, roleBrief } as never);

  const plain = startSessionSchema.parse({ config: { mode: 'experience', experience: background } });
  check('an experience round without a role parses with no role key',
    !('jobDescription' in plain.config), 'rounds recorded before this field re-parse unchanged');
  check('...and a role under the server floor is refused',
    !startSessionSchema.safeParse({ config: { mode: 'experience', experience: background, jobDescription: 'too short' } }).success);

  const none = build({ experience: background });
  check('a round with no role has no role section', !none.includes('The role they are preparing for'));

  const steered = build({ experience: background, jobDescription: posting }, 'Role: Senior Full Stack Engineer (senior)');
  const bg = steered.indexOf('### Candidate background');
  const role = steered.indexOf('### The role they are preparing for');
  check('a role is its own section, after the background and not inside it',
    bg >= 0 && role > bg && steered.slice(bg, role).includes(background) && !steered.slice(bg, role).includes('Senior Full Stack'));
  check('...says the role is not something they have claimed', steered.includes('It is NOT part of their background'));
  check('...uses the extracted brief over the raw posting',
    steered.includes('Role: Senior Full Stack Engineer (senior)') && !steered.includes(posting));
  check('...keeps most of the round on their own work', steered.includes('roughly three quarters'));
  check('...and falls back to the raw posting when extraction fails', build({ experience: background, jobDescription: posting }).includes(posting));

  const brief = {
    role: 'Senior Full Stack Engineer', seniority: 'senior', mustHave: ['React', 'AWS'], niceToHave: ['Terraform'],
    focusAreas: [{ area: 'AWS', why: 'cloud-native', weight: 3 }, { area: 'React', why: 'frontend', weight: 5 }],
    likelyProbes: ['How do you version an API?'],
  };
  const interview = renderRole(brief, 'interview');
  check('a JD round is still told how to divide the round, and the probes to ask',
    interview.includes('Spend the round on these') && interview.includes('How do you version an API?'));
  const steer = renderRole(brief, 'steer');
  check('an experience round gets what the role weights, not questions to ask about it',
    steer.includes('What the role weights most') && !steer.includes('How do you version an API?') && !steer.includes('Spend the round'));
  check('...highest weight first', steer.indexOf('React (weight 5') < steer.indexOf('AWS (weight 3'));

  const ctx = (cfg: object) => ({ db: null, cfg, dsa: [], codeLanguage: null }) as never;
  const withRole = await REFERENCE.experience(ctx({ experience: background, jobDescription: posting }));
  check('the evaluator gets the role under its own heading',
    withRole.includes('### The role they were preparing for') && withRole.indexOf(background) < withRole.indexOf(posting));
  check('...and is told an unasked requirement is not a fault', withRole.includes('A requirement they were never asked about is not a fault'));
  check('the evaluator reference without a role is unchanged',
    (await REFERENCE.experience(ctx({ experience: background }))) ===
      `The candidate's stated background, which their claims should be checked against:\n\n${background}`);
}

async function main() {
  console.log('\n\x1b[1mInterview guard verification\x1b[0m');
  await fragmentOrdering();
  noteSuppression();
  degradedTranscription();
  openingTurn();
  await toolDispatch();
  await coachStartRace();
  queuedAudioDelivery();
  toolNarration();
  memoryDedup();
  repeatGuard();
  await missingReport();
  await abandonedSessions();
  await playback();
  stallWatchdog();
  noteDelivery();
  await openingStall();
  await sessionRebuild();
  roundBudget();
  micAndFloor();
  clockClaims();
  scopeRereadAndBargeIn();
  codeCheckFacts();
  await codeCheckRetry();
  await unheardNoteCorrection();
  await socketReplacement();
  await gatewayLifecycle();
  await f836Stalls();
  await f836Flow();
  await deafServer();
  await practiceRounds();
  schemaCheck();
  await upstreamBudget();
  await inventedMarkupAndWrapUp();
  await experienceForRole();

  console.log('\n' + '─'.repeat(56));
  if (fails.length) {
    console.log(`\x1b[31m\x1b[1m${fails.length} FAILED\x1b[0m of ${pass + fails.length}`);
    fails.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m\x1b[1mALL ${pass} GUARD CHECKS PASSED\x1b[0m`);
}

void main();
