import type { SpeechSegment } from '@orvia/shared';

/**
 * Reads feed text aloud using browser Web Speech synthesis.
 * Handles platform quirks including asynchronous voice loading in Chrome,
 * filtering novelty voices, splitting long text to avoid truncation,
 * and requiring initial speech triggers inside user gestures on Safari.
 */

/** Longer than this and Chrome may truncate, so utterances are split near it. */
const MAX_UTTERANCE_CHARS = 180;

/** A breath between segments. Without it the reading machine-guns. */
const SEGMENT_GAP_MS = 280;

/**
 * Defers speaking after `cancel()` to avoid a browser bug where immediate
 * subsequent `speak()` calls fail to start.
 */
const CANCEL_SETTLE_MS = 140;

/**
 * The macOS joke voices. They are indistinguishable from real ones by any
 * property the API exposes — same language, same `localService` — so the only
 * way to keep them out is to name them.
 */
const NOVELTY_VOICES = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester',
  'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Fred',
  'Kathy', 'Grandma', 'Grandpa',
]);

/**
 * Preferred high-quality system and browser voices (e.g. Premium, Enhanced, Neural,
 * and Google synthesized voices), ordered by quality.
 */
const QUALITY_MARKERS = [/premium/i, /enhanced/i, /neural/i, /natural/i, /siri/i, /\bgoogle\b/i];

/**
 * Known-decent standard voices, in preference order.
 *
 * Samantha and Daniel are the long-standing macOS defaults and sound markedly
 * better than the rest of the built-in set.
 */
const PREFERRED_NAMES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Rishi', 'Alex', 'Serena'];

export type VoiceOption = { uri: string; name: string; lang: string; premium: boolean };

export type SpeechHandle = { cancel: () => void };

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Resolves once the voice list is populated.
 *
 * Chrome fires `voiceschanged` after an async load; Safari has the list
 * immediately. The timeout is the third case — a browser that fires neither,
 * where the platform default is the only option and is fine.
 */
export function voicesReady(): Promise<void> {
  if (!speechSupported()) return Promise.resolve();
  if (window.speechSynthesis.getVoices().length) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', done);
      resolve();
    };
    window.speechSynthesis.addEventListener('voiceschanged', done);
    window.setTimeout(done, 2_000);
  });
}

function isNovelty(voice: SpeechSynthesisVoice): boolean {
  // Names arrive both bare and qualified — "Grandma (English (United States))" —
  // so the comparison is on the leading name rather than the whole string.
  const bare = voice.name.split('(')[0]!.trim();
  return NOVELTY_VOICES.has(bare);
}

function score(voice: SpeechSynthesisVoice): number {
  const markerIndex = QUALITY_MARKERS.findIndex((m) => m.test(voice.name));
  if (markerIndex >= 0) return 100 - markerIndex;

  const preferred = PREFERRED_NAMES.indexOf(voice.name.split('(')[0]!.trim());
  if (preferred >= 0) return 50 - preferred;

  return 0;
}

/** English voices worth offering, best first. Novelty voices never appear. */
export function listVoices(): VoiceOption[] {
  if (!speechSupported()) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.startsWith('en') && !isNovelty(v))
    .map((v) => ({ voice: v, rank: score(v) }))
    .sort((a, b) => b.rank - a.rank || a.voice.name.localeCompare(b.voice.name))
    .map(({ voice, rank }) => ({
      uri: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      premium: rank >= 90,
    }));
}

/** True when no high-quality voice is installed, so the picker can say so. */
export function hasPremiumVoice(): boolean {
  return listVoices().some((v) => v.premium);
}

function resolveVoice(preferredUri: string | null): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (preferredUri) {
    const exact = voices.find((v) => v.voiceURI === preferredUri);
    if (exact) return exact;
  }
  const best = listVoices()[0];
  return best ? (voices.find((v) => v.voiceURI === best.uri) ?? null) : null;
}

