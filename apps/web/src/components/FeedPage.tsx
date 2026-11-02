import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FeedAction, FeedCard } from '@orvia/shared';
import { RATING_ACTIONS } from '@orvia/shared';
import { api } from '../lib/api';
import { usePracticeFromFeed } from '../lib/feedPractice';
import { useFeed } from '../hooks/useFeed';
import { useListen } from '../hooks/useListen';
import { readStored, writeStored } from '../lib/storage';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorNote } from './ui/ErrorNote';
import { FeedCardView } from './feed/FeedCardView';
import { VoicePicker } from './feed/VoicePicker';

/**
 * Vertical snapping card scroller for the learning feed.
 * Dynamically measures viewport height to keep controls visible across breakpoints,
 * and records `seen` events after dwell time for unrated cards.
 */

/** How long a card must hold the screen before it counts as read. */
const SEEN_AFTER_MS = 2_500;
/** Fraction of the scroller a card must fill to be the one being read. */
const SEEN_RATIO = 0.6;

type SavedEntry = { key: string; card: FeedCard };

const NARRATION_KEY = 'orvia.feed.narration.v1';
const NARRATED_ONLY_KEY = 'orvia.feed.narratedOnly.v1';

export function FeedPage() {
  const [narrationVoice, setNarrationVoice] = useState<string | null>(() => readStored(NARRATION_KEY));
  /**
   * Read only the cards that have generated narration. One flag for both the
   * server's composition (`narrated=true`) and the reader's skip rule. A partly
   * built cache is the normal state for a long time, and mixing the two voices
   * card by card reads as "the voice is bad" rather than "not generated yet".
   */
  const [narratedOnly, setNarratedOnly] = useState(() => readStored(NARRATED_ONLY_KEY) === '1');
  const { cards, meta, loading, error, actError, exhausted, loadMore, act } = useFeed(
    narrationVoice,
    narratedOnly,
  );
  const [tab, setTab] = useState<'feed' | 'saved'>('feed');
  const practice = usePracticeFromFeed();

  /**
   * Listening drives the scroll rather than following it: the card being read
   * is brought to the top, which also lets the IntersectionObserver mark it
   * seen on exactly the same terms a thumb would.
   */
  const scrollTo = useCallback((key: string) => {
    document
      .querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const listen = useListen(cards, { onAdvance: scrollTo, onExhausted: loadMore, narratedOnly });
  const [voicePanel, setVoicePanel] = useState(false);

  /**
   * Keys that must never receive a `seen`: the stat card, which is not
   * material, and anything already rated here.
   */
  const settled = useRef(new Set<string>(['stat:today']));

  const onAct = useCallback(
    (card: FeedCard, action: FeedAction) => {
      if (RATING_ACTIONS.includes(action)) settled.current.add(card.key);
      act(card, action);
    },
    [act],
  );

  return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Feed</h1>

        <div role="group" aria-label="Which cards" className="flex gap-1 rounded-md bg-surface-alt p-1">
          {(['feed', 'saved'] as const).map((t) => (
            <button
              key={t}
              aria-pressed={tab === t}
              onClick={() => {
                // The reader follows the feed's scroller, which Saved does not
                // render, so leaving the feed stops it rather than reading on
                // with no controls on screen.
                if (t === 'saved' && listen.listening) listen.stop();
                setTab(t);
              }}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                tab === t ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted'
              }`}
            >
              {t === 'feed' ? 'For you' : 'Saved'}
            </button>
          ))}
        </div>

        {tab === 'feed' && listen.supported && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => (listen.listening ? listen.stop() : listen.start())}
              aria-pressed={listen.listening}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                listen.listening
                  ? 'border-brand bg-brand-muted text-brand'
                  : 'border-border bg-surface text-fg-muted'
              }`}
            >
              {listen.listening ? 'Stop' : 'Listen'}
            </button>
            <button
              onClick={() => setVoicePanel((v) => !v)}
              aria-label="Choose the reading voice"
              aria-expanded={voicePanel}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              Voice
            </button>
          </div>
        )}

        {tab === 'feed' && <DailyRing done={meta.todayCount} goal={meta.goal} streak={meta.streak} />}
      </header>

      {tab === 'feed' && voicePanel && (
        <VoicePicker
          voiceUri={listen.voiceUri}
          rate={listen.rate}
          narrationVoice={narrationVoice}
          onNarrationVoice={(v) => {
            setNarrationVoice(v);
            writeStored(NARRATION_KEY, v);
          }}
          narratedOnly={narratedOnly}
          onNarratedOnly={(v) => {
            setNarratedOnly(v);
            writeStored(NARRATED_ONLY_KEY, v ? '1' : '0');
          }}
          onVoice={listen.chooseVoice}
          onRate={listen.chooseRate}
          onBeforePreview={() => {
            if (listen.listening) listen.stop();
          }}
          onClose={() => setVoicePanel(false)}
        />
      )}

      {tab === 'feed' && listen.listening && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-brand bg-brand-muted px-3 py-2">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-brand" />
          <p className="min-w-0 flex-1 truncate text-xs text-fg">
            {listen.engine === 'browser' ? 'Reading aloud with the device voice.' : 'Reading aloud.'}{' '}
            Put the phone down and answer out loud.
          </p>
          <button onClick={listen.skip} className="shrink-0 text-xs font-medium text-brand">
            Skip
          </button>
        </div>
      )}

      {actError && <ErrorNote message={actError} className="mb-2" />}

      {tab === 'saved' ? (
        <SavedList onPractice={practice} onAct={onAct} />
      ) : (
        <Scroller
          cards={cards}
          loading={loading}
          error={error}
          exhausted={exhausted}
          onNearEnd={loadMore}
          onAct={onAct}
          onPractice={practice}
          settled={settled}
          readingKey={listen.readingKey}
        />
      )}
    </div>
  );
}

