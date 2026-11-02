import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  GoogleGenAI,
  Modality,
  ActivityHandling,
  TurnCoverage,
  StartSensitivity,
  EndSensitivity,
  AudioTranscriptionConfigMode,
  TurnCompleteReason,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { MODELS, AUDIO, liveModelQuirks, liveVoiceFor } from '@orvia/shared';
import { MarkupFilter } from './markup-filter';
import {
  mayOpenToolArtifact,
  opensToolArtifact,
  scrubToolArtifacts,
} from './tool-artifacts';
import { VoiceActivity } from './voice-activity';
import { InputLiveness } from './input-liveness';
import { NoteQueue, type ClientContent } from './note-queue';
import {
  classifyClose,
  refusalBackoffMs,
  renewalDue,
  RefusalTracker,
  RENEW_OVERDUE_TOKENS,
  RENEW_QUIET_MS,
  REFUSALS_BEFORE_FAILOVER,
  type UpstreamEvent,
} from './context-budget';
import { MicBacklog, base64PcmMs, REPLAY_KEEP_SILENCE_MS, type QueuedChunk } from './mic-backlog';
import { ModelAvailabilityService } from './model-availability.service';
import { classifyFloor, classifyInterviewerTurn, type Floor } from './floor-intent';
import { ENV, type Env, isTestTarget } from '../config/env';
import { expire } from '../common/expire';
import { TECHNICAL_VOCABULARY } from '../interview/prompts/interviewer.prompt';

export type LiveEvents = {
  onReady: (info: { model: string }) => void;
  /**
   * base64 PCM @ 24 kHz, and ONLY audio the candidate should actually hear.
   *
   * A turn that turns out to be a fabricated system note never reaches here at
   * all — see `emitAudio`. Consumers may therefore treat these bytes as the
   * interviewer's real voice, and forward, record and count the same ones.
   */
  onAudio: (base64: string) => void;
  onTranscript: (t: {
    speaker: 'ai' | 'user';
    text: string;
    final: boolean;
    words?: unknown[];
  }) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  /**
   * A turn has ended, cleanly or by barge-in, and nothing has been sent at it
   * yet. Synchronous, and anything queued from inside it goes out in the
   * boundary's ONE send rather than as a second one straight after.
   */
  onBoundary?: (how: 'turnComplete' | 'interrupted') => void;
  /**
   * The model produced text shaped like one of our injected system notes.
   *
   * System notes are injected as user turns because the Live API lacks a mid-stream
   * system role. Occasionally the model hallucinates a note of its own and may act
   * on it (e.g. prematurely closing the round).
   *
   * `heard` indicates whether any audio from this turn reached the candidate before
   * the note was detected, which determines how to correct it.
   */
  onSpuriousNote?: (text: string, heard: boolean) => void;
  /**
   * The model wrote bracketed markup into its transcript (e.g. editor snapshots
   * containing code the candidate never wrote). It is stripped from the transcript;
   * this callback informs listeners.
   */
  onInventedMarkup?: (span: string) => void;
  /**
   * The interviewer spoke a turn but the Live API returned no output transcription
   * for it.
   *
   * The audio was played to the candidate, but without transcript fragments the
   * database record would be incomplete. This callback reports the delivered audio
   * duration so the gap can be tracked.
   */
  onUntranscribedTurn?: (durationMs: number) => void;
  /**
   * The model asked to run one of the tools declared in `LiveOptions.tools`.
   *
   * Returns one response per call. Throwing is not an option worth taking here
   * — a tool that fails must come back as a response saying so, because a call
   * left unanswered leaves the model waiting forever with the user watching.
   */
  onToolCall?: (
    calls: { id?: string; name: string; args: Record<string, unknown> }[],
  ) => Promise<{ id?: string; name: string; response: Record<string, unknown> }[]>;
  onGoAway: (secondsLeft: number) => void;
  onReconnected: () => void;
  /**
   * Every upstream socket event worth keeping — see `UpstreamEvent`. Optional,
   * and silent to the candidate: a planned renewal is not news to them.
   */
  onUpstream?: (e: UpstreamEvent) => void;
  /**
   * The model owes the candidate a turn and has produced nothing for longer
   * than expected (see `STALL_LADDER` mid-round, `OPENING_LADDER` for opening).
   *
   * Fires once per escalation rung, and once with `recovered: true` when the model speaks.
   */
  onStall?: (info: {
    /** Rung of the ladder in force, 1-based. Zero when reporting a recovery. */
    stage: number;
    /**
     * What the LADDER measured: accumulated quiet while owed mid-round, wall
     * time since the primer at the opening. It is the rung's trigger, not the
     * length of the outage.
     */
    silentMs: number;
    /**
     * Wall-clock ms the candidate has been waiting — from the silence that
     * handed the floor back, not from the interviewer's last word, which would
     * count their own answer as outage. What the round's budget and the
     * evaluator need. Always at least `silentMs`.
     */
    outageMs: number;
    /** What was done, for control flow. `action` is the same thing for a log. */
    remedy: StallRemedy;
    action: string;
    recovered?: boolean;
    /** True when the debt is the OPENING rather than a reply. */
    opening?: boolean;
    /**
     * True when the server stopped hearing the microphone rather than stopped
     * replying: what the candidate said in the window reached nobody and is
     * missing from the transcript. See `input-liveness.ts`.
     */
    deaf?: boolean;
  }) => void;
  onError: (err: Error, fatal: boolean) => void;
  onClosed: (reason: string) => void;
};

export type StallRemedy =
  | 'nudge'
  | 'note'
  | 'primer'
  | 'reconnect'
  | 'rebuild'
  | 'none'
  | 'unrecoverable'
  | 'recovered';

export type LiveOptions = {
  systemInstruction: string;
  voice: string;
  /** Extra ASR vocabulary on top of the technical defaults (e.g. JD-specific terms). */
  vocabulary?: string[];
  /**
   * How long a candidate may pause mid-answer before the model decides they
   * are done. The Live API default (~500ms) is tuned for chatty assistants and
   * cuts people off while they think, which is fatal for interview realism.
   */
  silenceDurationMs?: number;
  /**
   * How much sustained sound counts as speech onset. Too low and a cough or a
   * keystroke triggers barge-in, cutting the interviewer off mid-sentence while
   * its transcript still shows the full question.
   */
  prefixPaddingMs?: number;
  /**
   * What is sent to open the conversation. The Live API generates nothing until
   * the client sends a turn, so every session needs one of these.
   *
   * `audio` is attached as an inline part, which is how the coach gets to
   * actually HEAR the candidate's recording rather than only read about it.
   */
  primer?: { text: string; audio?: { mimeType: string; data: string } };
  /**
   * Audio to deliver AFTER the opening turn rather than inside it, so the model
   * can speak before it has finished listening. See `queueAudioNote`.
   */
  deferredAudio?: { text: string; audio: { mimeType: string; data: string } };
  /**
   * Function declarations the model may call. Gemini's own shape
   * (`{ name, description, parameters }`), passed through untouched — typing it
   * here would only duplicate the SDK's schema and drift from it.
   */
  tools?: Record<string, unknown>[];
  /**
   * The conversation history used when rebuilding a socket from server records
   * (e.g. on ladder rebuild or context renewal).
   *
   * Supplied as a callback to load the latest state from the database at the
   * moment of rebuild.
   */
  history?: () => Promise<{ role: 'user' | 'model'; text: string }[]>;
  /**
   * Where the round stands (current question, editor code state, elapsed time)
   * when rebuilding a socket. `withCode` includes editor state so the new socket
   * reflects candidate progress.
   */
  resumeContext?: (o: { withCode: boolean }) => string | undefined;
  /**
   * What a socket rebuilt from `history` is told after the replayed turns. The
   * default is the interviewer's; the coach and the mentor are not in an
   * interview, and "do not restate the problem" would be nonsense to them.
   * `owed` says the other side finished speaking and is waiting for a reply;
   * `missedVoiceMs`, that they spoke into a socket that never heard it;
   * `audioFollows`, that their latest words are replayed as audio after it.
   */
  resumeNote?: (o: { owed: boolean; missedVoiceMs?: number; audioFollows: boolean }) => string;
  /** How the other side is labelled in a rebuilt socket's transcript. Defaults to CANDIDATE. */
  historyLabel?: string;
  /**
   * TEST STACKS ONLY — see `E2E_FAULT_DEAF_AFTER_MS`. Set by
   * `GeminiLiveService` and by nothing else.
   */
  deafFaultAfterMs?: number;
  /**
   * A server that stopped hearing: records `model` as deaf and names the model
   * to rebuild on instead, or undefined when none is usable.
   */
  failover?: (model: string) => string | undefined;
};

/**
 * Detects fabricated system notes in the model's own output (see `onSpuriousNote`).
 *
 * Matching allows an optional leading bracket because the model may emit the label
 * either bracketed or unbracketed ("SYSTEM NOTE:").
 */
