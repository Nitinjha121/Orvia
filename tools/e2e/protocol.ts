/**
 * The WS protocol as the suites see it: the event names and payload types from
 * `packages/shared/src/events.ts`, so a renamed event or field fails
 * `pnpm typecheck` instead of a live run.
 */
import {
  C2S,
  S2C,
  type AudioDeltaPayload,
  type ErrorPayload,
  type QuestionChangedPayload,
  type SessionClockPayload,
  type SessionEndedPayload,
  type SessionReadyPayload,
  type SessionWarningPayload,
  type TranscriptDeltaPayload,
} from '../../packages/shared/src/events.js';

export { C2S, S2C };

type Empty = Record<string, never>;

export type ServerMessage =
  | { event: typeof S2C.SessionReady; data: SessionReadyPayload }
  | { event: typeof S2C.AudioDelta; data: AudioDeltaPayload }
  | { event: typeof S2C.TranscriptDelta; data: TranscriptDeltaPayload }
  | { event: typeof S2C.TurnComplete; data: Empty }
  | { event: typeof S2C.Interrupted; data: Empty }
  | { event: typeof S2C.SessionWarning; data: SessionWarningPayload }
  | { event: typeof S2C.Clock; data: SessionClockPayload }
  | { event: typeof S2C.QuestionChanged; data: QuestionChangedPayload }
  | { event: typeof S2C.SessionEnded; data: SessionEndedPayload }
  | { event: typeof S2C.Error; data: ErrorPayload };

/** A frame from the server, or null for one that is not JSON. */
export function parseServer(raw: { toString(): string }): ServerMessage | null {
  try {
    return JSON.parse(raw.toString()) as ServerMessage;
  } catch {
    return null;
  }
}

type ClientEvent = (typeof C2S)[keyof typeof C2S];

/** One client frame, in the `{ event, data }` envelope the gateway expects. */
export const frame = (event: ClientEvent, data: unknown = {}) => JSON.stringify({ event, data });
