import { useCallback, useEffect, useRef, useState } from 'react';
import { appendFragment, type TranscriptEntry } from '../lib/transcript';
import { useVoiceSocket, VoiceCancelled } from './useVoiceSocket';

export type CoachPhase = 'idle' | 'connecting' | 'live' | 'ended' | 'error';
export type CoachLine = TranscriptEntry;

/**
 * The post-session coaching conversation. Nothing is recorded or scored.
 *
 * @param scope 'session' coaches one finished round with its recording;
 *              'account' looks across every round.
 */
export function useCoach(sessionId: string | null, scope: 'session' | 'account' = 'session') {
  const [phase, setPhase] = useState<CoachPhase>('idle');
  const [lines, setLines] = useState<CoachLine[]>([]);
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const voice = useVoiceSocket('/ws/coach');
  const { mic, player, close } = voice;
  /** Read inside the mic callback, which is created once when capture starts. */
  const pausedRef = useRef(false);

  /**
   * Time actually spent in the conversation: paused time is not counted.
   * `banked` holds completed stretches and `runningSince` the active stretch;
   * the total persists into 'ended'.
   */
  const banked = useRef(0);
  const runningSince = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => {
      setSpeaking(!pausedRef.current && player.current.pendingSeconds > 0.05);
      setElapsedMs(banked.current + (runningSince.current ? Date.now() - runningSince.current : 0));
    }, 100);
    return () => clearInterval(t);
  }, [phase, player]);

  /**
   * Pause without losing the conversation: the socket and the upstream Live
   * session stay open, only capture and playback stop. Playback is suspended
   * rather than interrupted, so a half-finished sentence resumes where it
   * stopped.
   */
  const applyPaused = useCallback(async (next: boolean) => {
    if (next && runningSince.current !== null) {
      banked.current += Date.now() - runningSince.current;
      runningSince.current = null;
    } else if (!next && runningSince.current === null) {
      runningSince.current = Date.now();
    }
    pausedRef.current = next;
    setPaused(next);
    mic.current.setMuted(next);
    await player.current.setPaused(next).catch(() => {});
    if (next) {
      setLevel(0);
      setSpeaking(false);
    }
  }, [mic, player]);

  const togglePause = useCallback(() => void applyPaused(!pausedRef.current), [applyPaused]);

  /**
   * Every way a conversation ends goes through here — the End button, the
   * server ending it, the server closing the socket, a fatal error — so none of
   * them can leave the microphone on.
   */
  const finish = useCallback(async (next: 'ended' | 'error') => {
    voice.socket.current?.stop('user_ended');
    await close();
    if (runningSince.current !== null) {
      banked.current += Date.now() - runningSince.current;
      runningSince.current = null;
    }
    setElapsedMs(banked.current);
    pausedRef.current = false;
    setPaused(false);
    setLevel(0);
    setSpeaking(false);
    setPhase(next);
  }, [voice.socket, close]);

  const stop = useCallback(() => finish('ended'), [finish]);

  const start = useCallback(async () => {
    if (scope === 'session' && !sessionId) return;
    setPhase('connecting');
    setError(null);
    setLines([]);
    pausedRef.current = false;
    setPaused(false);
    banked.current = 0;
    runningSince.current = null;
    setElapsedMs(0);

    try {
      await voice.open({
        onLevel: (v) => setLevel(pausedRef.current ? 0 : v),
        gate: () => !pausedRef.current,
        // Nothing here is recorded, so ending beats a conversation the mentor
        // cannot hear; the interview room keeps its round running instead.
        onMicLost: () => {
          setError('Your microphone disconnected, so the conversation was ended. Reconnect it and start again.');
          void finish('error');
        },
        send: (s) => s.startCoach({ scope, ...(sessionId ? { sessionId } : {}) }),
        handlers: {
          onReady: () => {
            // Started on ready, not on the click: connecting can take seconds
            // while the mentor reads your history.
            runningSince.current = Date.now();
            setPhase('live');
          },
          onAudio: ({ data }) => player.current.enqueue(data),
          onTranscript: (t) =>
            setLines((prev) =>
              appendFragment(prev, { speaker: t.speaker, text: t.text, final: t.final, atMs: t.atMs })),
          onInterrupted: () => player.current.interrupt(),
          onEnded: () => void finish('ended'),
          onError: (e) => {
            setError(e.message);
            if (e.fatal) void finish('error');
          },
          onClose: () => void finish('ended'),
        },
      });
    } catch (err) {
      if (err instanceof VoiceCancelled) return;
      setError((err as Error).message);
      setPhase('error');
    }
  }, [sessionId, scope, voice, player, finish]);

  return { phase, lines, level, speaking, paused, error, elapsedMs, start, stop, togglePause };
}