/** The day's progress against the goal, as a bar with the remainder visible. */
function DailyRing({ done, goal, streak }: { done: number; goal: number; streak: number }) {
  const pct = Math.min(100, Math.round((done / goal) * 100));
  return (
    <div className="ml-auto flex items-center gap-2">
      {streak > 0 && (
        <span className="rounded-full bg-brand-muted px-2 py-0.5 text-[11px] font-semibold text-brand">
          {streak}d
        </span>
      )}
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-alt">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-fg-subtle">
        {done}/{goal}
      </span>
    </div>
  );
}

function Scroller({
  cards,
  loading,
  error,
  exhausted,
  onNearEnd,
  onAct,
  onPractice,
  settled,
  readingKey,
}: {
  cards: FeedCard[];
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  onNearEnd: () => void;
  onAct: (card: FeedCard, action: FeedAction) => void;
  onPractice: (mode: string, questionId: string) => void;
  settled: React.RefObject<Set<string>>;
  readingKey: string | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  /**
   * Measured against the viewport rather than derived from the header, because
   * the header wraps to two rows below `sm` and any arithmetic that assumes one
   * puts the card's buttons under the fold. `dvh` via `window.innerHeight` so
   * the mobile browser's collapsing address bar is accounted for.
   */
  useLayoutEffect(() => {
    const measure = () => {
      const node = el.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top;
      setHeight(Math.max(360, window.innerHeight - top - 12));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  /** Latest cards, for the observer callback, which outlives a render. */
  const latest = useRef(cards);
  latest.current = cards;

  useEffect(() => {
    const root = el.current;
    if (!root || !cards.length) return;

    const timers = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.key;
          if (!key) continue;

          if (entry.isIntersecting && entry.intersectionRatio >= SEEN_RATIO) {
            // The last card being on screen is the signal to fetch the next
            // page — early enough that the fetch is done before the thumb
            // arrives, late enough that opening the feed costs one request.
            if (key === latest.current[latest.current.length - 1]?.key) onNearEnd();

            if (!settled.current.has(key) && !timers.has(key)) {
              timers.set(
                key,
                window.setTimeout(() => {
                  timers.delete(key);
                  if (settled.current.has(key)) return;
                  settled.current.add(key);
                  const card = latest.current.find((c) => c.key === key);
                  if (card) onAct(card, 'seen');
                }, SEEN_AFTER_MS),
              );
            }
          } else {
            const t = timers.get(key);
            if (t !== undefined) {
              window.clearTimeout(t);
              timers.delete(key);
            }
          }
        }
      },
      { root, threshold: [0, SEEN_RATIO, 1] },
    );

    root.querySelectorAll<HTMLElement>('[data-key]').forEach((node) => io.observe(node));
    return () => {
      io.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [cards, onAct, onNearEnd, settled]);

  return (
    <div
      ref={el}
      style={height ? { height } : undefined}
      /**
       * `snap-y snap-mandatory` is what makes this read as a feed rather than a
       * long page: one card per gesture, always landing squarely. `overscroll-
       * contain` stops a flick at the end from scrolling the page behind it,
       * which on iOS is what triggers pull-to-refresh mid-scroll.
       */
      className="snap-y snap-mandatory overflow-y-auto overscroll-contain rounded-lg"
    >
      {cards.map((card) => (
        <section
          key={card.key}
          data-key={card.key}
          className="h-full snap-start snap-always py-1"
          style={height ? { height } : undefined}
        >
          <div
            /* A ring rather than a border colour: every teaching card already
               uses border-brand for its takeaway accent, so a coloured border
               would not read as "this is the one being spoken". */
            className={`h-full rounded-lg border border-border bg-surface p-4 shadow-sm transition-shadow sm:p-5 ${
              card.key === readingKey ? 'ring-2 ring-brand' : ''
            }`}
            data-reading={card.key === readingKey ? 'true' : undefined}
          >
            <ErrorBoundary panel="card">
              <FeedCardView card={card} onAct={onAct} onPractice={onPractice} />
            </ErrorBoundary>
          </div>
        </section>
      ))}

      {(loading || error || exhausted) && (
        <section className="flex h-full snap-start items-center justify-center" style={height ? { height } : undefined}>
          <div className="max-w-sm px-6 text-center">
            {error ? (
              <>
                <p className="text-sm text-fg">{error}</p>
                <button
                  onClick={onNearEnd}
                  className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted"
                >
                  Try again
                </button>
              </>
            ) : loading ? (
              <p className="text-sm text-fg-subtle">Loading…</p>
            ) : (
              <>
                <p className="text-sm font-medium text-fg">That is everything for now.</p>
                <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
                  Cards you rated come back on their own schedule — the ones you fumbled within the
                  hour, the ones you knew in a few days. Nothing here loops to keep you scrolling.
                </p>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Everything you starred, newest first, as an ordinary scrolling list.
 *
 * Deliberately NOT the snapping scroller: saving is how you come back to
 * something on purpose, and a list you can skim is the right shape for that,
 * where one-card-per-gesture is the right shape for discovery.
 */
function SavedList({
  onAct,
  onPractice,
}: {
  onAct: (card: FeedCard, action: FeedAction) => void;
  onPractice: (mode: string, questionId: string) => void;
}) {
  const [entries, setEntries] = useState<SavedEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<SavedEntry[]>('/api/feed/saved')
      /**
       * Snapshots are stored verbatim from whatever the client sent when the
       * card was saved, so a card shape that has since changed can arrive
       * missing a field the renderer reads. Dropped here rather than allowed
       * to throw: one stale row must not blank the whole page.
       */
      .then((rows) => setEntries(rows.filter((r) => r.card?.kind && r.card?.state)))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);

  if (failed) return <ErrorNote message={`Could not load your saved cards: ${failed}`} />;
  if (!entries) return <p className="text-sm text-fg-subtle">Loading…</p>;
  if (!entries.length) {
    return (
      <p className="max-w-md text-sm leading-relaxed text-fg-muted">
        Nothing saved yet. Star a card in the feed and it lands here — including the ones drawn from
        your own reports, which stop appearing in the feed once the round scrolls out of range.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {entries.map((e) => (
        <li
          key={e.key}
          /**
           * A fixed height rather than the scroller's measured one: these are
           * skimmed, and a list of full-viewport cards is a scroller with extra
           * steps. Tall enough that a lesson body is readable without
           * scrolling inside the card on a phone.
           */
          className="h-[26rem] rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-5"
        >
          <ErrorBoundary panel="card">
            <FeedCardView
              card={e.card}
              onAct={(card, action) => {
                onAct(card, action);
                if (action === 'unsave') setEntries((cur) => cur?.filter((x) => x.key !== card.key) ?? null);
              }}
              onPractice={onPractice}
            />
          </ErrorBoundary>
        </li>
      ))}
    </ul>
  );
}
