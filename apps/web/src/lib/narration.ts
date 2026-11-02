import type { FeedAudioClip } from '@orvia/shared';
import type { SpeechHandle } from './speech';

/**
 * Playing pre-generated narration.
 *
 * One `HTMLAudioElement`, created on the first user gesture and reused for
 * every clip afterwards. iOS grants playback permission to an ELEMENT, not to
 * the page, so constructing a new one per clip loses the grant and the second
 * card is silent — the single most common way this breaks on a phone.
 */

let shared: HTMLAudioElement | null = null;

/** Must be called from inside a user gesture, once, before anything plays. */
export function primeNarration(): HTMLAudioElement {
  if (!shared) {
    shared = new Audio();
    shared.preload = 'auto';
  }
  return shared;
}

export function playClips(
  clips: readonly FeedAudioClip[],
  opts: { rate?: number; onDone: () => void; onError: () => void },
): SpeechHandle {
  const audio = primeNarration();
  let cancelled = false;
  let timer: number | undefined;
  let index = 0;

  const cleanup = () => {
    audio.onended = null;
    audio.onerror = null;
  };

  const cancel = () => {
    cancelled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    cleanup();
    audio.pause();
  };

  /**
   * `onerror` and a rejected `play()` both report the same failure, and each
   * `onError` starts a fallback reading — so it fires once, or two voices talk.
   */
  const fail = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    cleanup();
    opts.onError();
  };

  const next = () => {
    if (cancelled) return;
    const clip = clips[index++];
    if (!clip) {
      cancelled = true;
      cleanup();
      opts.onDone();
      return;
    }

    audio.onended = () => {
      if (cancelled) return;
      // The pause belongs AFTER the clip: a quiz's thinking gap and a drill's
      // minute to answer are silence the generator deliberately did not record.
      timer = window.setTimeout(next, clip.pauseAfterMs);
    };
    audio.onerror = fail;

    audio.src = clip.url;
    audio.playbackRate = opts.rate ?? 1;
    void audio.play().catch(fail);
  };

  next();
  return { cancel };
}
