import type { GuardEvent } from '@orvia/shared';
import type { RoundState } from './round-state';

/** What the round's clock says, off the budget and never the wall. See `InterviewGateway.remaining`. */
export type RoundClock = {
  remainingMin: number;
  secondsLeft: number;
  plannedMin: number;
  /** Whether the SERVER has told the interviewer time is short. Only it may. */
  lowTimeSent: boolean;
  /** Clock notes the server has queued, for the log. */
  notesSent: number;
};

/**
 * Everything a check may do to a live round. The gateway implements it over
 * the browser socket and the upstream session. Nothing here may be awaited:
 * checks run synchronously in the transcript-fragment handler so turns are not reordered.
 */
export interface RoundEffects {
  /** A note owed exactly once. See `NoteQueue.fact`. */
  fact(note: string, opts?: { key?: string }): void;
  /** A correction that asks for a reply at the next boundary. See `NoteQueue.correction`. */
  urgent(note: string): void;
  /** A banner on the candidate's screen. */
  warn(code: 'false_close', message: string, secondsLeft: number): void;
  /** The round's current question moved; the browser follows. */
  questionChanged(source: 'interviewer' | 'candidate'): void;
  /** Persists the current question, fire-and-forget. */
  saveQuestion(index: number): void;
  clock(): RoundClock;
  elapsedMs(): number;
  /** The round is being torn down; nothing more is said or corrected. */
  ended(): boolean;
  log: { log(m: string): void; warn(m: string): void; error(m: string): void };
}

/** What every check is built with. */
export type CheckContext = {
  readonly sessionId: string;
  readonly state: RoundState;
  readonly effects: RoundEffects;
  /** One guard firing, for `sessions.guard_events`. */
  record(kind: GuardEvent['kind'], said: string, corrected: boolean): void;
};
