import {
  C2S,
  S2C,
  type StartSessionInput,
  type SessionReadyPayload,
  type AudioDeltaPayload,
  type TranscriptDeltaPayload,
  type SessionWarningPayload,
  type SessionEndedPayload,
  type QuestionChangedPayload,
  type ErrorPayload,
  type SessionClockPayload,
} from '@orvia/shared';

/**
 * What `/ws/coach` accepts. Declared in `apps/api/src/coach/coach.gateway.ts`
 * (`startCoachSchema`), which is not exported to shared yet.
 */
export type CoachStartInput = { scope: 'session' | 'account'; sessionId?: string; voice?: string };

export type ContextKind = 'code' | 'scratchpad';

export type SocketHandlers = {
  onReady: (p: SessionReadyPayload) => void;
  onAudio: (p: AudioDeltaPayload) => void;
  onTranscript: (p: TranscriptDeltaPayload) => void;
  onInterrupted: () => void;
  onWarning?: (p: SessionWarningPayload) => void;
  /** Interview only: the round moved to another question, heard or chosen. */
  onQuestionChanged?: (p: QuestionChangedPayload) => void;
  /** Interview only: the server's stall-adjusted clock. */
  onClock?: (p: SessionClockPayload) => void;
  onEnded: (p: SessionEndedPayload) => void;
  onError: (p: ErrorPayload) => void;
  /** The SERVER closed the socket. Never called for our own `close()`. */
  onClose: () => void;
};

/**
 * Typed wrapper over a realtime voice WebSocket. The interview and the coach
 * speak the same protocol and differ only in path.
 */
export class InterviewSocket {
  private ws?: WebSocket;

  constructor(private readonly path: '/ws/interview' | '/ws/coach' = '/ws/interview') {}

  connect(handlers: SocketHandlers): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    this.ws = ws;

    ws.onmessage = (e) => {
      let msg: { event: string; data: unknown };
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      switch (msg.event) {
        case S2C.SessionReady:  return handlers.onReady(msg.data as SessionReadyPayload);
        case S2C.AudioDelta:    return handlers.onAudio(msg.data as AudioDeltaPayload);
        case S2C.TranscriptDelta: return handlers.onTranscript(msg.data as TranscriptDeltaPayload);
        case S2C.Interrupted:   return handlers.onInterrupted();
        case S2C.SessionWarning: return handlers.onWarning?.(msg.data as SessionWarningPayload);
        case S2C.QuestionChanged:
          return handlers.onQuestionChanged?.(msg.data as QuestionChangedPayload);
        case S2C.Clock:         return handlers.onClock?.(msg.data as SessionClockPayload);
        case S2C.SessionEnded:  return handlers.onEnded(msg.data as SessionEndedPayload);
        case S2C.Error:         return handlers.onError(msg.data as ErrorPayload);
      }
    };
    ws.onclose = () => handlers.onClose();
    ws.onerror = () => handlers.onError({ message: 'connection failed', fatal: true });

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out connecting to the API')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      ws.addEventListener('close', () => {
        clearTimeout(t);
        reject(new Error('the API refused the connection'));
      }, { once: true });
    });
  }

  private send(event: string, data: unknown = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, data }));
    }
  }

  start(input: StartSessionInput) { this.send(C2S.StartSession, input); }
  startCoach(input: CoachStartInput) { this.send(C2S.StartSession, input); }
  audio(base64: string)           { this.send(C2S.AudioChunk, { data: base64 }); }
  endAudio()                      { this.send(C2S.AudioStreamEnd); }
  pushContext(kind: ContextKind, content: string, language?: string, questionId?: string) {
    this.send(C2S.ContextPush, { kind, content, language, questionId });
  }
  /** The server decides and echoes `question.changed` back; the client never switches on a guess. */
  selectQuestion(index: number) { this.send(C2S.SelectQuestion, { index }); }
  stop(reason: 'user_ended' | 'time_up' = 'user_ended') {
    this.send(C2S.StopSession, { reason });
  }

  /**
   * Closes the client side of the connection. Handlers are detached first so
   * an obsolete socket cannot dispatch close events to a replacement session.
   */
  close() {
    const ws = this.ws;
    if (!ws) return;
    ws.onmessage = ws.onclose = ws.onerror = null;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    this.ws = undefined;
  }
}
