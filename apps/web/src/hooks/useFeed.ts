import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DAILY_CARD_GOAL,
  RATING_ACTIONS,
  scheduleReview,
  type FeedAction,
  type FeedCard,
  type FeedPage,
} from '@orvia/shared';
import { api } from '../lib/api';
import { localDayKey } from '../lib/time';

/**
 * The feed's client state: one page at a time, appended, with every press sent
 * to the server and reflected locally before the response lands. Every action
 * is idempotent server-side (one upserted row, one appended event), so a lost
 * response costs a counter that is right again on the next load.
 */

export type FeedMeta = { todayCount: number; streak: number; dueCount: number; goal: number };

export function useFeed(narrationVoice?: string | null, narratedOnly = false) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [meta, setMeta] = useState<FeedMeta>({
    todayCount: 0,
    streak: 0,
    dueCount: 0,
    goal: DAILY_CARD_GOAL,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A press that did not reach the server. The local state stands; this says so. */
  const [actError, setActError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  /**
   * Fixed for the life of the mount, so paging down cannot reorder what is
   * already on screen. A remount draws a different feed.
   */
  const seed = useRef(Math.floor(Math.random() * 2 ** 31));
  const offset = useRef(0);
  const inFlight = useRef(false);
  const exhaustedRef = useRef(false);
  /**
   * Bumped by every reset. A response from an older generation was composed
   * under the previous voice or filter, so it is dropped rather than appended
   * to the new list.
   */
  const generation = useRef(0);
  const filters = useRef({ narrationVoice, narratedOnly });
  filters.current = { narrationVoice, narratedOnly };
  /**
   * Cards rated at least once this session, so the day counter can move
   * immediately without counting the same card twice.
   */
  const ratedHere = useRef(new Set<string>());

  /**
   * `reset` starts from offset zero regardless of `exhausted` or a request in
   * flight — otherwise flipping the filter at the end of the feed cleared the
   * list and then refused to fetch it again, leaving the page blank.
   */
  const fetchPage = useCallback(async (reset: boolean) => {
    if (!reset && (inFlight.current || exhaustedRef.current)) return;
    if (reset) {
      generation.current += 1;
      offset.current = 0;
      exhaustedRef.current = false;
      setExhausted(false);
      setCards([]);
    }
    const mine = generation.current;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const { narrationVoice: v, narratedOnly: only } = filters.current;
      const voice = v ? `&voice=${encodeURIComponent(v)}` : '';
      const narrated = only ? '&narrated=true' : '';
      const page = await api.get<FeedPage>(
        `/api/feed?offset=${offset.current}&limit=8&seed=${seed.current}` +
          `&day=${localDayKey()}${voice}${narrated}`,
      );
      if (mine !== generation.current) return;
      setCards((prev) => {
        /**
         * Deduped by key on append. The server re-weaves the whole list on
         * every request, and a rating sent between two pages changes which
         * queue a card sits in — so the same card can legitimately land in two
         * pages.
         */
        const seen = new Set(prev.map((c) => c.key));
        return [...prev, ...page.cards.filter((c) => !seen.has(c.key))];
      });
      setMeta(page.meta);
      if (page.nextOffset === null) {
        exhaustedRef.current = true;
        setExhausted(true);
      } else {
        offset.current = page.nextOffset;
      }
    } catch (e) {
      if (mine === generation.current) {
        setError(e instanceof Error ? e.message : 'Could not load the feed.');
      }
    } finally {
      if (mine === generation.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, []);

  const loadMore = useCallback(() => fetchPage(false), [fetchPage]);

  /** The voice and the filter both change what the SERVER composes, so either one reloads from the top. */
  useEffect(() => {
    void fetchPage(true);
  }, [fetchPage, narrationVoice, narratedOnly]);

  const act = useCallback(async (card: FeedCard, action: FeedAction) => {
    const isRating = RATING_ACTIONS.includes(action);
    const firstRatingHere = isRating && !ratedHere.current.has(card.key);
    if (firstRatingHere) ratedHere.current.add(card.key);

    /**
     * The new schedule is computed with the same pure function the server uses,
     * so the card can say when it comes back without waiting for the response.
     * The server's answer is authoritative and identical; this only removes the
     * round trip from the moment the button is pressed.
     */
    const next = scheduleReview(
      { strength: card.state.strength, dueAt: card.state.dueAt ? new Date(card.state.dueAt) : null },
      action,
      new Date(),
    );

    setCards((prev) =>
      prev.map((c) =>
        c.key === card.key
          ? {
              ...c,
              state: {
                saved: action === 'save' ? true : action === 'unsave' ? false : c.state.saved,
                timesSeen: c.state.timesSeen + 1,
                strength: next.strength,
                dueAt: next.dueAt?.toISOString() ?? null,
                lastAction: action,
              },
            }
          : c,
      ),
    );
    if (firstRatingHere) setMeta((m) => ({ ...m, todayCount: m.todayCount + 1 }));

    try {
      await api.post('/api/feed/interactions', {
        cardKey: card.key,
        action,
        dayKey: localDayKey(),
        /**
         * Saved cards are stored as they were rendered, because three of the
         * kinds are derived from history and stop existing once the history
         * moves on. See `feedInteractionSchema.snapshot`.
         *
         * With `saved` forced true: `card` is the props object from before
         * this press, so storing it verbatim would put an unsaved-looking star
         * on every card in the saved list.
         */
        ...(action === 'save'
          ? { snapshot: { ...card, state: { ...card.state, saved: true } } }
          : {}),
      });
      setActError(null);
    } catch (e) {
      // The press stands locally and the next load reconciles it, but a rating
      // that never arrived is a review that will not be scheduled, so say so.
      setActError(`Your last press did not reach the server: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  return { cards, meta, loading, error, actError, exhausted, loadMore, act };
}