function splitForSpeech(text: string): string[] {
  if (text.length <= MAX_UTTERANCE_CHARS) return [text];

  const out: string[] = [];
  let current = '';
  // Split on sentence ends, keeping the punctuation, then refill to the cap so
  // the pauses land where the writing put them rather than mid-clause.
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (current && current.length + sentence.length > MAX_UTTERANCE_CHARS) {
      out.push(current.trim());
      current = '';
    }
    current += `${sentence} `;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export type SpeakOptions = {
  rate?: number;
  voiceUri?: string | null;
  onDone: () => void;
  onError?: () => void;
};

/**
 * Speak a card's segments in order, then call `onDone`.
 *
 * Returns a handle rather than a promise because the only thing a caller ever
 * does with an in-flight reading is abandon it.
 */
export function speakSegments(
  segments: readonly SpeechSegment[],
  opts: SpeakOptions,
): SpeechHandle {
  const synth = window.speechSynthesis;
  let cancelled = false;
  /** The gap, pause or settle before the next step. At most one is pending. */
  let stepTimer: number | undefined;
  /** The no-`onend` fallback for the segment being spoken. At most one is pending. */
  let watchdog: number | undefined;

  const clearTimers = () => {
    if (stepTimer !== undefined) window.clearTimeout(stepTimer);
    if (watchdog !== undefined) window.clearTimeout(watchdog);
    stepTimer = watchdog = undefined;
  };
  const schedule = (fn: () => void, ms: number) => {
    if (stepTimer !== undefined) window.clearTimeout(stepTimer);
    stepTimer = window.setTimeout(fn, ms);
  };

  const cancel = () => {
    cancelled = true;
    clearTimers();
    synth.cancel();
  };

  /** Ends the reading exactly once, whichever of done or error gets there first. */
  const finish = (outcome: 'done' | 'error') => {
    if (cancelled) return;
    cancelled = true;
    clearTimers();
    if (outcome === 'done') opts.onDone();
    else opts.onError?.();
  };

  const queue: SpeechSegment[] = [...segments];
  /** True until the first utterance, which is the one that needs the settle. */
  let first = true;

  const next = () => {
    if (cancelled) return;
    const segment = queue.shift();
    if (!segment) {
      finish('done');
      return;
    }

    if ('pause' in segment) {
      schedule(next, segment.pause);
      return;
    }

    const parts = splitForSpeech(segment.say).filter(Boolean);
    if (!parts.length) {
      next();
      return;
    }

    if (first && (synth.speaking || synth.pending)) {
      first = false;
      synth.cancel();
      queue.unshift(segment);
      schedule(next, CANCEL_SETTLE_MS);
      return;
    }
    first = false;

    const voice = resolveVoice(opts.voiceUri ?? null);
    let remaining = parts.length;
    let advanced = false;

    const advance = () => {
      if (advanced || cancelled) return;
      advanced = true;
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      watchdog = undefined;
      schedule(next, SEGMENT_GAP_MS);
    };

    /**
     * A device with the API present and no usable voice never fires `onend`,
     * and the reader would sit in silence forever. Estimated from the text at a
     * deliberately generous rate, so it only ever fires when speech did not
     * happen at all.
     */
    if (watchdog !== undefined) window.clearTimeout(watchdog);
    watchdog = window.setTimeout(advance, segment.say.length * 90 + 4_000);

    for (const part of parts) {
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.rate = opts.rate ?? 1;
      if (voice) {
        utterance.voice = voice;
        // Safari reads with the default voice's accent unless the language is
        // set to match the voice as well.
        utterance.lang = voice.lang;
      }
      // Only the LAST part of a segment advances the queue; advancing per part
      // would race the synthesiser's own queue.
      utterance.onend = () => {
        remaining -= 1;
        if (remaining === 0) advance();
      };
      utterance.onerror = () => finish('error');
      synth.speak(utterance);
    }
  };

  next();
  return { cancel };
}

/** One short line, for previewing a voice from the picker. Null uses the best available. */
export function previewVoice(voiceUri: string | null, rate: number): SpeechHandle {
  window.speechSynthesis.cancel();
  return speakSegments(
    [{ say: 'A hash map lookup is order one on average, and order n in the worst case.' }],
    { voiceUri, rate, onDone: () => {} },
  );
}
