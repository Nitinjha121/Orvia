import { useCallback, useEffect, useRef, useState } from 'react';
import type { StartSessionInput, SessionEndedPayload, SessionReadyPayload, RoundQuestion } from '@orvia/shared';
import type { ContextKind } from '../lib/socket';
import { appendFragment, type TranscriptEntry } from '../lib/transcript';
import { displayRemainingMs, type ServerClock } from '../lib/clock';
import { useVoiceSocket, VoiceCancelled } from './useVoiceSocket';

export type Phase = 'idle' | 'connecting' | 'live' | 'ending' | 'ended' | 'error';
export type { TranscriptEntry } from '../lib/transcript';

/**
 * How long "Wrapping up…" may wait for `session.ended` before the screen moves
 * on by itself. The round is already stopped server-side by then; this only
 * decides when the client stops waiting to be told so.
 */
const ENDING_TIMEOUT_MS = 45_000;

export function useInterview() {
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [level, setLevel] = useState(0);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [remainingMs, setRemainingMs] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionEndedPayload | null>(null);
  /** The capture device ended mid-round and could not be re-opened by itself. */
  const [micLost, setMicLost] = useState(false);
  /**
   * The browser reports no network. Shown, not acted on: a WebSocket survived
   * at least twelve seconds offline in a real browser before closing, so going
   * offline is not the end of the round — `onClose` is.
   */
  const [offline, setOffline] = useState(false);
  /**
   * The round's questions in the SERVER's order, and which one it is on. The
   * interviewer's numbering is the only one that matches what is read aloud,
   * and the current index is only knowable server-side.
   */
  const [questions, setQuestions] = useState<RoundQuestion[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  /**
   * What this round is working on, and whether it is a drill or a loop stage —
   * as the SERVER decided at start, so the screen shows exactly the list the
   * evaluator will check.
   */
  const [practice, setPractice] = useState<Pick<SessionReadyPayload, 'focus' | 'drill' | 'loop'>>({});

  const voice = useVoiceSocket('/ws/interview');
  const { player, stopMedia, close, retryMic } = voice;

  const phaseRef = useRef<Phase>('idle');
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const startedAt = useRef(0);
  const totalMs = useRef(30 * 60_000);
  const serverClock = useRef<ServerClock | null>(null);
  const sessionId = useRef<string | null>(null);
  /**
   * Turns as the server stores them — a change of speaker — for the end screen
   * when `session.ended` never arrives. Counting final fragments instead read
   * "60 turns" for a round the database held as 5.
   */
  const turns = useRef(0);
  const lastSpeaker = useRef<string | null>(null);
  const endingTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const clearEndingTimer = () => {
    if (endingTimer.current) clearTimeout(endingTimer.current);
    endingTimer.current = null;
  };

  /* The clock. */
  useEffect(() => {
    if (phase !== 'live') return;
    const tick = () => {
      const now = Date.now();
      const elapsed = now - startedAt.current;
      setElapsedMs(elapsed);
      setRemainingMs(displayRemainingMs(serverClock.current, { totalMs: totalMs.current, elapsedMs: elapsed }, now));
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [phase]);

  /* "Interviewer speaking" follows the playback queue rather than message
     arrival, so the indicator matches what is coming out of the speaker. */
  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => setAiSpeaking(player.current.pendingSeconds > 0.05), 100);
    return () => clearInterval(t);
  }, [phase, player]);

  useEffect(() => {
    if (phase !== 'live') {
      setOffline(false);
      return;
    }
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('offline', sync);
    window.addEventListener('online', sync);
    return () => {
      window.removeEventListener('offline', sync);
      window.removeEventListener('online', sync);
    };
  }, [phase]);

  const teardownMedia = useCallback(async () => {
    await stopMedia();
    setMicLost(false);
    setLevel(0);
    setAiSpeaking(false);
  }, [stopMedia]);

  /**
   * The round is over but the server never said so — the socket closed, or
   * `session.ended` never came. With a session id the end screen can still
   * find the report; without one there is nothing to show but the error.
   */
  const finishUnconfirmed = useCallback((reason: string) => {
    clearEndingTimer();
    void close();
    setMicLost(false);
    setLevel(0);
    setAiSpeaking(false);
    if (sessionId.current) {
      setSummary({
        sessionId: sessionId.current,
        reason,
        durationMs: Date.now() - startedAt.current,
        turnCount: turns.current,
      });
      setPhase('ended');
    } else {
      setError('The connection closed before the round started.');
      setPhase('error');
    }
  }, [close, setPhase]);

  const start = useCallback(
    async (input: StartSessionInput) => {
      clearEndingTimer();
      setPhase('connecting');
      setError(null);
      setNotice(null);
      setTranscript([]);
      setSummary(null);
      setMicLost(false);
      setQuestions([]);
      setQuestionIndex(0);
      setPractice({});
      setElapsedMs(0);
      totalMs.current = input.options.durationMinutes * 60_000;
      setRemainingMs(totalMs.current);
      serverClock.current = null;
      sessionId.current = null;
      turns.current = 0;
      lastSpeaker.current = null;

      try {
        await voice.open({
          onLevel: setLevel,
          onMicLost: () => setMicLost(true),
          onMicRestored: () => setMicLost(false),
          send: (s) => s.start(input),
          handlers: {
            onReady: (p) => {
              startedAt.current = Date.now();
              sessionId.current = p.sessionId;
              setQuestions(p.questions ?? []);
              setQuestionIndex(0);
              setPractice({ focus: p.focus, drill: p.drill, loop: p.loop });
              setPhase('live');
            },
            onAudio: ({ data }) => player.current.enqueue(data),
            onTranscript: (t) => {
              if (t.final && t.text.trim() && t.speaker !== lastSpeaker.current) {
                turns.current++;
                lastSpeaker.current = t.speaker;
              }
              setTranscript((prev) =>
                appendFragment(prev, { speaker: t.speaker, text: t.text, final: t.final, atMs: t.atMs }));
            },
            onInterrupted: () => player.current.interrupt(),
            onWarning: (w) => setNotice(w.message),
            onQuestionChanged: (q) => setQuestionIndex(q.index),
            onClock: (c) => {
              serverClock.current = { ...c, receivedAt: Date.now() };
            },
            onEnded: (p) => {
              clearEndingTimer();
              setSummary(p);
              setPhase('ended');
              void close();
              setMicLost(false);
              setLevel(0);
              setAiSpeaking(false);
            },
            onError: (e) => {
              setError(e.message);
              if (e.fatal) {
                clearEndingTimer();
                setPhase('error');
                void close();
              }
            },
            // A round that was live has a session id, and the end screen is
            // the only way back to it — the setup page with a red banner left
            // the round just spoken unreachable.
            onClose: () => {
              const p = phaseRef.current;
              if (p === 'ending' || p === 'live' || p === 'connecting') finishUnconfirmed('connection_closed');
            },
          },
        });
      } catch (err) {
        if (err instanceof VoiceCancelled) return;
        setError((err as Error).message);
        setPhase('error');
        await teardownMedia();
      }
    },
    [voice, player, close, teardownMedia, finishUnconfirmed, setPhase],
  );

  /**
   * Anything owed to the server before it stops listening — the editor's last
   * buffer — must be sent BEFORE this runs: the server drops context after
   * `session.stop`.
   */
  const stop = useCallback(async () => {
    setPhase('ending');
    const s = voice.socket.current;
    s?.endAudio();
    s?.stop('user_ended');
    clearEndingTimer();
    endingTimer.current = setTimeout(() => finishUnconfirmed('no_confirmation'), ENDING_TIMEOUT_MS);
    await teardownMedia();
  }, [voice.socket, teardownMedia, finishUnconfirmed, setPhase]);

  const reset = useCallback(() => {
    clearEndingTimer();
    void close();
    setPhase('idle');
    setTranscript([]);
    setSummary(null);
    setError(null);
    setNotice(null);
    setMicLost(false);
    setElapsedMs(0);
    setQuestions([]);
    setQuestionIndex(0);
    setPractice({});
  }, [close, setPhase]);

  const pushContext = useCallback(
    (kind: ContextKind, content: string, language?: string, questionId?: string) => {
      voice.socket.current?.pushContext(kind, content, language, questionId);
    },
    [voice.socket],
  );

  /** Not set locally: the server echoes `question.changed`, one path for both directions. */
  const selectQuestion = useCallback((index: number) => {
    voice.socket.current?.selectQuestion(index);
  }, [voice.socket]);

  useEffect(() => () => clearEndingTimer(), []);

  return {
    phase, transcript, level, aiSpeaking, elapsedMs, remainingMs, notice, error, summary,
    questions, questionIndex, practice, micLost, offline,
    start, stop, reset, pushContext, selectQuestion, retryMic,
  };
}
