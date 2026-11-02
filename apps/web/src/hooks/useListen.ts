import { useCallback, useEffect, useRef, useState } from 'react';
import { speakableCard, type FeedCard } from '@orvia/shared';
import { speakSegments, speechSupported, voicesReady, type SpeechHandle } from '../lib/speech';
import { playClips, primeNarration } from '../lib/narration';
import { readStored, writeStored } from '../lib/storage';

const VOICE_KEY = 'orvia.feed.voice.v1';
const RATE_KEY = 'orvia.feed.rate.v1';

/**
 * Hands-free mode: the feed reads itself and advances on its own.
 *
 * The state that matters is the KEY being read, not an index. Cards are
 * appended as pages load and the list is deduped, so an index would drift the
 * moment a page arrived mid-sentence.
 *
 * Starting must happen inside the click that turns it on — Safari drops a first
 * utterance that did not come from a user gesture — so `start` speaks
 * immediately rather than setting a flag for an effect to notice.
 */
export function useListen(
  cards: readonly FeedCard[],
  opts: {
    onAdvance: (key: string) => void;
    onExhausted: () => void;
    /**
     * Read only the cards that have generated narration. Owned by the page,
     * because the same flag also filters what the server composes.
     */
    narratedOnly: boolean;
  },
) {
  const [listening, setListening] = useState(false);
  const [readingKey, setReadingKey] = useState<string | null>(null);
  /** Which engine is actually speaking, so the UI can say. */
  const [engine, setEngine] = useState<'narrated' | 'browser' | null>(null);
  const [voiceUri, setVoiceUri] = useState<string | null>(() => readStored(VOICE_KEY));
  const [rate, setRate] = useState(() => Number(readStored(RATE_KEY)) || 1);
  const handle = useRef<SpeechHandle | null>(null);
  /** Where a stopped reading left off, so the next Listen resumes there. */
  const resumeKey = useRef<string | null>(null);
  const reading = useRef<string | null>(null);

  /**
   * The voice list is empty on the first synchronous call in Chrome, so it is
   * warmed as soon as the page mounts rather than at the moment of the first
   * press — by then a missing list means the platform default, which is the
   * one voice nobody chose.
   */
  useEffect(() => {
    void voicesReady();
  }, []);

  /** Latest values for callbacks that outlive the render that created them. */
  const latest = useRef({ cards, voiceUri, rate, ...opts });
  latest.current = { cards, voiceUri, rate, ...opts };

  /** The next card the reader is willing to read, from a position in the list. */
  const nextFrom = (fromIndex: number) => {
    const { cards: list, narratedOnly: only } = latest.current;
    return list
      .slice(fromIndex)
      .find((c) => c.kind !== 'stat' && (!only || !!c.audio?.length));
  };

  const stop = useCallback(() => {
    handle.current?.cancel();
    handle.current = null;
    setListening(false);
    resumeKey.current = reading.current;
    reading.current = null;
    setReadingKey(null);
  }, []);

  const read = useCallback(
    (key: string) => {
      const card = latest.current.cards.find((c) => c.key === key);
      if (!card) {
        // The next page has not arrived yet. Ask for it and stop rather than
        // ending silently, so resuming is one press.
        latest.current.onExhausted();
        stop();
        return;
      }

      reading.current = key;
      setReadingKey(key);
      latest.current.onAdvance(key);

      const advance = () => {
        const next = nextFrom(latest.current.cards.findIndex((c) => c.key === key) + 1);
        if (next) read(next.key);
        else {
          // Nothing further that qualifies. Ask for another page; if one
          // arrives the reader is restarted by the caller pressing play again,
          // which is better than spinning silently on an empty filter.
          latest.current.onExhausted();
          stop();
          resumeKey.current = null;
        }
      };

      const withBrowserVoice = () => {
        setEngine('browser');
        handle.current = speakSegments(speakableCard(card), {
          voiceUri: latest.current.voiceUri,
          rate: latest.current.rate,
          onDone: advance,
          onError: stop,
        });
      };

      /**
       * Uses pre-generated audio narration when available, falling back to browser
       * speech synthesis. Falls back on playback errors to avoid interrupting the session.
       */
      if (card.audio?.length) {
        setEngine('narrated');
        handle.current = playClips(card.audio, {
          rate: latest.current.rate,
          onDone: advance,
          onError: withBrowserVoice,
        });
      } else {
        withBrowserVoice();
      }
    },
    [stop],
  );

  const start = useCallback(
    (fromKey?: string) => {
      handle.current?.cancel();
      // Inside the gesture, before anything async: iOS grants playback to this
      // element only if it is created and touched while the tap is being
      // handled. See `primeNarration`.
      primeNarration();
      setListening(true);
      // Back to the card a stop or a voice preview interrupted, if it is still
      // in the list — a filter change replaces the list, and then it starts over.
      const at = resumeKey.current
        ? latest.current.cards.findIndex((c) => c.key === resumeKey.current)
        : -1;
      resumeKey.current = null;
      const first = fromKey ?? nextFrom(Math.max(0, at))?.key;
      if (first) read(first);
      else stop();
    },
    [read, stop],
  );

  const skip = useCallback(() => {
    const next = nextFrom(latest.current.cards.findIndex((c) => c.key === readingKey) + 1);
    handle.current?.cancel();
    if (next) read(next.key);
    else {
      stop();
      resumeKey.current = null;
    }
  }, [readingKey, read, stop]);

  // Speech outlives React: leaving the page mid-sentence must not keep talking.
  useEffect(() => () => handle.current?.cancel(), []);

  const chooseVoice = useCallback((uri: string) => {
    setVoiceUri(uri);
    writeStored(VOICE_KEY, uri);
  }, []);

  const chooseRate = useCallback((value: number) => {
    setRate(value);
    writeStored(RATE_KEY, String(value));
  }, []);

  return {
    listening,
    readingKey,
    engine,
    /**
     * Narrated cards need no browser voice, so listening is offered whenever
     * EITHER path exists — a device with speech synthesis disabled can still
     * play the generated audio.
     */
    supported: speechSupported() || cards.some((c) => c.audio?.length),
    voiceUri,
    rate,
    start,
    stop,
    skip,
    chooseVoice,
    chooseRate,
  };
}
