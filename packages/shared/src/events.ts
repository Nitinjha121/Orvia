import { z } from 'zod';
import { startSessionSchema } from './modes.js';
import type { FocusItem } from './evaluation.js';

/**
 * WebSocket protocol between browser and Orvia API.
 * The server manages upstream AI live connections, transcript capture, and persistence.
 */

export const C2S = {
  StartSession: 'session.start',
  AudioChunk: 'audio.chunk',
  AudioStreamEnd: 'audio.end',
  TextInput: 'text.input',
  ContextPush: 'context.push',
  SelectQuestion: 'question.select',
  StopSession: 'session.stop',
} as const;

export const S2C = {
  SessionReady: 'session.ready',
  AudioDelta: 'audio.delta',
  TranscriptDelta: 'transcript.delta',
  TurnComplete: 'turn.complete',
  Interrupted: 'interrupted',
  SessionWarning: 'session.warning',
  Clock: 'session.clock',
  QuestionChanged: 'question.changed',
  SessionEnded: 'session.ended',
  Error: 'error',
} as const;

export type Speaker = 'ai' | 'user';

/* ── client -> server ─────────────────────────────────────────────────────── */

export const audioChunkSchema = z.object({
  /** base64 of raw little-endian 16-bit PCM mono @ 16 kHz. */
  data: z.string().min(1),
});

export const textInputSchema = z.object({ text: z.string().min(1) });

/**
 * Out-of-band context the candidate produced without speaking: current code
 * editor contents (DSA) or design scratchpad (system design). Pushed on a
 * debounce so the interviewer can react to what is being written.
 */
export const contextPushSchema = z.object({
  kind: z.enum(['code', 'scratchpad']),
  content: z.string(),
  /** Recorded so the report can render your code with the right highlighting. */
  language: z.string().optional(),
  /**
   * Which question this buffer belongs to, for a round with more than one.
   *
   * Without it every push overwrote one shared column, so the report showed
   * whichever question happened to be open last and the other buffers were
   * gone. Optional because a system-design scratchpad has no question id.
   */
  questionId: z.string().optional(),
});

/**
 * Emitted when the candidate manually switches questions.
 * Overrides automated transition detection so editor state, code persistence,
 * and interviewer context remain synchronized.
 */
export const selectQuestionSchema = z.object({ index: z.number().int().min(0) });

export const stopSessionSchema = z.object({
  reason: z.enum(['user_ended', 'time_up', 'error']).default('user_ended'),
});

/* ── server -> client ─────────────────────────────────────────────────────── */

/** One question of a round, in the order the interviewer will work through them. */
export type RoundQuestion = {
  id: string;
  title: string;
  difficulty: string;
};

export type SessionReadyPayload = {
  sessionId: string;
  model: string;
  voice: string;
  /** Server clock at session start, for aligning client-side audio timestamps. */
  startedAt: string;
  /** Soft cap the UI counts down against. */
  durationMinutes: number;
  /**
   * The round's questions in deterministic server order, ensuring the UI display
   * matches the interviewer's question sequence.
   */
  questions?: RoundQuestion[];
  /**
   * What the candidate is working on this round — their open commitments, or a
   * drill's weaknesses — decided by the server so the screen shows exactly the
   * list the evaluator will check. Never sent to the interviewer.
   */
  focus?: FocusItem[];
  /** Set on a drill: which moment is being retried, and what was advised. */
  drill?: { label: string; question: string; advice: string; beforeScore: number; outOf: number };
  /** Set on an onsite-loop round: which stage this is. */
  loop?: { id: string; stage: number; of: number };
};

/**
 * The round moved to a different question.
 *
 * Sent when the interviewer is heard introducing the next problem, and echoed
 * back when the candidate switches by hand, so both paths land in one place on
 * the client.
 */
export type QuestionChangedPayload = {
  /** Index into `SessionReadyPayload.questions`. */
  index: number;
  questionId: string;
  title: string;
  /** Who moved it: heard from the interviewer, or chosen by the candidate. */
  source: 'interviewer' | 'candidate';
};

export type AudioDeltaPayload = {
  /** base64 of raw little-endian 16-bit PCM mono @ 24 kHz. */
  data: string;
};

export type TranscriptDeltaPayload = {
  speaker: Speaker;
  text: string;
  /** Interim hypotheses are replaced, not appended. */
  final: boolean;
  /** ms since session start. */
  atMs: number;
};

export type SessionWarningPayload = {
  /**
   * `stalled`: interviewer response delay notice while recording continues.
   * `false_close`: notifies the client when an erroneous premature close by the
   * interviewer is corrected upstream so the candidate knows to keep going.
   */
  code:
    | 'go_away'
    | 'reconnecting'
    | 'context_compressed'
    | 'time_low'
    | 'stalled'
    | 'false_close';
  message: string;
  /** For `go_away` / `time_low` / `false_close`: seconds remaining. */
  secondsLeft?: number;
};

/**
 * The round's clock as the SERVER counts it. The budget excludes every stretch
 * the interviewer was dead, so a countdown off the browser's wall clock would
 * disagree with the clock notes, the low-time warning and the hard stop.
 */
export const sessionClockSchema = z.object({
  /** Planned length minus `budgetMs`, clamped at zero. */
  remainingMs: z.number(),
  /** Round time the candidate has had: elapsed minus dead windows. */
  budgetMs: z.number(),
});
export type SessionClockPayload = z.infer<typeof sessionClockSchema>;

export type SessionEndedPayload = {
  sessionId: string;
  reason: string;
  durationMs: number;
  turnCount: number;
  /** Present once the recording has been flushed to disk. */
  audioPath?: string;
};

export type ErrorPayload = { message: string; fatal: boolean };

/** Envelope used in both directions — matches Nest's `ws` adapter shape. */
export type WsMessage<T = unknown> = { event: string; data: T };

export const clientMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal(C2S.StartSession), data: startSessionSchema }),
  z.object({ event: z.literal(C2S.AudioChunk), data: audioChunkSchema }),
  z.object({ event: z.literal(C2S.AudioStreamEnd), data: z.object({}).optional() }),
  z.object({ event: z.literal(C2S.TextInput), data: textInputSchema }),
  z.object({ event: z.literal(C2S.ContextPush), data: contextPushSchema }),
  z.object({ event: z.literal(C2S.SelectQuestion), data: selectQuestionSchema }),
  z.object({ event: z.literal(C2S.StopSession), data: stopSessionSchema.optional() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