const SYSTEM_NOTE_RE = /\[?\s*SYSTEM\s*NOTE\b/i;

/** Bare text of the marker, for the prefix test below. */
const NOTE_TARGET = 'SYSTEM NOTE';

/**
 * Matches generic turn-opening labels (e.g. "Pacing note:", "Instruction:").
 *
 * Catches label patterns consisting of an optional qualifier word, "note", and
 * a colon or dash, distinguishing spurious meta-commentary from ordinary speech.
 */
const NOTE_LABEL_RE = /^\[?\s*(?:[a-z]+\s+)?note\s*[:–—-]/i;

/** Either spelling: the proven literal, or the general label shape. */
function isFabricatedNote(text: string): boolean {
  return SYSTEM_NOTE_RE.test(text) || NOTE_LABEL_RE.test(text.trimStart());
}

/**
 * Checks whether an incoming transcript head could develop into a system note.
 *
 * Holds the turn if the text matches or forms a prefix of a known note marker
 * or label pattern, allowing ordinary speech to release immediately.
 */
function mayOpenSystemNote(head: string): boolean {
  const h = head.trimStart().replace(/^\[+\s*/, '');
  if (!h) return false;
  const upper = h.toUpperCase();
  if (upper.includes(NOTE_TARGET)) return true;
  if (NOTE_TARGET.startsWith(upper.slice(0, NOTE_TARGET.length))) return true;
  if (NOTE_LABEL_RE.test(h)) return true;

  /**
   * Checks whether the head could grow into a qualified label (e.g. "[pacing note:").
   * Bare single words wait briefly for a potential following "note:" label.
   */
  const tokens = h.split(/\s+/).filter(Boolean);
  if (tokens.length > 2) return false;
  if (!/^[a-z]+$/i.test(tokens[0]!)) return false;
  // One bare word so far: " note:" may still follow it.
  if (tokens.length === 1) return true;
  // Two: the second must still be growing into "NOTE".
  return 'NOTE'.startsWith(tokens[1]!.toUpperCase());
}

/**
 * How much of a model turn's transcript to hold back while deciding whether it
 * is a spurious note. Held only while `mayOpenSystemNote` says the head could
 * still become one, so ordinary speech is released on its first fragment.
 */
const NOTE_SNIFF_CHARS = 48;

/**
 * Maximum duration to hold model audio while checking whether a turn head is a
 * fabricated system note.
 *
 * Transcript fragments usually arrive before or alongside audio. Capping the hold
 * prevents noticeable audio latency if a turn's text is delayed.
 */
const AUDIO_HOLD_MAX_MS = 400;

/**
 * Minimum delivered audio duration to report an untranscribed turn.
 * Keeps stray frames from recording an empty turn placeholder.
 */
const UNTRANSCRIBED_MIN_MS = 300;

/**
 * How much of a turn's transcript to hold while detecting a verbalized tool call.
 * Holds transcript only so parameter text can be stripped before displaying.
 */
const ARTIFACT_SNIFF_CHARS = 320;

/**
 * Maximum times the opening prompt may be re-sent if the model returns an empty turn.
 * Retries are triggered by empty completion events rather than timers to avoid barge-in.
 */
export const OPENING_MAX_KICKOFFS = 3;

/**
 * Ceiling on the upstream WebSocket handshake.
 * Fails fast so connection issues can trigger fallback rather than hanging indefinitely.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How often the stall watchdog looks. Cheap: it is arithmetic on two numbers.
 */
const STALL_CHECK_MS = 2_000;

/**
 * How long the candidate must have been quiet before a nudge is allowed.
 *
 * Comfortably past `INTERVIEW_SILENCE_MS` (1400), so a nudge can never land in
 * the middle of somebody's sentence — which would be barge-in, and would cut
 * off the very answer we are trying to get a reply to.
 */
const STALL_QUIET_MS = 3_000;

/**
 * How much of what the candidate said since the interviewer last spoke is kept
 * for `classifyFloor`. A few sentences is all it reads; the cap only stops a
 * forty-minute monologue to a dead line growing without bound.
 */
const FLOOR_TEXT_CHARS = 1_200;

/**
 * Minimum silence banked while the floor is neutral before counting toward a stall.
 * Distinguishes thoughtful pauses during problem solving from a dead connection.
 */
const NEUTRAL_QUIET_MS = 8_000;

/**
 * Speech duration that initiates interviewer debt even without an input transcript.
 * Protects against delayed transcription while the candidate is actively speaking.
 */
const VOICE_DEBT_MS = 3_000;

/** Speech since a request for time that ends it without a transcript. See `noteVoiceResumed`. */
const HOLD_RESUME_VOICE_MS = 15_000;

/** Slack on `playbackEndsAt`, for the browser's own buffering. */
const PLAYBACK_SLACK_MS = 500;

/**
 * Escalating recovery ladder for mid-round interviewer stalls.
 *
 * Progresses from low-touch interventions (silent turn completions and text nudges)
 * to aggressive remedies (socket reconnection and full state rebuild) as silence continues.
 */
const STALL_LADDER = [25_000, 40_000, 60_000, 90_000, 120_000];

/**
 * Wall-clock timeout that escalates directly to socket reconnection if the candidate
 * has yielded the floor and received no reply.
 */
export const YIELD_WALL_CEILING = { reconnectMs: 30_000, rebuildMs: 50_000 } as const;

/** The rung the wall clock alone demands. Pure, so a whole stall can be replayed through it. */
export function yieldCeilingRung(waitedMs: number, stage: number): number {
  if (waitedMs >= YIELD_WALL_CEILING.rebuildMs && stage >= 4) return 5;
  if (waitedMs >= YIELD_WALL_CEILING.reconnectMs) return stage >= 1 ? 4 : 1;
  return 0;
}

/**
 * Escalating recovery ladder for the round's opening turn.
 *
 * Operates on absolute wall time from the initial kickoff prompt, retrying the prompt,
 * cycling the socket, and finally notifying the candidate if the session fails to start.
 */
export const OPENING_LADDER = [15_000, 25_000, 35_000, 45_000, 55_000];

/**
 * Timeout after which an opening turn that opened but produced no delivered audio
 * is treated as wedged rather than slow.
 */
export const OPENING_DEAD_TURN_MS = 15_000;

/**
 * How long a send that requested a reply holds system notes before allowing notes
 * to be sent again, preventing collision with the start of an incoming turn.
 */
const REPLY_PENDING_MAX_MS = 15_000;

/** Attempts at a new socket before a replacement is given up on. */
/**
 * Only for a socket that dropped on its own. A forced reconnect or rebuild is a
 * remedy with its own place on a ladder bounded at 55s, so it gets ONE attempt:
 * five, each bounded only by `CONNECT_TIMEOUT_MS`, is over two and a half
 * minutes.
 */
const REOPEN_ATTEMPTS = 5;

/**
 * Clean sockets `renew` tries before it gives up and says so. With the backoff
 * in `refusalBackoffMs` four attempts span about seven seconds plus a connect
 * each, and the third refusal has already failed the model over.
 */
const RENEW_ATTEMPTS = 4;

/**
 * Taken off a `goAway`'s time left. The probes' warnings all said 50s and the
 * socket went at about that; a renewal needs a history read and a connect.
 */
const HANDOVER_MARGIN_MS = 8_000;

/** Rung three of the mid-round ladder, and what a resumed session is told. */
const REPLY_OWED_NOTE =
  'The candidate has finished speaking and is waiting for you. Respond out ' +
  'loud now, continuing the interview from where it left off. Do not ' +
  'apologise for the delay, do not mention any technical problem, and do ' +
  'not mention this note.';

/**
 * Clean rebuilds allowed for a server that stopped hearing the microphone.
 * Capped to prevent infinite rebuild loops if audio processing remains broken.
 */
const DEAF_REBUILDS = 2;

/** `LiveOptions.resumeContext`, appended to a note, or nothing when there is none. */
const withContext = (ctx: string | undefined) =>
  ctx ? `\n\nWhere the round stands now:\n${ctx}` : '';

/** Decoded length of base64, without decoding it. */
export function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

/** Playback length of base64 output PCM. */
export function outputAudioMs(b64: string): number {
  return (base64Bytes(b64) / (AUDIO.outputSampleRate * AUDIO.bytesPerSample)) * 1000;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** How long a sub-word transcript piece waits for the rest of its word. */
const INPUT_GLUE_MS = 800;

/** Wall-clock silence we allow before treating a pause as end-of-answer. */
const INTERVIEW_SILENCE_MS = 1400;
/**
 * Well above the API default. At 300ms a breath or a keyboard click registered
 * as the candidate starting to talk, barge-in fired, and the interviewer was
 * cut off mid-sentence — while the transcript, which arrives independently of
 * the audio, still showed the whole question.
 */
const INTERVIEW_PREFIX_PADDING_MS = 600;

/**
 * Compression kicks in well before the 15-minute audio-session ceiling so a
 * 45-minute interview survives. `triggerTokens` is an int64 serialised as a
 * string in the wire format — hence the string literals.
 *
 * A BACKSTOP only. On 3.1 it was measured not holding the context down (see
 * `context-budget.ts`); `renew` is what keeps a session small.
 */
const COMPRESSION = {
  triggerTokens: '25600',
  slidingWindow: { targetTokens: '12800' },
} as const;

/**
 * Owns exactly one upstream Live API socket and hides reconnection behind it.
 * Callers see a single continuous session even when the underlying WebSocket
 * is recycled (the API drops connections at ~10 minutes regardless of health).
 */
export class LiveInterviewSession {
  private readonly log = new Logger(LiveInterviewSession.name);
  private session?: Session;
  private resumptionHandle?: string;
  private closing = false;
  /**
   * Bumped whenever a socket is opened or discarded. Callbacks carry the value
   * they were opened under, so a replaced socket's late messages and its close
   * are ignored rather than re-entering `handleClose` for a socket we let go.
   */
  private generation = 0;
  /**
   * Epoch ms of the last send that asked for a reply, until the reply begins.
   * `modelTurnOpen` is false in that window, so without this a note could go
   * out on top of the reply just requested. See `REPLY_PENDING_MAX_MS`.
   */
  private replyRequestedAt = 0;
  private readonly notes = new NoteQueue(
    { free: () => this.lineFree(), send: (c) => this.sendContent(c) },
    this.log,
  );
  /**
   * Head of the current model turn's output transcript, held only while it is
   * still ambiguous whether the turn is a spurious system note.
   */
  private outHead = '';
  /** True once the model has produced any output audio at all, ever. */
  private everSpoke = false;
  /** Opening turns sent so far, including the first. See `OPENING_MAX_KICKOFFS`. */
  private kickoffCount = 0;
  /** Epoch ms the opening turn was FIRST asked for. See `OPENING_LADDER`. */
  private openingAskedAt = 0;
  /**
   * Whether the candidate has been told the opening has not arrived. Only a
   * DELIVERED opening may take that back, so the recovery cannot be reported
   * from the same place a mid-round one is.
   */
  private openingStallReported = false;
  /** Whether the one reconnect an opening turn wedged OPEN is allowed has run. */
  private wedgedOpenReconnected = false;
  /** Whether the session has been rebuilt from stored history. Allowed once. */
  private rebuilt = false;

  /** The server's own count of this session's context, from `usageMetadata`. See `context-budget.ts`. */
  private contextTokens = 0;
  /** The first count this socket reported: what renewing cannot get below. See `RENEW_MIN_GROWTH_TOKENS`. */
  private floorTokens = 0;
  /** Epoch ms a `goAway` arrived and the deadline to act on it by, or 0. */
  private handoverAt = 0;
  private handoverDeadline = 0;
  /** Refusals (1011 closes) in the recent window, which decide backoff and failover. */
  private readonly refusals = new RefusalTracker();
  /** Microphone audio no transcript has accounted for. See `mic-backlog.ts`. */
  private readonly backlog = new MicBacklog();
  /** Audio waiting to go out behind a paced replay, oldest first. */
  private replayQueue: QueuedChunk[] = [];
  private replayTimer?: NodeJS.Timeout;
  /** Silence sent in the current pause of a replay. See `REPLAY_KEEP_SILENCE_MS`. */
  private replaySilenceMs = 0;

  /**
   * Stall watchdog state, covering the whole round from the moment the opening
   * is asked for.
   *
   * It used to be armed by the model's first audio byte, leaving setup-to-first-
   * word watched only by `maybeRetryOpening` — which fires on a `turnComplete`
   * that a wedged upstream never sends.
   */
  private stallTimer?: NodeJS.Timeout;
  /** Epoch ms of the last output of ANY kind — audio, transcript, tool call. */
  private lastOutputAt = 0;
  /** Epoch ms of the last input transcription, interim or final. */
  private lastInputAt = 0;
  /**
   * Whether that last input was a COMMITTED utterance rather than an interim.
   *
   * Only a final proves the candidate had stopped talking, so only a gap that
   * STARTS at one is known to be silence — see `noteInput`.
   */
  private lastInputWasFinal = false;
  /**
   * True from the moment the candidate's speech is committed until the model
   * produces something. This is what makes the watchdog safe around silence:
   * a candidate thinking quietly at their editor is owed nothing, so nothing
   * fires, and the interviewer is never prodded into nagging them.
   */
  private awaitingReply = false;
  /** Epoch ms of the utterance that put the model in debt. See `checkStall`. */
  private awaitingSince = 0;
  /** Where the first silence banked against this debt began: the handback. */
  private debtQuietFrom = 0;
  /**
   * Quiet time already banked against the current debt, in ms — the sum of
   * every silence the candidate has left since they handed the floor back.
   * Reset by `noteOutput`, and by anything they say that takes the floor back
   * (see `floor`).
   *
   * This is the measure the ladder runs on, and it exists because the two
   * obvious measures are both wrong. See `checkStall`.
   */
  private owedQuietMs = 0;
  /**
   * The candidate's microphone, read for silence. The ladder's clock whenever
   * any audio has been seen — see `voice-activity.ts` for why transcription
   * timing cannot be it.
   */
  private readonly voice = new VoiceActivity(AUDIO.inputSampleRate);
  /** Whether the server is still transcribing that microphone. See `input-liveness.ts`. */
  private readonly liveness = new InputLiveness();
  /** Rebuilds spent on a server that stopped hearing the microphone. See `DEAF_REBUILDS`. */
  private deafRebuilds = 0;
  /** Set once the candidate has been told the server cannot hear them; said once. */
  private deafGivenUp = false;
  /** `deafFaultAfterMs`: when the round started, and whether a clean socket has ended the fault. */
  private faultFrom = 0;
  private faultCured = false;
  private faultLogged = false;
  /** The word `glueInput` is still assembling, and when it gives up waiting for the rest. */
  private inWord = '';
  private inWordTimer?: NodeJS.Timeout;
  /** Everything the candidate has said since the interviewer last produced output. */
  private floorText = '';
  /** Whose turn their words say it is. Decides the ladder's pace — see `checkStall`. */
  private floor: Floor = 'neutral';
  /** Epoch ms their words first handed the floor back on this debt. See `YIELD_WALL_CEILING`. */
  private yieldedAt = 0;
  /** `voice.voicedMs` when the floor last became a HOLD. See `noteVoiceResumed`. */
  private holdVoicedMs = 0;
  /** What the interviewer has said in the turn in progress. See `noteInterviewerTurn`. */
  private modelTurnText = '';
  /** Epoch ms of the candidate's last edit to their code, which is working, not waiting. */
  private lastWorkAt = 0;
  /**
   * The debt as it stood before this turn's first output, restored if the turn
   * turns out to be a fabricated note nobody heard. Output settles a debt on
   * ARRIVAL, and a suppressed note arrives like any turn — so without this a
   * candidate who asked for an example and got a silently dropped note was
   * owed a reply nothing was watching for.
   */
  private turnDebt: {
    awaitingReply: boolean;
    awaitingSince: number;
    owedQuietMs: number;
    debtQuietFrom: number;
    floor: Floor;
    floorText: string;
    yieldedAt: number;
  } | null = null;
  /**
   * Epoch ms the interviewer's audio delivered so far should finish PLAYING.
   * The server hands it over faster than real time, so the candidate is still
   * hearing a turn for seconds after its last byte — and anything the mic picks
   * up in that window may be the interviewer, not them.
   */
  private playbackEndsAt = 0;
  /** True between a turn's first output and its `turnComplete`/`interrupted`. */
  private modelTurnOpen = false;
  /**
   * True while tool calls are running — the model is working, not wedged:
   * `listen_to_round` alone can take tens of seconds to ingest a recording.
   */
  private toolCallPending = false;
  /** Highest `STALL_LADDER` rung already acted on for the current stall. */
  private stallStage = 0;
  /** True while we are deliberately recycling the socket; see `forceReconnect`. */
  private reconnecting = false;

  /** True once this turn's output has been classified and can flow straight through. */
  private outDecided = false;
  /**
   * True for the REST of a turn that turned out to be a fabricated note. The
   * marker only appears in the opening fragment, so without this the tail of
   * the note ("Time is running low. Close the round cleanly...") sailed through
   * the decided path and into the transcript anyway.
   */
  private outSuppressed = false;
  /**
   * True once this turn's opening has been recognised as a verbalised tool
   * call, which is held longer than a note sniff — see `ARTIFACT_SNIFF_CHARS`.
   */
  private outArtifact = false;
  /** Strips bracketed markup the model writes into its transcript. See `markup-filter.ts`. */
  private readonly markup = new MarkupFilter();

  /**
   * This turn's output audio, held while it is still possible that the turn is
   * a fabricated note. Flushed in arrival order or dropped whole, never
   * partially — see `AUDIO_HOLD_MAX_MS`.
   */
  private outAudioHeld: string[] = [];
  /**
   * Backstop that releases held audio on WALL time, not on how much of it has
   * piled up.
   *
   * A byte-counting cap only fires if more audio keeps arriving, so a short
   * turn whose transcript never came — output transcription lagging, or off —
   * would sit held until `turnComplete`. Muting a real interviewer is a worse
   * failure than the one this gate exists to prevent, so the deadline runs
   * whether or not anything else happens.
   */
  private outAudioTimer?: NodeJS.Timeout;
  /**
   * True once this turn's audio has started playing, whether because the turn
   * was cleared or because the cap ran out. Nothing is held after that: a gap
   * inserted mid-sentence is audible in a way the initial hold is not.
   */
  private outAudioReleased = false;
  /** Audio DELIVERED to the candidate this turn, in ms. See `onUntranscribedTurn`. */
  private turnAudioMs = 0;
  /** Whether any output transcript arrived for this turn, note or speech. */
  private turnTranscriptSeen = false;

  constructor(
    private readonly ai: GoogleGenAI,
    /** Not readonly: `checkDeaf` fails over to another model mid-round. */
    private model: string,
    private readonly opts: LiveOptions,
    private readonly events: LiveEvents,
  ) {}

  get handle() {
    return this.resumptionHandle;
  }

  /** The model this session actually connected to, which may be a fallback. */
  get modelId() {
    return this.model;
  }

  private get hasTools() {
    return !!this.opts.tools?.length;
  }

  /** Whether the model has ever produced audio. False means it has said nothing yet. */
  get hasSpoken() {
    return this.everSpoke;
  }

  async start(): Promise<void> {
    this.faultFrom = Date.now();
    await this.open();
    this.kickoff();
    // Armed here, not on the model's first word: the opening is a debt from the
    // moment we ask for it. See `OPENING_LADDER`.
    this.armStallWatchdog();
    // Queued before the opening turn can complete, so it goes out at that
    // boundary — i.e. the moment the model stops greeting.
    if (this.opts.deferredAudio) {
      this.queueAudioNote(this.opts.deferredAudio.text, this.opts.deferredAudio.audio);
    }
    this.events.onReady({ model: this.model });
  }

  /**
   * Re-sends the opening turn when one comes back having said nothing.
   *
   * Called only from `turnComplete`, which is what makes it safe: the turn is
   * over, so this cannot be the mid-turn barge-in the old timer version was.
   * It is also conditional on silence, so there is no history to restart —
   * which is what makes re-sending the primer dangerous everywhere else (see
   * `kickoff`).
   *
   * `everSpoke` is the test rather than "audio in this turn" because a model
   * that has spoken once does not need greeting again — after that, silence is
   * the stall watchdog's problem, not the opening's.
   */
  private maybeRetryOpening() {
    if (this.everSpoke || this.closing) return;
    if (this.kickoffCount + 1 >= OPENING_MAX_KICKOFFS) {
      this.log.error(
        `the opening turn came back empty ${this.kickoffCount + 1} times — giving up ` +
          `on greeting and leaving the round to the candidate`,
      );
      return;
    }
    this.kickoffCount += 1;
    this.log.warn(
      `the opening turn completed with no audio — re-sending it ` +
        `(attempt ${this.kickoffCount + 1})`,
    );
    this.kickoff();
  }

  /**
   * Starts watching for a wedged turn. Idempotent, and armed from `start`.
   *
   * It does not collide with `maybeRetryOpening`: that fires on a `turnComplete`
   * event and so acts the instant an empty opening is provably over, while this
   * is a clock and always sits further out. The ladder covers only the case
   * where that event never arrives.
   */
  private armStallWatchdog() {
    if (this.stallTimer) return;
    this.lastOutputAt = Date.now();
    /**
     * `unref` so a background timer can never be the reason the process stays
     * alive. It also keeps the offline suites honest: a session they never
     * close would otherwise hold the event loop open and hang the run.
     */
    this.stallTimer = setInterval(() => this.checkStall(), STALL_CHECK_MS);
    this.stallTimer.unref?.();
  }

  private clearStallWatchdog() {
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  /** Records that the model produced something, clearing any stall in progress. */
  private noteOutput() {
    this.replyRequestedAt = 0;
    // A turn already judged a fabricated note settles nothing: the rest of it
    // is more of the same note, and nobody hears it. The model is alive, though.
    if (this.outSuppressed) {
      this.lastOutputAt = Date.now();
      return;
    }
    // What this output is about to settle, kept until the turn proves the
    // candidate heard it. See `turnDebt`.
    this.turnDebt ??= {
      awaitingReply: this.awaitingReply,
      awaitingSince: this.awaitingSince,
      owedQuietMs: this.owedQuietMs,
      debtQuietFrom: this.debtQuietFrom,
      floor: this.floor,
      floorText: this.floorText,
      yieldedAt: this.yieldedAt,
    };
    this.lastOutputAt = Date.now();
    this.awaitingReply = false;
    this.yieldedAt = 0;
    // The debt is settled, so the quiet banked against it is spent too. A
    // later stall in the same round starts from zero and walks the ladder from
    // the cheapest rung again.
    this.spendQuiet();
    // What the candidate says next is a reply to THIS turn, so it is read on
    // its own. Whose floor it is now is decided when the turn ends, from what
    // the interviewer said — see `noteInterviewerTurn`.
    this.floorText = '';
    if (this.stallStage > 0) {
      const stage = this.stallStage;
      this.stallStage = 0;
      this.log.log(`interviewer recovered after a stall (was at rung ${stage})`);
      /**
       * Only once the round has a voice in it. Before that, a fragment is
       * something the SERVER produced and not something the candidate heard —
       * telling them "the interviewer is back" while they still sit in silence
       * is worse than the banner it clears. `deliverAudio` reports the opening
       * recovery instead, off actual delivery.
       */
      if (this.everSpoke) {
        this.events.onStall?.({
          stage: 0, silentMs: 0, outageMs: 0, remedy: 'recovered', action: 'recovered', recovered: true,
        });
      }
    }
  }

  /**
   * Records candidate input events (fallback for socket-free sessions without mic audio).
   *
   * Gaps between consecutive utterances are only banked as quiet when running from
   * a final transcript event to an interim, ensuring we only measure silence when
   * the candidate has stopped speaking.
   */
  private noteInput(final: boolean) {
    const now = Date.now();
    if (
      !this.voice.heard && this.floor === 'yield' && this.awaitingReply &&
      this.lastInputWasFinal && !final && this.lastInputAt > 0
    ) {
      const gap = now - this.lastInputAt;
      if (gap >= STALL_QUIET_MS) this.bankQuiet(this.lastInputAt, gap);
    }
    this.lastInputAt = now;
    this.lastInputWasFinal = final;
  }

  /**
   * A committed utterance, read for whose turn the candidate thinks it is.
   *
   * A request for time spends the quiet banked so far: they have taken the
   * floor back, and asked to keep it. See `floor-intent.ts`.
   */
  private noteUtterance(text: string) {
    this.floorText = `${this.floorText} ${text}`.slice(-FLOOR_TEXT_CHARS);
    const read = classifyFloor(this.floorText);
    /**
     * Narration inside a hold does not end it. "Sure, let's find" after "take
     * your time" is someone starting to think, and late transcription makes
     * this matter twice: the tail of the request itself — "…on how to
     * proceed" — can land after the interviewer has answered it and read, on
     * its own, as narration. A handback ends a hold; so does a new question
     * from the interviewer, or fifteen seconds of talk (`noteVoiceResumed`).
     */
    if (this.floor === 'hold' && read === 'neutral') return;
    if (read === 'hold') {
      this.spendQuiet();
      if (this.floor !== 'hold') this.holdVoicedMs = this.voice.voicedMs;
    }
    // An ask they talked on past (`ASK_TAIL_WORDS`): they took the floor back,
    // so the pauses banked while it stood were not waiting either.
    if (this.floor === 'yield' && read === 'neutral') this.spendQuiet();
    if (read === 'yield') this.yieldedAt ||= Date.now();
    else this.yieldedAt = 0;
    this.floor = read;
  }

  /**
   * The interviewer's turn has ended; what it said decides whose floor it is.
   * See `classifyInterviewerTurn`. A fabricated note is not something the
   * candidate heard, so it decides nothing.
   */
  private noteInterviewerTurn() {
    const said = this.modelTurnText;
    this.modelTurnText = '';
    if (!said.trim() || this.outSuppressed) return;
    const move = classifyInterviewerTurn(said);
    if (move === 'grant') {
      if (this.floor !== 'hold') this.holdVoicedMs = this.voice.voicedMs;
      this.floor = 'hold';
      this.spendQuiet();
    } else if (move === 'ask' || this.floor === 'yield') {
      this.floor = 'neutral';
    }
    this.yieldedAt = 0;
  }

  /**
   * Resets an active hold once sufficient candidate speech has accumulated.
   *
   * Measured across cumulative voice duration rather than a single utterance,
   * distinguishing brief thinking mutters from sustained resumption of speaking.
   */
  private noteVoiceResumed() {
    if (this.floor !== 'hold') return;
    if (this.voice.voicedMs - this.holdVoicedMs < HOLD_RESUME_VOICE_MS) return;
    this.floor = 'neutral';
    this.floorText = '';
  }

  /**
   * A silence in the candidate's audio has just ended. Banked against the debt
   * from the model's last output on, and only when it is long enough to be a
   * handback rather than a breath — which depends on whether their words have
   * handed the floor back (see `NEUTRAL_QUIET_MS`). Typing inside a neutral
   * silence makes it work rather than waiting, so only the part after the last
   * edit counts.
   */
  private noteSilenceEnded(from: number, to: number) {
    if (!this.awaitingReply || this.floor === 'hold') return;
    const yielded = this.floor === 'yield';
    const start = Math.max(from, this.lastOutputAt, yielded ? 0 : this.lastWorkAt);
    const gap = to - start;
    if (gap >= (yielded ? STALL_QUIET_MS : NEUTRAL_QUIET_MS)) this.bankQuiet(start, gap);
  }

  private bankQuiet(from: number, ms: number) {
    if (!this.owedQuietMs) this.debtQuietFrom = from;
    this.owedQuietMs += ms;
  }

  private spendQuiet() {
    this.owedQuietMs = 0;
    this.debtQuietFrom = 0;
  }

  /**
   * How long the candidate has been waiting on this debt, on the wall: from the
   * first silence banked against it, or from their last sound when none has
   * been. Never from the interviewer's last word — that counts the answer
   * itself, and a two-minute answer then reads as two minutes of dead line in
   * the budget refund and in the evaluator's measured outage.
   */
  private outageMs(now = Date.now()): number {
    const lastSound = Math.max(this.lastSoundAt(), this.lastOutputAt);
    const from = this.owedQuietMs > 0 ? Math.max(this.debtQuietFrom, this.lastOutputAt) : lastSound;
    return now - from;
  }

  /**
   * The candidate has plainly said something since the interviewer last spoke,
   * so the interviewer owes a reply whether or not the transcript has arrived.
   * Only speech that began after the interviewer's audio stopped PLAYING counts,
   * so its own voice leaking back through a speaker can never put it in debt.
   */
  private noteVoiceDebt() {
    if (this.awaitingReply || !this.everSpoke || this.voice.utteranceMs < VOICE_DEBT_MS) return;
    const began = this.voice.utteranceStartedAt;
    if (began <= Math.max(this.lastOutputAt, this.playbackEndsAt + PLAYBACK_SLACK_MS)) return;
    this.awaitingReply = true;
    this.awaitingSince = began;
  }

  /** When the candidate last made a sound — from the samples when there are any. */
  private lastSoundAt(): number {
    return this.voice.heard ? this.voice.lastVoiceAt : this.lastInputAt;
  }

  /**
   * The candidate changed their code. Typing is working, not waiting, so it
   * holds off the ladder exactly as speech does — except once they have asked
   * the interviewer something, which typing does not un-ask. See `checkStall`.
   */
  noteCandidateWorking() {
    this.lastWorkAt = Date.now();
  }

  /** The candidate's voice inside [from, to] by the microphone; 0 without one. See `VoiceActivity.voicedBetween`. */
  candidateVoicedMs(from: number, to = Date.now()): number {
    return this.voice.heard ? this.voice.voicedBetween(from, to) : 0;
  }

  private checkStall() {
    if (this.closing || this.reconnecting) return;
    if (this.toolCallPending) return;

    // Notes held behind a requested reply that never began go when it lapses.
    this.notes.flushIfFree();

    // A session past its budget is renewed before it can be refused. See `context-budget.ts`.
    if (this.maybeRenew()) return;

    /**
     * Before the first word the debt is the OPENING, owed from the moment we
     * asked for it rather than from anything the candidate did. The mid-round
     * measure below cannot see it: that one is gated on `awaitingReply`, which
     * only a committed candidate utterance sets. See `OPENING_LADDER`.
     */
    if (!this.everSpoke) {
      this.checkOpeningStall();
      return;
    }

    // Ahead of the ladder, which cannot see it: see `input-liveness.ts`.
    if (this.checkDeaf()) return;

    // Generation has started, and mid-round those bytes reach the candidate as
    // they arrive — which is what makes this enough here and not at the opening.
    if (this.modelTurnOpen) return;

    // Nothing is owed: the candidate has not finished an utterance since the
    // model last spoke. A silent candidate is thinking, not abandoned.
    if (!this.awaitingReply) return;

    /**
     * Candidate requested time. A hold is not an overdue reply debt; subsequent
     * candidate speech will reclassify the floor.
     */
    if (this.floor === 'hold') return;

    const now = Date.now();
    /**
     * Evaluates stall rungs based on conversational floor state.
     *
     * In 'yield', accumulated silence and wall time measure candidate wait time
     * even across repeated check-ins. In 'neutral', only pauses longer than
     * `NEUTRAL_QUIET_MS` count, protecting ongoing thinking and typing.
     */
    const lastSound = Math.max(this.lastSoundAt(), this.lastOutputAt);
    if (now - lastSound < STALL_QUIET_MS) return;
    const silentMs = this.owedQuietMs +
      (now - (this.floor === 'yield' ? lastSound : Math.max(lastSound, this.lastWorkAt)));
    const quietRung = STALL_LADDER.filter((at) => silentMs >= at).length;
    const waitedMs = this.floor === 'yield' && this.yieldedAt ? now - this.yieldedAt : 0;
    const wallRung = waitedMs ? yieldCeilingRung(waitedMs, this.stallStage) : 0;
    const rung = Math.max(quietRung, wallRung);
    if (rung === 0 || rung <= this.stallStage) return;
    this.stallStage = rung;
    this.escalateStall(rung, silentMs, wallRung > quietRung ? waitedMs : undefined);
  }

  /** Whether `deafFaultAfterMs` has started dropping audio on this round. */
  private faultBegun(now = Date.now()): boolean {
    const after = this.opts.deafFaultAfterMs;
    return !!after && !!this.faultFrom && now - this.faultFrom >= after;
  }

  /**
   * The injected fault: audio reaches local components but is dropped upstream,
   * simulating an upstream audio ingestion failure across handle resumptions.
   */
  private faultDeaf(now: number): boolean {
    if (this.faultCured || !this.faultBegun(now)) return false;
    if (!this.faultLogged) {
      this.faultLogged = true;
      this.log.warn('E2E FAULT: dropping microphone audio upstream until a clean socket replaces this one');
    }
    return true;
  }

  private voiceReading() {
    return {
      lastVoiceAt: this.voice.lastVoiceAt,
      voicedBetween: (from: number, to: number) => this.voice.voicedBetween(from, to),
    };
  }

  /**
   * The server has stopped hearing the microphone. Rebuilds a clean socket
   * rather than resuming the existing session handle.
   */
  private checkDeaf(): boolean {
    // Only the interviewer has a round to rebuild; the coach and mentor keep the ladder.
    if (!this.opts.history || this.deafGivenUp || !this.voice.heard || !this.session) return false;
    const now = Date.now();
    if (!this.liveness.observe(now, this.voiceReading(), this.playbackEndsAt)) return false;
    // Nothing goes upstream into an open turn, and a rebuild sends the round.
    if (this.modelTurnOpen) return false;

    const lostMs = this.liveness.missedVoiceMs;
    const outageMs = now - this.liveness.missedSince;
    const what =
      `the server stopped hearing the microphone: ${this.liveness.missedCommits} pauses and ` +
      `${(lostMs / 1000).toFixed(0)}s of the candidate's speech with no transcript`;
    // Cleared first, so the ticks while the socket is replaced cannot fire again.
    this.liveness.reset(now);
    this.stallStage = STALL_LADDER.length;

    if (this.deafRebuilds < DEAF_REBUILDS) {
      this.deafRebuilds += 1;
      const deafModel = this.model;
      const next = this.opts.failover?.(deafModel);
      if (next) this.model = next;
      const action =
        `${what} — rebuilding on a clean socket` +
        (next ? ` on ${next} (${deafModel} marked deaf)` : '') +
        ` (${this.deafRebuilds}/${DEAF_REBUILDS})`;
      this.log.error(action);
      this.events.onStall?.({
        stage: STALL_LADDER.length, silentMs: lostMs, outageMs, remedy: 'rebuild', action, deaf: true,
      });
      void this.rebuild(lostMs);
      return true;
    }
    this.deafGivenUp = true;
    this.reportUnrecoverable(`${what}, and the clean rebuilds are spent`, true);
    return true;
  }

  /**
   * The opening debt, climbed on its own absolute clock. See `OPENING_LADDER`.
   */
  private checkOpeningStall() {
    if (!this.openingAskedAt) return;
    const now = Date.now();
    /**
     * Never nudge over the candidate's voice. Transcript-timed on purpose,
     * unlike mid-round: a candidate repeating "hello, can you hear me?" keeps
     * the microphone's gaps under `STALL_QUIET_MS`, and because a rung is the
     * highest one PASSED, a mic-timed guard held every remedy off and then
     * jumped straight to the last rung after 55s.
     */
    if (this.lastInputAt > 0 && now - this.lastInputAt < STALL_QUIET_MS) return;

    /**
     * An open turn suspends the ladder, but only while it is still PRODUCING:
     * past `OPENING_DEAD_TURN_MS` an open turn that has delivered the candidate
     * nothing is the failure rather than a reason to keep waiting.
     */
    const wedgedOpen = this.modelTurnOpen && now - this.lastOutputAt >= OPENING_DEAD_TURN_MS;
    if (this.modelTurnOpen && !wedgedOpen) return;

    const waitingMs = now - this.openingAskedAt;
    const rung = OPENING_LADDER.filter((at) => waitingMs >= at).length;
    if (rung === 0 || rung <= this.stallStage) return;
    this.stallStage = rung;
    this.escalateOpeningStall(rung, waitingMs, wedgedOpen);
  }

  /**
   * The opening counterpart of `escalateStall`. The remedy differs because the
   * fault does: there is no conversation to advance, so what needs repairing is
   * the primer — and re-sending it is safe here in a way it never is later,
   * since a model that has said nothing has no history for it to clobber.
   */
  private escalateOpeningStall(rung: number, waitingMs: number, wedgedOpen = false) {
    const secs = (waitingMs / 1000).toFixed(0);
    let remedy: StallRemedy;
    let action: string;

    if (wedgedOpen) {
      /**
       * Every cheap rung below is client content sent into the open turn, so
       * the only move left is the one that sends nothing and throws the turn
       * state away with the socket. It also consumes rung 4: the new socket is
       * kicked off by `forceReconnect`, and climbing back to rung 4 would send a
       * second primer on top of that one.
       */
      this.stallStage = Math.max(this.stallStage, 4);
      if (!this.wedgedOpenReconnected) {
        remedy = 'reconnect';
        action = 'forced reconnect on a clean session (the opening turn is open and dead)';
        this.wedgedOpenReconnected = true;
        void this.forceReconnect(false);
      } else {
        /**
         * Once. A fresh socket that opens a turn and dies the same way is not
         * going to be fixed by a third one, and the dribble — a fragment every
         * so often — resets `stallStage` through `noteOutput` each time, so
         * without this the round would recycle sockets until the candidate
         * left.
         */
        remedy = 'none';
        action = 'the opening turn wedged open again; the reconnect allowance is spent';
        this.log.error(
          `the opening turn has been open and silent for ${secs}s and ${action} — ` +
            'nothing can be sent into a live turn, so there is no remedy left',
        );
      }
    } else if (rung === 1 && !liveModelQuirks(this.model).bareTurnComplete) {
      remedy = 'none';
      action = `no silent nudge: ${this.model} closes the socket on one`;
    } else if (rung === 1) {
      remedy = 'nudge';
      action = 'silent turn-completion nudge';
      this.sendContent({ turnComplete: true });
    } else if (rung <= 3 && this.kickoffCount + 1 < OPENING_MAX_KICKOFFS) {
      remedy = 'primer';
      action = 're-sent the opening primer';
      this.kickoffCount += 1;
      this.kickoff();
    } else if (rung === 4) {
      /**
       * Without the handle. A resumed session restores a session whose entire
       * history is the opening that never arrived — nothing to preserve and, if
       * the wedge is in that state, everything to lose. Mid-round the trade is
       * the other way round, which is why `escalateStall` keeps it.
       */
      remedy = 'reconnect';
      action = 'forced reconnect on a clean session';
      void this.forceReconnect(false);
    } else if (rung >= 5) {
      remedy = 'unrecoverable';
      action = 'unrecoverable';
      this.log.error(
        `the interviewer never said a word in ${secs}s and a full opening ladder — ` +
          'giving up and telling the candidate',
      );
    } else {
      remedy = 'none';
      action = 'the kickoff allowance is spent';
    }

    if (rung < 5) {
      this.log.warn(
        `the interviewer has not spoken ${secs}s into the round ` +
          `(rung ${rung}/${OPENING_LADDER.length}) — ${action}`,
      );
    }
    this.openingStallReported = true;
    // At the opening the outage IS the wait: nothing has been produced yet.
    this.events.onStall?.({
      stage: rung, silentMs: waitingMs, outageMs: waitingMs, remedy, action, opening: true,
    });
  }

  /**
   * Works up from the cheapest remedy to the most disruptive, because the
   * cheapest one is also the one that cannot do any harm. `walledMs` is set
   * when `YIELD_WALL_CEILING` rather than banked quiet decided the rung, and
   * says so in the persisted action.
   */
  private escalateStall(rung: number, silentMs: number, walledMs?: number) {
    const secs = (silentMs / 1000).toFixed(0);
    let remedy: StallRemedy;
    let action: string;

    if (rung <= 2) {
      /**
       * A bare `turnComplete` with no `turns`. The SDK defines this as "server
       * content generation should start with the currently accumulated
       * prompt" — which is precisely the wedged state: the candidate's speech
       * is already sitting in the server's buffer and generation was never
       * started on it.
       *
       * It adds NOTHING to the conversation, which is what makes it the right
       * first move. A text note at this point would be read aloud, imitated
       * back as a fabricated system note, or land in the transcript the
       * evaluator reads. This is invisible to all three.
       *
       * Except on a model that rejects it (`liveModelQuirks`): there the nudge
       * drops the socket, and the ladder waits for the note instead.
       */
      if (liveModelQuirks(this.model).bareTurnComplete) {
        remedy = 'nudge';
        action = 'silent turn-completion nudge';
        this.sendContent({ turnComplete: true });
      } else {
        remedy = 'none';
        action = `no silent nudge: ${this.model} closes the socket on one`;
      }
    } else if (rung === 3) {
      remedy = 'note';
      action = 'explicit note asking for a reply';
      this.sendUrgentNote(REPLY_OWED_NOTE);
    } else if (rung === 4) {
      /**
       * The socket is provably alive — it is still delivering the candidate's
       * transcription — so this is not reconnecting a dead connection. It is
       * discarding the server-side turn state that will not start generating,
       * which a resumed session rebuilds from the handle.
       */
      if (this.resumptionHandle) {
        remedy = 'reconnect';
        action = 'forced reconnect';
        void this.forceReconnect();
      } else {
        remedy = 'none';
        action = 'no resumption handle to reconnect with — leaving it to the rebuild rung';
      }
    } else if (rung === 5 && this.opts.history && !this.rebuilt) {
      /**
       * The handle did not help, which is the one outcome that points at the
       * resumed session carrying the wedge with it. Rebuild from our own
       * transcript instead — see `rebuild`.
       */
      remedy = 'rebuild';
      action = 'rebuilding the session from the stored transcript';
      void this.rebuild();
    } else {
      remedy = 'unrecoverable';
      action = 'unrecoverable';
      this.log.error(
        `interviewer still silent after ${secs}s and a full recovery ladder — ` +
          'giving up and telling the candidate',
      );
    }
    if (walledMs !== undefined) {
      action = `${action} (wall-clock ceiling: ${(walledMs / 1000).toFixed(0)}s since the handback)`;
    }

    if (rung < 5) {
      /**
       * Both numbers, because they diverge precisely when this is most worth
       * reading: the elapsed one shows how long the candidate has actually
       * been stuck, the quiet one shows why the ladder took until now.
       */
      const elapsed = this.awaitingSince ? ((Date.now() - this.awaitingSince) / 1000).toFixed(0) : '?';
      this.log.warn(
        `interviewer has owed a reply for ${elapsed}s (${secs}s of it with the floor ` +
          `handed back) (rung ${rung}/${STALL_LADDER.length}) — ${action}`,
      );
    }
    this.events.onStall?.({ stage: rung, silentMs, outageMs: this.outageMs(), remedy, action });
  }

  /**
   * A socket replacement that could not open a new socket at all. The round is
   * then genuinely without an interviewer, and saying anything softer — the
   * "Reconnected. Carry on." this used to leave standing — is a lie. Reported
   * as the ladder's last rung, so the gateway tells the candidate to end the
   * round and have what they said scored, rather than failing the round.
   */
  private reportUnrecoverable(action: string, deaf = false) {
    const opening = !this.everSpoke;
    const stage = opening ? OPENING_LADDER.length : STALL_LADDER.length;
    this.stallStage = Math.max(this.stallStage, stage);
    const outageMs = opening ? Date.now() - this.openingAskedAt : this.outageMs();
    this.log.error(`${action} — the interviewer is gone`);
    this.events.onStall?.({
      stage,
      silentMs: outageMs,
      outageMs,
      remedy: 'unrecoverable',
      action,
      ...(opening ? { opening: true } : {}),
      ...(deaf ? { deaf: true } : {}),
    });
  }

  /**
   * The final escalation rung: opens a clean socket without a resumption handle
   * and replays conversation history from local database records.
   *
   * Used when in-session reconnection fails to clear an upstream generation wedge.
   * `lostVoiceMs` indicates missed audio from an unhearing socket.
   */
  private async rebuild(lostVoiceMs?: number) {
    if (this.closing || this.reconnecting) return;
    if (!this.opts.history) {
      this.log.error('cannot rebuild the session: no history supplier was given');
      return;
    }
    const deaf = lostVoiceMs !== undefined;
    /**
     * Once per round, attempted or not. A rebuilt session that wedges the same
     * way will not be fixed by a third socket, and `noteOutput` clears
     * `stallStage` on any fragment — so a model dribbling one fragment per rung
     * would otherwise rebuild the round until the candidate left.
     */
    if (!deaf && this.rebuilt) {
      this.log.error('the session has already been rebuilt once; not doing it again');
      return;
    }
    if (!deaf) this.rebuilt = true;

    this.reconnecting = true;
    let failure: string | undefined;
    try {
      failure = await this.replaceFromHistory({ owed: true, missedVoiceMs: lostVoiceMs, why: deaf ? 'deaf' : 'wedged' });
    } finally {
      this.reconnecting = false;
      // A replay started inside the swap waited for it to finish.
      this.pumpReplay();
    }
    if (this.closing) return;
    if (failure) {
      this.reportUnrecoverable(failure);
      return;
    }
    this.events.onReconnected();
  }

  /**
   * Swaps the socket for a clean one rebuilt from our local record of the
   * conversation: turns replayed as text followed by uncommitted candidate audio.
   * Delivered as a single client turn so generation does not begin prematurely.
   */
  private async replaceFromHistory(o: {
    owed: boolean;
    missedVoiceMs?: number;
    why: string;
    waitMs?: number;
  }): Promise<string | undefined> {
    const tokens = this.contextTokens;
    let history: { role: 'user' | 'model'; text: string }[] = [];
    try {
      history = await this.opts.history!();
    } catch (err) {
      const failure = `the rebuild could not read the stored transcript: ${(err as Error).message}`;
      this.noteUpstream({ kind: 'renew_failed', why: o.why, reason: failure, tokens });
      return failure;
    }
    if (o.waitMs) await sleep(o.waitMs);
    if (this.closing) return undefined;
    // The handle IS the thing being discarded, and clearing it keeps a later
    // goAway-driven resume from restoring it either.
    this.resumptionHandle = undefined;
    this.discardSocket();
    if (!(await this.reopen(0))) {
      const failure = 'the rebuild could not open a socket';
      this.noteUpstream({ kind: 'renew_failed', why: o.why, reason: failure, tokens });
      return failure;
    }
    if (this.closing) return undefined;

    const replay = this.backlog.takeForReplay((a, b) => this.voice.voicedBetween(a, b), 'all');
    const audioFollows = replay.length > 0;
    const other = this.opts.historyLabel ?? 'CANDIDATE';
    const transcript = history.length
      ? '[THE CONVERSATION SO FAR — word for word, oldest first]\n' +
        history.map((h) => `${h.role === 'model' ? 'YOU' : other}: ${h.text}`).join('\n') +
        '\n\n'
      : '';
    const turns: NonNullable<ClientContent['turns']> = [
      { role: 'user', parts: [{ text: transcript + this.resumeText({ owed: o.owed, missedVoiceMs: o.missedVoiceMs, audioFollows }) }] },
    ];
    // With audio to follow, the reply is the server's to start when that audio
    // ends — asking for one now would be answered, then barged into by the replay.
    const requestReply = o.owed && !audioFollows;
    this.sendContent({ turns, turnComplete: requestReply });
    this.handoverAt = 0;
    this.handoverDeadline = 0;
    this.log.warn(
      `session rebuilt from ${history.length} stored turns (${o.why}; the old context was ${tokens} tokens)`,
    );
    this.noteUpstream({ kind: 'renewed', why: o.why, tokens });
    if (audioFollows) this.startReplay(replay);
    else this.replayQueue = [];
    // Whatever waited for a boundary goes now, onto the new socket.
    if (!requestReply) this.notes.flushAtBoundary();
    return undefined;
  }

  /** The instruction after the replayed turns. See `LiveOptions.resumeNote`. */
  private resumeText(o: { owed: boolean; missedVoiceMs?: number; audioFollows: boolean }): string {
    const ctx = withContext(this.opts.resumeContext?.({ withCode: true }));
    if (this.opts.resumeNote) return this.opts.resumeNote(o) + ctx;
    return (
      '[SESSION RESUMED] The connection to you dropped and has been remade. ' +
      'The conversation above is what has already been said in this interview — ' +
      'YOU are the interviewer — and the candidate heard all of it.\n\n' +
      'Do NOT greet them, do NOT introduce yourself, do NOT restate the ' +
      'problem, and do NOT ask anything you have already asked. Do not ' +
      'mention the connection, this note, or any technical problem. ' +
      (o.audioFollows
        ? 'The candidate\'s most recent words are not in the transcript above: they ' +
          'follow this note as audio. Listen to them, and when they finish, reply as ' +
          'if you had been listening throughout.'
        : o.missedVoiceMs !== undefined
          ? `After the last message above the candidate kept talking for about ` +
            `${Math.max(1, Math.round(o.missedVoiceMs / 1000))} seconds, and none of it ` +
            'reached you. Do not guess at what they said or answer anything above ' +
            'as if it were their latest point. In one short sentence, tell them you ' +
            'missed what they just said and ask them to take you through it again.'
          : o.owed
            ? 'Simply reply to the candidate\'s last message as if you had been ' +
              'listening throughout — and if they asked you something, answer that.'
            : 'Nothing is owed right now: the candidate has the floor. Say nothing ' +
              'until they speak, then carry on exactly where you left off.') +
      ctx
    );
  }

  /**
   * Renews the session on a clean socket, from our own record, until one holds:
   * a refusal backs off and, repeated, fails the model over. See
   * `context-budget.ts` for why the server's handle is not trusted here.
   */
  private async renew(why: 'budget' | 'handover' | 'refused' | 'dropped', firstWaitMs = 0): Promise<void> {
    if (this.closing || this.reconnecting || !this.opts.history) return;
    this.reconnecting = true;
    let failure: string | undefined;
    try {
      let waitMs = firstWaitMs;
      for (let attempt = 1; attempt <= RENEW_ATTEMPTS; attempt++) {
        failure = await this.replaceFromHistory({ owed: this.awaitingReply, why, waitMs });
        if (this.closing || !failure) break;
        const n = this.refusals.record(Date.now());
        this.maybeFailOver(n);
        waitMs = refusalBackoffMs(n + 1);
      }
    } finally {
      this.reconnecting = false;
      // A replay started inside the swap waited for it to finish.
      this.pumpReplay();
    }
    if (this.closing) return;
    if (failure) {
      this.reportUnrecoverable(`${failure}, ${RENEW_ATTEMPTS} times`);
      return;
    }
    // A planned renewal is invisible by design; a refused or dropped socket was
    // a hiccup the candidate may have noticed.
    if (why === 'refused' || why === 'dropped') this.events.onReconnected();
  }

  /** After enough refusals in the window, moves to the next live model. See `REFUSALS_BEFORE_FAILOVER`. */
  private maybeFailOver(refusalsInWindow: number) {
    if (refusalsInWindow < REFUSALS_BEFORE_FAILOVER) return;
    const from = this.model;
    const next = this.opts.failover?.(from);
    if (!next || next === from) return;
    this.model = next;
    this.refusals.clear();
    this.log.error(`${from} refused the session ${refusalsInWindow} times — failing over to ${next}`);
    this.noteUpstream({ kind: 'failover', why: `${refusalsInWindow} refusals`, reason: `${from} -> ${next}` });
  }

  /**
   * Renews the session when its context has outgrown the budget, at a moment
   * nobody is speaking — or regardless, once it is overdue or the server's
   * handover deadline is up. Returns whether it started one.
   */
  private maybeRenew(): boolean {
    if (this.closing || this.reconnecting || !this.session || !this.opts.history || !this.everSpoke) return false;
    if (this.toolCallPending || this.modelTurnOpen) return false;
    const now = Date.now();
    const budget = liveModelQuirks(this.model).contextBudget;
    const handover = this.handoverAt > 0;
    if (!renewalDue(this.contextTokens, budget, handover, this.floorTokens)) return false;
    const pressed = handover
      ? now >= this.handoverDeadline
      : this.contextTokens >= budget.renewAt + RENEW_OVERDUE_TOKENS;
    const quiet =
      now - this.lastSoundAt() >= RENEW_QUIET_MS &&
      !this.awaitingReply &&
      (!this.replyRequestedAt || now - this.replyRequestedAt >= REPLY_PENDING_MAX_MS);
    if (!quiet && !pressed) return false;
    void this.renew(handover ? 'handover' : 'budget');
    return true;
  }

  /**
   * Gives a freshly opened socket the audio it has not heard: everything no
   * transcript accounts for when it is clean, only what arrived while there was
   * no socket when it resumed a handle.
   */
  private replayHeld(which: 'all' | 'unsent') {
    const chunks = this.backlog.takeForReplay((a, b) => this.voice.voicedBetween(a, b), which);
    // Whatever an interrupted replay left queued is in `chunks` already, or is silence.
    if (chunks.length) this.startReplay(chunks);
    else this.replayQueue = [];
  }

  /** Paced replay of held microphone audio onto the current socket. See `mic-backlog.ts`. */
  private startReplay(chunks: QueuedChunk[]) {
    const ms = chunks.reduce((n, c) => n + base64PcmMs(c.data), 0);
    this.log.log(`replaying ${(ms / 1000).toFixed(1)}s of held microphone audio at ${liveModelQuirks(this.model).replaySpeed}x`);
    this.noteUpstream({ kind: 'backlog_replayed', replayedMs: Math.round(ms) });
    // Anything queued behind an earlier replay is in the backlog too, so this replaces it.
    this.replayQueue = chunks;
    this.replaySilenceMs = 0;
    this.pumpReplay();
  }

  private pumpReplay() {
    if (this.replayTimer) return;
    const next = () => {
      this.replayTimer = undefined;
      if (this.closing) {
        this.replayQueue = [];
        return;
      }
      // No socket: the backlog still holds all of it for the next one.
      if (!this.session || this.reconnecting) return;
      let chunk = this.replayQueue.shift();
      // The tail of a long pause is dropped: it is how a replay catches up.
      while (chunk && !chunk.voiced && this.replaySilenceMs >= REPLAY_KEEP_SILENCE_MS) chunk = this.replayQueue.shift();
      if (!chunk) return;
      const ms = base64PcmMs(chunk.data);
      this.replaySilenceMs = chunk.voiced ? 0 : this.replaySilenceMs + ms;
      this.session.sendRealtimeInput({ audio: { data: chunk.data, mimeType: AUDIO.inputMimeType } });
      this.replayTimer = setTimeout(next, ms / liveModelQuirks(this.model).replaySpeed);
      this.replayTimer.unref?.();
    };
    next();
  }

  /**
   * Logs why the server ended a turn whenever a non-routine completion reason is reported.
   * Records the turn's trailing text alongside the completion reason for diagnostic tracking.
   */
  private noteTurnReason(reason: TurnCompleteReason | undefined) {
    if (!reason || reason === TurnCompleteReason.TURN_COMPLETE_REASON_UNSPECIFIED) return;
    const routine = reason === TurnCompleteReason.NEED_MORE_INPUT;
    const tail = this.modelTurnText.trim().slice(-200);
    if (!routine) this.log.warn(`turn ended with ${reason}: ${tail}`);
    this.noteUpstream({ kind: 'turn_reason', why: reason, ...(routine ? {} : { reason: tail }) });
  }

  private noteUpstream(e: Omit<UpstreamEvent, 'at' | 'model'> & { model?: string }) {
    this.events.onUpstream?.({ at: Date.now(), model: this.model, tokens: this.contextTokens, ...e });
  }

  /**
   * Recycles the upstream socket on purpose.
   *
   * `keepHandle: false` throws the server's session state away with the socket.
   * That is right at the OPENING, where the handle can only restore a session
   * whose single turn is the one that wedged.
   */
  private async forceReconnect(keepHandle = true) {
    if (this.closing || this.reconnecting) return;
    if (keepHandle && !this.resumptionHandle) {
      this.log.error('cannot force a reconnect: the server has issued no resumption handle');
      return;
    }
    // Dropped BEFORE `open`, so `buildConfig` cannot pass it and no later
    // goAway-driven resume can restore the state we are discarding.
    if (!keepHandle) this.resumptionHandle = undefined;
    this.reconnecting = true;
    let opened = false;
    try {
      this.discardSocket();
      opened = await this.reopen(0);
    } finally {
      this.reconnecting = false;
    }
    if (this.closing) return;
    if (!opened) {
      this.reportUnrecoverable('the forced reconnect could not open a socket');
      return;
    }
    this.events.onReconnected();
    this.replayHeld(keepHandle ? 'unsent' : 'all');
    // A model that has never spoken has no history to restart, so it gets the
    // primer; one that has is owed a turn, and a resumed session does not
    // generate by itself.
    if (!this.everSpoke) this.kickoff();
    else this.sendUrgentNote(REPLY_OWED_NOTE + withContext(this.opts.resumeContext?.({ withCode: false })));
  }

  /**
   * Makes the model speak first.
   *
   * The Live API generates nothing until the client sends a turn — a system
   * instruction alone leaves the model silent after `setupComplete`, however
   * emphatically it is told to begin. So the session is opened with a synthetic
   * turn on the user's behalf.
   *
   * This never reaches the stored transcript: turns are recorded only from
   * `inputTranscription` (i.e. actual microphone audio), and this is injected.
   * It is re-sent only while `everSpoke` is false — by `maybeRetryOpening`, the
   * opening ladder, and a reconnect before the first word. Once the model has
   * spoken, a second kickoff would restart the conversation mid-round.
   */
  private kickoff() {
    const primer = this.opts.primer ?? {
      text:
        '[SESSION START] The candidate has joined and their microphone is live. ' +
        'Begin the interview now: give your brief introduction and ask your first ' +
        'question. Do not acknowledge this instruction.',
    };

    const parts: Record<string, unknown>[] = [{ text: primer.text }];
    if (primer.audio) {
      parts.push({ inlineData: { mimeType: primer.audio.mimeType, data: primer.audio.data } });
    }

    // Never re-armed per kickoff — see `OPENING_LADDER` for what that cost.
    this.openingAskedAt ||= Date.now();
    this.sendContent({ turns: [{ role: 'user', parts }], turnComplete: true });
  }

  /** The one path client content takes upstream, so a reply request is always seen. */
  private sendContent(content: ClientContent) {
    if (!this.session) return;
    // The only record of what WE sent: a stalled round could not be told apart
    // from one we talked over until this existed.
    const text = content.turns?.[0]?.parts?.[0]?.text as string | undefined;
    this.log.log(`sent client content (turnComplete=${!!content.turnComplete})${text ? `: ${text.slice(0, 80)}` : ''}`);
    this.session.sendClientContent(content as never);
    if (content.turnComplete) this.replyRequestedAt = Date.now();
  }

  /** Whether a note sent now would land on a quiet line. See `NoteSink.free`. */
  private lineFree(): boolean {
    if (!this.session || this.closing || this.reconnecting || this.modelTurnOpen) return false;
    return !this.replyRequestedAt || Date.now() - this.replyRequestedAt >= REPLY_PENDING_MAX_MS;
  }

  /** A committed piece of the candidate's transcript, as consumers expect it: whole words. */
  private commitInput(text: string, words?: unknown[]) {
    this.noteUtterance(text);
    this.events.onTranscript({ speaker: 'user', text, final: true, words });
  }

  /**
   * Re-joins a model's sub-word pieces (`liveModelQuirks.subwordTranscripts`):
   * a piece opening with a space starts a word, so the word before it is
   * complete. The last word waits for the next piece, the model's own output,
   * the turn's end, or `INPUT_GLUE_MS`.
   */
  private glueInput(text: string) {
    if (/^\s/.test(text)) this.flushInput();
    this.inWord += text;
    if (this.inWordTimer) clearTimeout(this.inWordTimer);
    this.inWordTimer = setTimeout(() => this.flushInput(), INPUT_GLUE_MS);
    this.inWordTimer.unref?.();
  }

  private flushInput() {
    if (this.inWordTimer) clearTimeout(this.inWordTimer);
    this.inWordTimer = undefined;
    const word = this.inWord.trim();
    this.inWord = '';
    if (word) this.commitInput(word);
  }

  /** Lets go of the current socket, so nothing it still says is listened to. */
  private discardSocket() {
    this.flushInput();
    this.generation += 1;
    try {
      this.session?.close();
    } catch {
      /* already gone — replacing it is the point */
    }
    this.session = undefined;
    // A turn on a socket we let go of can never complete, so neither flag may
    // outlive it: carried over, they blind both ladders and hold every note.
    this.modelTurnOpen = false;
    this.replyRequestedAt = 0;
  }

  /**
   * Opens a replacement socket, retrying with backoff. `closing` is re-read
   * after every wait, and `open` itself refuses a socket that finished opening
   * after `close()`.
   */
  private async reopen(firstWaitMs: number, attempts = 1): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const wait = attempt === 1 ? firstWaitMs : Math.min(250 * 2 ** (attempt - 1), 4_000);
      if (wait) await sleep(wait);
      if (this.closing) return false;
      try {
        await this.open();
        return true;
      } catch (err) {
        this.log.warn(
          `opening a replacement socket failed (attempt ${attempt}/${attempts}): ` +
            `${(err as Error).message}`,
        );
      }
    }
    return false;
  }

  private buildConfig() {
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: this.opts.systemInstruction }] },

      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: liveVoiceFor(this.model, this.opts.voice) } },
        languageCode: 'en-US',
      },

      /**
       * VERBATIM keeps the filler words, false starts and repetitions that the
       * delivery analysis is entirely built on. SMART mode would strip exactly
       * the signal we are trying to measure.
       */
      inputAudioTranscription: {
        mode: AudioTranscriptionConfigMode.VERBATIM,
        languageCodes: ['en-US'],
        /**
         * Vocabulary biasing rather than word timestamps. Gemini rejects the
         * two together ("custom_vocabulary is incompatible with timestamps") on
         * BOTH the Live API and gemini-3.5-transcribe, so the capability has to
         * be split across the two passes:
         *
         *   here (live)     -> vocabulary. `wordTimestamp: true` was measured
         *                      returning zero word objects on this model, so it
         *                      bought nothing while costing accuracy on exactly
         *                      the technical terms that matter.
         *   step 2 (offline)-> timestamps. gemini-3.5-transcribe does return
         *                      word offsets and speaker labels, and is audibly
         *                      more accurate ("Sure. My approach" where the
         *                      live pass heard "Show my approach").
         */
        customVocabulary: [...TECHNICAL_VOCABULARY, ...(this.opts.vocabulary ?? [])],
      },
      /** The AI's own speech only needs to be readable in the report. */
      outputAudioTranscription: { mode: AudioTranscriptionConfigMode.SMART },

      realtimeInputConfig: {
        automaticActivityDetection: {
          // Omitted where the model cannot hear through it — see `liveModelQuirks`.
          ...(liveModelQuirks(this.model).lowStartSensitivity
            ? { startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW }
            : {}),
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
          prefixPaddingMs: this.opts.prefixPaddingMs ?? INTERVIEW_PREFIX_PADDING_MS,
          silenceDurationMs: this.opts.silenceDurationMs ?? INTERVIEW_SILENCE_MS,
        },
        /** Barge-in stays on: interrupting the interviewer is realistic. */
        activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
        turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
      },

      // NOTE: `proactivity: { proactiveAudio: true }` would let the model stay
      // silent when the candidate is only thinking aloud, but the Developer API
      // rejects the field on this model ("Unknown name proactivity"). The long
      // silenceDurationMs above covers the same ground for now.

      /**
       * Deliberately OFF. Affective dialog makes the model soften when it hears
       * nervousness — which is the opposite of what a practice interview needs,
       * and it would contaminate the very signal the evaluator scores.
       */
      enableAffectiveDialog: false,

      ...(this.opts.tools?.length
        ? { tools: [{ functionDeclarations: this.opts.tools }] }
        : {}),

      contextWindowCompression: COMPRESSION,
      /**
       * Passing the config at all is what makes the server emit resumption
       * handles. `transparent` is deliberately omitted — it is accepted only on
       * the Vertex/Enterprise endpoint and hard-fails the Developer API.
       */
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},

      temperature: 0.75,
    };
  }

  private async open(): Promise<void> {
    const gen = ++this.generation;
    const current = () => gen === this.generation;
    const resuming = !!this.resumptionHandle;
    /**
     * Deliberately not awaited on its own line — see `CONNECT_TIMEOUT_MS`. The
     * rejection handler is attached immediately so a connect that fails AFTER
     * the race below has given up cannot surface as an unhandled rejection and
     * take the process down. It stays visible to the race, so a fast failure
     * still fails fast.
     */
    const connecting = this.ai.live.connect({
      model: this.model,
      config: this.buildConfig(),
      callbacks: {
        onopen: () => this.log.log(`live socket open (${this.model})`),
        onmessage: (m: LiveServerMessage) => {
          if (current()) this.handleMessage(m);
        },
        onerror: (e: { message?: string }) => {
          if (current()) this.events.onError(new Error(e?.message ?? 'live socket error'), false);
        },
        onclose: (e: { reason?: string; code?: number }) => {
          if (current()) void this.handleClose(e?.reason ?? 'closed', e?.code);
        },
      },
    });
    connecting.catch(() => {});

    const handshake = expire<null>(CONNECT_TIMEOUT_MS, null);
    const session = await Promise.race([connecting, handshake.promise]);
    handshake.cancel();

    if (!session) {
      // Should it open eventually, close it — a socket nobody is reading from
      // would otherwise stay up for the life of the process, still billing
      // tokens against a round that gave up on it. And disown it first, so its
      // close is not mistaken for the live socket dropping.
      if (current()) this.generation += 1;
      void connecting.then((s) => s.close()).catch(() => {});
      throw new Error(
        `the Live API handshake did not complete within ${CONNECT_TIMEOUT_MS / 1000}s`,
      );
    }
    if (this.closing || !current()) {
      if (current()) this.generation += 1;
      try {
        session.close();
      } catch {
        /* going anyway */
      }
      throw new Error('the live session was closed while a socket was opening');
    }

    this.session = session;
    // A new socket has no turn open on it, and none requested.
    this.modelTurnOpen = false;
    this.replyRequestedAt = 0;
    /**
     * A resumed socket restores the existing server session, so liveness tracking
     * carries forward. Only a clean socket resets missed commit points.
     */
    if (resuming) this.liveness.resumed(Date.now());
    else this.liveness.reset(Date.now());
    // A resumed socket carries the old context on; only a clean one starts again.
    if (!resuming) {
      this.contextTokens = 0;
      this.floorTokens = 0;
    }
    if (!resuming && this.faultBegun()) this.faultCured = true;
    /**
     * Nor may the half-turn's output state. It is closed by `settleOutput`, which
     * a turn cut off with its socket never reaches — and a `turnAudioMs` left
     * over would make the first fabricated note on the new socket read as HEARD,
     * which buys the candidate an on-air "I misspoke" about nothing.
     */
    this.resetTurnOutput();
  }

  private handleMessage(m: LiveServerMessage) {
    // Resumption handles arrive continuously; the newest one is what we
    // reconnect with, so it must be stored before anything can go wrong.
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = m.sessionResumptionUpdate.newHandle;
    }

    // The server's own count of the context — the one number the budget runs on.
    if (m.usageMetadata?.promptTokenCount) {
      this.contextTokens = m.usageMetadata.promptTokenCount;
      this.floorTokens ||= this.contextTokens;
    }

    if (m.goAway) {
      const secs = parseFloat(String(m.goAway.timeLeft ?? '0').replace('s', '')) || 0;
      this.log.warn(`goAway received, ${secs}s left (context ${this.contextTokens} tokens)`);
      const now = Date.now();
      this.handoverAt = now;
      // Acted on with time to spare: the server closes the socket when it runs out.
      this.handoverDeadline = now + Math.max(0, secs * 1000 - HANDOVER_MARGIN_MS);
      this.noteUpstream({ kind: 'handover_warning', why: `${secs}s left` });
      this.events.onGoAway(secs);
      this.maybeRenew();
    }

    if (m.toolCall?.functionCalls?.length) {
      this.toolCallPending = true;
      this.replyRequestedAt = 0;
      this.lastOutputAt = Date.now();
      void this.runToolCalls(m.toolCall.functionCalls as never[]);
      return;
    }

    /**
     * A cancellation means the model gave up on calls we may still be running.
     * Logged rather than acted on: the handlers are all reads, so letting one
     * finish and discarding its answer costs nothing, and tracking cancellation
     * per call would be machinery for no benefit.
     */
    if (m.toolCallCancellation) {
      this.log.warn('server cancelled a tool call; its result will be discarded');
    }

    const c = m.serverContent;
    if (!c) return;

    if (c.interrupted) {
      // Logged because a barge-in that lands before the model has emitted any
      // audio or transcript leaves no other trace anywhere — which is exactly
      // how the silent-opening bug hid.
      this.flushInput();
      this.log.log('server: interrupted (barge-in)');
      // A barge-in closes the model's turn without a `turnComplete`. Leaving
      // `modelTurnOpen` set here would blind the stall watchdog for the rest
      // of the round — the wedge it exists to catch would look like an open
      // turn that simply never finished.
      this.modelTurnOpen = false;
      this.replyRequestedAt = 0;
      // The browser drops what it had queued, so nothing more is playing.
      this.playbackEndsAt = Date.now();
      this.noteInterviewerTurn();
      this.settleOutput();
      // A barge-in is a boundary, just not a tidy one — see `flushAtBargeIn`.
      this.notes.deferring(() => this.events.onBoundary?.('interrupted'));
      this.notes.flushAtBargeIn();
      this.events.onInterrupted();
    }

    for (const part of c.modelTurn?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      this.flushInput();
      /**
       * Generation HAS started, whoever ends up hearing it, so the turn is
       * open and the stall clock is satisfied even if the bytes are then held
       * or dropped. `everSpoke` is the exception and is set on delivery
       * instead — see `deliverAudio`.
       */
      this.modelTurnOpen = true;
      this.noteOutput();
      this.emitAudio(part.inlineData.data);
    }

    if (c.interimInputTranscription?.text || c.inputTranscription?.text) {
      this.liveness.heard(Date.now());
      this.backlog.committed(Date.now());
    }
    if (c.interimInputTranscription?.text) {
      // Interims are what prove the candidate is still mid-sentence, which is
      // the whole basis for not nudging them.
      this.noteInput(false);
      this.events.onTranscript({
        speaker: 'user',
        text: c.interimInputTranscription.text,
        final: false,
      });
    }
    if (c.inputTranscription?.text) {
      /**
       * A committed utterance is the moment the model starts owing a reply.
       * Everything the watchdog does hangs off this flag, which is why it is
       * set from the transcript rather than from the audio: the transcript is
       * what tells us the SERVER decided the candidate had finished.
       */
      this.noteInput(true);
      // Only the first utterance since the model last spoke opens the debt,
      // so repeated candidate check-ins do not reset the waiting timer.
      if (!this.awaitingReply) this.awaitingSince = this.lastInputAt;
      this.awaitingReply = true;
      if (liveModelQuirks(this.model).subwordTranscripts) this.glueInput(c.inputTranscription.text);
      else this.commitInput(c.inputTranscription.text, c.inputTranscription.words);
    }
    if (c.outputTranscription?.text) {
      this.flushInput();
      /**
       * `final: true` unconditionally. Output transcription arrives as
       * committed deltas — never as revisable hypotheses — and the `finished`
       * flag is not actually set on them (observed: 0 of 17 fragments across a
       * full interviewer turn). Gating on it silently discarded every word the
       * interviewer said, leaving sessions with a candidate transcript and no
       * questions. Only `interimInputTranscription` is genuinely interim.
       */
      // Output transcript usually leads the audio, so this is the earliest
      // proof that generation has started.
      this.modelTurnOpen = true;
      this.noteOutput();
      this.modelTurnText += ` ${c.outputTranscription.text}`;
      this.emitOutput(c.outputTranscription.text);
    }

    // Read wherever it arrives: the API does not document that it rides on `turnComplete`.
    this.noteTurnReason(c.turnCompleteReason);

    if (c.turnComplete) {
      this.flushInput();
      this.log.log('server: turnComplete');
      this.modelTurnOpen = false;
      this.replyRequestedAt = 0;
      this.lastOutputAt = Date.now();
      this.noteInterviewerTurn();
      this.settleOutput();
      this.notes.deferring(() => this.events.onBoundary?.('turnComplete'));
      /**
       * An opening that finished having said nothing is re-sent HERE, and
       * only here — see `OPENING_MAX_KICKOFFS` — and INSTEAD of the note
       * flush, because one boundary carries one send; a round that has not
       * begun has nothing queued worth delivering first anyway.
       */
      if (!this.everSpoke) this.maybeRetryOpening();
      // A renewal takes the boundary instead, and flushes the notes onto the
      // new socket once it is up — never into the one being let go.
      else if (!this.maybeRenew()) this.notes.flushAtBoundary();
      this.events.onTurnComplete();
    }
  }

  /**
   * Forwards a fragment of the interviewer's own transcript, unless the turn
   * turns out to be the model imitating one of our injected notes.
   *
   * A note is recognisable only from its opening, and the opening arrives split
   * across fragments, so a turn whose transcript starts with "[" — or which
   * could still grow into an unbracketed "SYSTEM NOTE" — is held back until
   * there is enough of it to classify. Everything else, which is every real
   * turn because the interviewer is told to speak rather than write markup,
   * flows through untouched on the first fragment.
   */
  private emitOutput(text: string) {
    // Before the suppression check: a fabricated note IS a transcript, and a
    // turn we deliberately silenced is not a turn we failed to capture.
    this.turnTranscriptSeen = true;
    if (this.outSuppressed) return;

    if (this.outDecided) {
      /**
       * A marker mid-turn, which the head sniff cannot see. The turn is already
       * decided, so its audio — this note's included — reaches the candidate as
       * it arrives; only the marker fragment's text is dropped. Cutting the
       * audio here was tried and is worse: transcript leads audio, so the cut
       * also silenced speech before the marker, and the note would then be
       * reported as heard when it was not. Only the literal marker counts:
       * `NOTE_LABEL_RE` is safe only at a turn's opening, and mid-sentence
       * "one note: it is quadratic" is speech.
       */
      const marker = text.search(SYSTEM_NOTE_RE);
      if (marker !== -1) {
        const spoken = text.slice(0, marker);
        this.log.error(`interviewer emitted a system note mid-turn — dropping: ${text.slice(marker, marker + 120)}`);
        if (spoken.trim()) this.emitSpeech(spoken);
        this.events.onSpuriousNote?.(text.slice(marker), true);
        return;
      }
      /**
       * The same backstop for a verbalised tool RESULT, which is unambiguous
       * enough to strip wherever it lands. A verbalised tool CALL is not —
       * finding where it ends needs the whole run, so that one is only handled
       * at the head, where the turn can still be held.
       */
      const mid = this.hasTools ? scrubToolArtifacts(text) : { clean: text, removed: '' };
      if (mid.removed) {
        this.log.error(`model read a tool result aloud — stripping: ${text.slice(0, 120)}`);
        if (!mid.clean) return;
        this.emitSpeech(mid.clean);
        return;
      }
      this.emitSpeech(text);
      return;
    }

    this.outHead += text;
    const head = this.outHead.trimStart();

    /**
     * The audio gate answers ONE question — could this still be a note? — and
     * is released the moment that is settled, which is well before the
     * artifact sniff finishes. A verbalised tool call is a prefix on speech
     * the candidate is owed; only a note is withheld outright.
     */
    if (!head.startsWith('[') && !mayOpenSystemNote(head)) this.releaseAudio();

    // Only a session with tools can verbalise one; the interviewer has none.
    if (this.hasTools && !this.outArtifact && opensToolArtifact(head)) this.outArtifact = true;

    /**
     * Neither a bracketed marker nor anything that could still grow into a
     * verbalised tool call: release immediately and stop sniffing this turn.
     * Every real turn takes this path on its first fragment, because the
     * models are told to speak rather than to write markup.
     */
    if (
      head &&
      !head.startsWith('[') &&
      !mayOpenSystemNote(head) &&
      !this.outArtifact &&
      !(this.hasTools && mayOpenToolArtifact(head))
    ) {
      this.releaseHead();
      return;
    }

    if (isFabricatedNote(head)) {
      this.outHead = '';
      this.outDecided = true;
      this.outSuppressed = true;
      const heldMs = this.dropHeldAudio();
      this.log.error(
        `the interviewer emitted a system note of its own: ${head.slice(0, 120)}` +
          ` — suppressing it from the transcript and dropping ${heldMs}ms of its audio` +
          (this.outAudioReleased ? ' (some already played — see AUDIO_HOLD_MAX_MS)' : ''),
      );
      // Read after the drop: whatever was held never played, so only audio
      // released past `AUDIO_HOLD_MAX_MS` counts as heard.
      const heard = this.turnAudioMs > 0;
      if (!heard) this.restoreTurnDebt();
      this.events.onSpuriousNote?.(head, heard);
      return;
    }

    // Long enough to rule the artifact out, or to have captured all of it.
    const window = this.outArtifact ? ARTIFACT_SNIFF_CHARS : NOTE_SNIFF_CHARS;
    if (this.outHead.length >= window) this.releaseHead();
  }

  /** Puts back the debt a turn nobody heard appeared to settle. See `turnDebt`. */
  private restoreTurnDebt() {
    const d = this.turnDebt;
    if (!d) return;
    this.awaitingReply = d.awaitingReply;
    this.awaitingSince = d.awaitingSince;
    this.owedQuietMs = d.owedQuietMs;
    this.debtQuietFrom = d.debtQuietFrom;
    this.floor = d.floor;
    this.floorText = d.floorText;
    this.yieldedAt = d.yieldedAt;
  }

  /** The model's speech to the transcript, less any markup it wrote. */
  private emitSpeech(text: string) {
    const clean = this.markup.push(text);
    this.reportMarkup();
    if (clean) this.events.onTranscript({ speaker: 'ai', text: clean, final: true });
  }

  private reportMarkup() {
    for (const span of this.markup.takeRemoved()) {
      this.log.error(`the model wrote markup into its transcript — removing it: ${span.slice(0, 160)}`);
      this.events.onInventedMarkup?.(span);
    }
  }

  private releaseHead() {
    const held = this.outHead;
    this.outHead = '';
    this.outDecided = true;
    if (!held) return;

    if (this.outArtifact) {
      const { clean, removed } = scrubToolArtifacts(held);
      if (removed) {
        this.log.error(
          `model read a tool call aloud — stripping it from the transcript: ` +
            `${held.slice(0, 160)}`,
        );
      }
      if (!clean) return;
      this.emitSpeech(clean);
      return;
    }

    this.emitSpeech(held);
  }

  /**
   * Output audio, gated on the note sniff in `emitOutput`.
   *
   * Held rather than forwarded while the turn could still be a fabricated
   * note, because a note the candidate has already heard cannot be taken back
   * — suppressing its transcript only hides it from the report. See
   * `AUDIO_HOLD_MAX_MS` for the round that cost.
   */
  private emitAudio(data: string) {
    // Decided against, and the rest of the turn goes with it: the marker is in
    // the opening fragment, so every later chunk is more of the same note.
    if (this.outSuppressed) return;
    if (this.outDecided || this.outAudioReleased) {
      this.deliverAudio(data);
      return;
    }

    this.outAudioHeld.push(data);
    if (!this.outAudioTimer) {
      // Audio that outran the transcript. Play it when the deadline passes: a
      // silent interviewer is a worse failure than an un-vetted one, and the
      // sniff still cuts the turn off the moment a marker appears.
      this.outAudioTimer = setTimeout(() => this.releaseAudio(), AUDIO_HOLD_MAX_MS);
      // Never the reason the process — or an offline suite — stays alive.
      this.outAudioTimer.unref?.();
    }
  }

  /** Flushes held audio in arrival order and stops holding for this turn. */
  private releaseAudio() {
    this.outAudioReleased = true;
    this.clearAudioHoldTimer();
    if (!this.outAudioHeld.length) return;
    const held = this.outAudioHeld;
    this.outAudioHeld = [];
    for (const chunk of held) this.deliverAudio(chunk);
  }

  /** Discards held audio. Returns how much was thrown away, for the log. */
  private dropHeldAudio(): number {
    const ms = this.outAudioHeld.reduce((n, c) => n + outputAudioMs(c), 0);
    this.outAudioHeld = [];
    this.clearAudioHoldTimer();
    return Math.round(ms);
  }

  private clearAudioHoldTimer() {
    if (this.outAudioTimer) clearTimeout(this.outAudioTimer);
    this.outAudioTimer = undefined;
  }

  /**
   * Delivers audio to the candidate and records that the interviewer has spoken (`everSpoke`).
   *
   * Set on audio delivery rather than receipt so turns composed entirely of
   * suppressed spurious notes are not counted as successful greetings.
   */
  private deliverAudio(data: string) {
    if (!this.everSpoke) {
      this.everSpoke = true;
      this.armStallWatchdog();
      /**
       * The round has a voice in it, which is the only thing that can clear a
       * "the interviewer has not started" banner honestly — `noteOutput` cannot,
       * because it fires off a fragment the candidate never hears.
       */
      if (this.openingStallReported) {
        this.openingStallReported = false;
        this.events.onStall?.({
          stage: 0,
          silentMs: 0,
          outageMs: 0,
          remedy: 'recovered',
          action: 'the opening arrived',
          recovered: true,
          opening: true,
        });
      }
    }
    const chunkMs = outputAudioMs(data);
    this.turnAudioMs += chunkMs;
    this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + chunkMs;
    this.events.onAudio(data);
  }

  /** End of turn: release anything still held and re-arm for the next turn. */
  private settleOutput() {
    if (!this.outDecided && !this.outSuppressed) this.releaseHead();
    // A bracket held as a possible opener was text after all.
    const rest = this.markup.end();
    this.reportMarkup();
    if (rest) this.events.onTranscript({ speaker: 'ai', text: rest, final: true });
    // A turn that ended before the sniff could classify it is far more likely
    // to be a short real answer than a note, and holding it past the boundary
    // would lose it outright.
    if (this.outSuppressed) this.dropHeldAudio();
    else this.releaseAudio();

    /**
     * Reported AFTER the release above, because a turn whose audio was still
     * held is a turn that has only just been delivered — asking the question
     * any earlier would count every short turn as untranscribed.
     */
    if (this.turnAudioMs >= UNTRANSCRIBED_MIN_MS && !this.turnTranscriptSeen) {
      this.events.onUntranscribedTurn?.(Math.round(this.turnAudioMs));
    }
    this.resetTurnOutput();
  }

  /** Forgets everything about the turn in progress, delivering nothing. */
  private resetTurnOutput() {
    this.turnAudioMs = 0;
    this.turnTranscriptSeen = false;
    this.turnDebt = null;
    this.modelTurnText = '';

    this.outHead = '';
    this.outDecided = false;
    this.outSuppressed = false;
    this.outArtifact = false;
    this.markup.reset();
    this.outAudioHeld = [];
    this.clearAudioHoldTimer();
    this.outAudioReleased = false;
  }

  /**
   * Runs the model's tool calls and answers every one of them.
   *
   * Every call gets a response even when the handler blows up, because the
   * model blocks until each is answered — an unanswered call is a mentor that
   * goes silent mid-sentence, which is indistinguishable from a crash.
   */
  private async runToolCalls(calls: { id?: string; name?: string; args?: unknown }[]) {
    const normalised = calls.map((c) => ({
      id: c.id,
      name: c.name ?? '',
      args: (c.args ?? {}) as Record<string, unknown>,
    }));
    this.log.log(
      `tool call: ${normalised.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 120)})`).join(', ')}`,
    );

    let responses: { id?: string; name: string; response: Record<string, unknown> }[];
    try {
      responses =
        (await this.events.onToolCall?.(normalised)) ??
        normalised.map((c) => ({
          id: c.id,
          name: c.name,
          response: { error: 'this conversation has no tools' },
        }));
    } catch (err) {
      this.log.error(`tool handler threw: ${(err as Error).message}`);
      responses = normalised.map((c) => ({
        id: c.id,
        name: c.name,
        response: { error: `tool failed: ${(err as Error).message}` },
      }));
    }

    this.toolCallPending = false;
    this.lastOutputAt = Date.now();
    if (this.closing) return;
    try {
      this.session?.sendToolResponse({ functionResponses: responses as never });
    } catch (err) {
      this.log.error(`failed to send tool response: ${(err as Error).message}`);
    }
  }

  private async handleClose(reason: string, code?: number) {
    if (this.closing) {
      this.events.onClosed(reason);
      return;
    }
    // A deliberate replacement is already opening a socket; a second would race it.
    if (this.reconnecting) return;
    const kind = classifyClose(code, reason, this.handoverAt > 0);
    this.noteUpstream({ kind: 'closed', code, reason, why: kind });
    this.log.warn(
      `live socket closed (${code ?? 'no code'}: ${reason || 'no reason'}) — ${kind}, ` +
        `context ${this.contextTokens} tokens`,
    );
    this.discardSocket();

    /**
     * A refusal is never resumed from the handle because the handle restores the
     * rejected session state. Sockets with refusals or context exceeding the budget
     * are rebuilt from our local record instead.
     */
    const budget = liveModelQuirks(this.model).contextBudget;
    if (
      this.opts.history && this.everSpoke &&
      (kind === 'refused' || !this.resumptionHandle || renewalDue(this.contextTokens, budget, true, this.floorTokens))
    ) {
      const n = kind === 'refused' ? this.refusals.record(Date.now()) : 0;
      if (n) this.maybeFailOver(n);
      await this.renew(kind, refusalBackoffMs(n));
      return;
    }

    // An unrequested close mid-interview is normal (the API recycles sockets
    // at around ten minutes), so resume rather than surfacing it.
    if (this.resumptionHandle) {
      this.reconnecting = true;
      let opened = false;
      try {
        opened = await this.reopen(250, REOPEN_ATTEMPTS);
      } finally {
        this.reconnecting = false;
      }
      if (opened && !this.closing) {
        this.handoverAt = 0;
        this.handoverDeadline = 0;
        this.noteUpstream({ kind: 'resumed', why: kind });
        this.events.onReconnected();
        this.replayHeld('unsent');
        return;
      }
    }
    if (this.closing) {
      this.events.onClosed(reason);
      return;
    }

    this.events.onError(new Error(`live session lost: ${reason}`), true);
    this.events.onClosed(reason);
  }

  /** base64 raw little-endian 16-bit PCM mono @ 16 kHz. */
  sendAudio(base64: string) {
    const now = Date.now();
    const silence = this.voice.observe(Buffer.from(base64, 'base64'), now);
    if (silence) {
      this.noteSilenceEnded(silence.from, silence.to);
      // Only while a socket is there to hear it: speech during a reconnect was
      // sent to nobody, and is no evidence about the socket that replaces it.
      if (this.session && !this.reconnecting) {
        this.liveness.observe(now, this.voiceReading(), this.playbackEndsAt, silence);
      }
    }
    this.noteVoiceResumed();
    this.noteVoiceDebt();
    // The injected fault drops audio the server would have received, so it counts as sent.
    if (this.faultDeaf(now)) {
      this.backlog.push(base64, now, true);
      return;
    }
    /**
     * Straight through only when nothing is ahead of it. With no socket, or one
     * being replaced, the backlog holds it for the next; behind a replay, it
     * waits its turn so the server hears the candidate in order.
     */
    const direct = !!this.session && !this.reconnecting && !this.replayTimer && !this.replayQueue.length;
    this.backlog.push(base64, now, direct);
    if (direct) {
      this.session!.sendRealtimeInput({ audio: { data: base64, mimeType: AUDIO.inputMimeType } });
    } else if (this.session && !this.reconnecting) {
      this.replayQueue.push({ data: base64, voiced: this.voice.voicedBetween(now - base64PcmMs(base64), now) > 0 });
      this.pumpReplay();
    }
  }

  sendText(text: string) {
    this.session?.sendRealtimeInput({ text });
  }

  /** The candidate's editor, coalesced to the newest. See `NoteQueue.snapshot`. */
  sendSnapshotNote(note: string) {
    this.notes.snapshot(note);
  }

  /** A note owed exactly once. See `NoteQueue.fact`. */
  sendFactNote(note: string, opts?: { key?: string }) {
    this.notes.fact(note, opts?.key);
  }

  /** A correction, first at the next boundary and asking for a reply. See `NoteQueue.correction`. */
  sendUrgentNote(note: string) {
    this.notes.correction(note);
  }

  /** Whether any queued recording is still waiting for a boundary. */
  get hasQueuedAudio() {
    return this.notes.hasQueuedAudio;
  }

  /**
   * Queues audio to arrive at the next turn boundary instead of in the opening
   * turn.
   *
   * Attaching a recording to the primer means the model must ingest all of it
   * before it can say a word: measured 8s for 2 minutes of audio, 15s for 15
   * minutes, against ~2s for the mentor, which sends none. Greeting first and
   * delivering the audio immediately afterwards makes the coach answer as
   * quickly as the mentor while still hearing the round before the first real
   * question.
   */
  queueAudioNote(
    text: string,
    audio: { mimeType: string; data: string },
    opts?: { requestReply?: boolean },
  ) {
    this.notes.recording(text, audio, opts?.requestReply);
  }

  endAudioStream() {
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  close() {
    this.flushInput();
    this.closing = true;
    this.clearStallWatchdog();
    this.clearAudioHoldTimer();
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    this.replayQueue = [];
    this.backlog.clear();
    try {
      this.session?.close();
    } catch {
      /* already gone */
    }
  }
}

@Injectable()
export class GeminiLiveService {
  private readonly log = new Logger(GeminiLiveService.name);
  private readonly ai: GoogleGenAI;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly availability: ModelAvailabilityService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  /**
   * Opens a realtime voice session on the first usable model of the
   * interviewer chain. Used for the interviewer, the coach and the mentor;
   * they differ only in their system instruction, primer and tools. The model
   * that connected is `session.modelId`.
   */
  async createInterviewSession(
    opts: LiveOptions,
    events: LiveEvents,
  ): Promise<LiveInterviewSession> {
    const chain = [...MODELS.interviewerChain];
    const candidates = this.availability.order(chain);
    let lastErr: unknown;

    // Only an interviewer has a round to rebuild, and only a test stack may break one.
    const fault = opts.history && isTestTarget(this.env) ? this.env.E2E_FAULT_DEAF_AFTER_MS : undefined;
    if (fault) opts = { ...opts, deafFaultAfterMs: fault };
    opts = {
      ...opts,
      failover: (deaf) => {
        this.availability.noteDeaf(deaf);
        return this.availability.order(chain).find((m) => m !== deaf && this.availability.isAvailable(m));
      },
    };

    for (const model of candidates) {
      const s = new LiveInterviewSession(this.ai, model, opts, events);
      try {
        await s.start();
        this.availability.noteSuccess(model);
        return s;
      } catch (err) {
        lastErr = err;
        // Closed before moving on. `start()` can fail AFTER `open()` succeeded,
        // and an abandoned session still holds a live upstream socket and an
        // armed stall watchdog — so falling through to the next model without
        // this leaks one of each per attempt.
        s.close();
        const msg = (err as Error).message ?? String(err);
        if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) this.availability.noteQuotaError(model, msg);
        else this.availability.noteError(model);
        this.log.warn(`model ${model} unavailable: ${msg}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('no live model available');
  }
}
