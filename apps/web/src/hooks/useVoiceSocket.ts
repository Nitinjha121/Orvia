import { useCallback, useEffect, useMemo, useRef } from 'react';
import { InterviewSocket, type SocketHandlers } from '../lib/socket';
import { MicCapture } from '../audio/mic';
import { PcmPlayer } from '../audio/player';

/** Thrown by `open` when the conversation was closed or replaced while it was still opening. */
export class VoiceCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * Manages microphone capture, audio playback, and WebSocket connection together.
 * Shared by the interview and coach views; unmounting tears down all three
 * to ensure background recording and audio contexts are released.
 */
export function useVoiceSocket(path: '/ws/interview' | '/ws/coach') {
  const socket = useRef<InterviewSocket | null>(null);
  const mic = useRef(new MicCapture());
  const player = useRef(new PcmPlayer());

  /** Stops capture and playback; the socket stays open for the server's reply. */
  const stopMedia = useCallback(async () => {
    await mic.current.stop().catch(() => {});
    player.current.interrupt();
  }, []);

  /**
   * Swaps in fresh media BEFORE the first await and shuts down only the old
   * instances: "Run again" calls this and `open` in the same tick, and closing
   * through the refs closed the new round's AudioContext, leaving it silent.
   */
  const close = useCallback(async () => {
    socket.current?.close();
    socket.current = null;
    const oldMic = mic.current;
    const oldPlayer = player.current;
    mic.current = new MicCapture();
    player.current = new PcmPlayer();
    await oldMic.stop().catch(() => {});
    await oldPlayer.close().catch(() => {});
  }, []);

  /**
   * Initializes speaker (within user gesture for autoplay), microphone, WebSocket,
   * and sends start message in sequence.
   * Ensures permissions are verified before opening server rounds and drops events
   * from superseded connections.
   */
  const open = useCallback(
    async ({
      handlers, send, onLevel, gate, onMicLost, onMicRestored,
    }: {
      handlers: SocketHandlers;
      send: (s: InterviewSocket) => void;
      onLevel: (peak: number) => void;
      /** Returns false to hold audio back, e.g. while paused. */
      gate?: () => boolean;
      /** The capture device ended and one automatic re-acquire failed. */
      onMicLost?: () => void;
      onMicRestored?: () => void;
    }): Promise<InterviewSocket> => {
      socket.current?.close();
      const s = new InterviewSocket(path);
      socket.current = s;
      const current = () => socket.current === s;
      let started = false;

      try {
        await player.current.ensure();
        await mic.current.start({
          onChunk: (b64) => {
            if (started && current() && (gate?.() ?? true)) s.audio(b64);
          },
          onLevel,
          onLost: () => {
            if (current()) onMicLost?.();
          },
          onRestored: () => {
            if (current()) onMicRestored?.();
          },
        });
        if (!current()) throw new VoiceCancelled();

        const guarded = Object.fromEntries(
          Object.entries(handlers).map(([k, fn]) => [
            k,
            (...args: unknown[]) => {
              if (current()) (fn as (...a: unknown[]) => void)(...args);
            },
          ]),
        ) as SocketHandlers;
        await s.connect(guarded);
        if (!current()) throw new VoiceCancelled();

        send(s);
        started = true;
        return s;
      } catch (err) {
        s.close();
        if (current()) {
          socket.current = null;
          await mic.current.stop().catch(() => {});
        }
        throw err;
      }
    },
    [path],
  );

  /** Another try at the microphone after `onMicLost`, on the same socket. */
  const retryMic = useCallback(() => mic.current.reacquire(), []);

  useEffect(() => () => void close(), [close]);

  return useMemo(
    () => ({ socket, mic, player, open, stopMedia, close, retryMic }),
    [open, stopMedia, close, retryMic],
  );
}
