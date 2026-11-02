import { useEffect, useRef, useState } from 'react';
import {
  LEARNING_TRACK_LABELS,
  describeNextReview,
  type FeedAction,
  type FeedCard,
  type LearningTrack,
} from '@orvia/shared';

/**
 * Feed card container with header, scrollable body, and pinned footer.
 * Styled for mobile-first touch navigation with consistent footer action positions.
 */

const KIND_BADGE: Record<string, { label: string; className: string }> = {
  lesson: { label: 'Lesson', className: 'bg-info-muted text-info' },
  pattern: { label: 'Pattern', className: 'bg-brand-muted text-brand' },
  quiz: { label: 'Quiz', className: 'bg-warning-muted text-warning' },
  drill: { label: 'Drill', className: 'bg-surface-alt text-fg-muted' },
  recall: { label: 'Unfinished', className: 'bg-danger-muted text-danger' },
  fix: { label: 'From your report', className: 'bg-success-muted text-success' },
  stat: { label: 'Today', className: 'bg-surface-alt text-fg-muted' },
};

export function FeedCardView({
  card,
  onAct,
  onPractice,
}: {
  card: FeedCard;
  onAct: (card: FeedCard, action: FeedAction) => void;
  onPractice: (mode: string, questionId: string) => void;
}) {
  switch (card.kind) {
    case 'stat':
      return <StatCard card={card} />;
    case 'quiz':
      return <QuizCard card={card} onAct={onAct} />;
    case 'drill':
    case 'recall':
      return <QuestionCard card={card} onAct={onAct} onPractice={onPractice} />;
    case 'fix':
      return <FixCard card={card} onAct={onAct} />;
    default:
      return <TeachingCard card={card} onAct={onAct} />;
  }
}

/* ── shared chrome ─────────────────────────────────────────────────────────── */

function Shell({
  kind,
  track,
  note,
  children,
  footer,
}: {
  kind: string;
  track?: LearningTrack | string;
  note?: string | null;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const badge = KIND_BADGE[kind] ?? KIND_BADGE.lesson!;
  return (
    <article className="flex h-full flex-col gap-3 px-1 py-2 sm:px-2">
      <header className="flex shrink-0 flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${badge.className}`}>
          {badge.label}
        </span>
        {track && (
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
            {LEARNING_TRACK_LABELS[track as LearningTrack] ?? track}
          </span>
        )}
        {note && (
          <span className="ml-auto max-w-[55%] truncate text-[11px] text-fg-subtle" title={note}>
            {note}
          </span>
        )}
      </header>

      {/* min-h-0 so this scrolls instead of pushing the footer off screen. */}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      {/* The rule separates the pinned footer from text that scrolls under it,
          which otherwise reads as one continuous column that has stopped. */}
      {footer && <div className="shrink-0 border-t border-border pt-3">{footer}</div>}
    </article>
  );
}

/**
 * Renders the body's blank-line paragraphs.
 *
 * Deliberately the whole of the markup supported — the bank's rule is that a
 * card is prose with line breaks, and anything richer turns a content file into
 * a document format. Same decision as `RichText` on the playbook page.
 */
function Body({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-fg first:mt-0">
          {para}
        </p>
      ))}
    </>
  );
}

function Code({ code }: { code: string }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-surface-alt p-3">
      <code className="font-mono text-[12px] leading-relaxed text-fg">{code}</code>
    </pre>
  );
}

function Takeaway({ text }: { text: string }) {
  return (
    <p className="border-l-2 border-brand bg-brand-muted px-3 py-2 text-[13px] font-medium leading-relaxed text-fg">
      {text}
    </p>
  );
}

/**
 * The rating row.
 *
 * Two buttons, and their labels are about RECALL rather than about the card:
 * "Knew it" is a claim about you, "Interesting" would be a claim about the
 * writing. Only the first kind can schedule a review honestly.
 */
function Actions({
  card,
  onAct,
  primary,
}: {
  card: FeedCard;
  onAct: (card: FeedCard, action: FeedAction) => void;
  primary?: React.ReactNode;
}) {
  const saved = card.state.saved;
  /**
   * Shown after a RATING only. Scrolling past also schedules a card, and
   * confirming that would tell the reader they had answered something they had
   * only skimmed.
   */
  const rated = card.state.lastAction === 'got_it' || card.state.lastAction === 'shaky';
  const back = rated ? describeNextReview(card.state.dueAt, new Date()) : null;

  return (
    <>
    {back && (
      <p className="mt-2 text-[11px] text-fg-subtle">Back {back}. Nothing here is retired.</p>
    )}
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={() => onAct(card, 'shaky')}
        className="flex-1 rounded-lg border border-border bg-surface px-3 py-3 text-sm font-medium text-fg transition-colors active:bg-surface-hover"
      >
        Show again
      </button>
      <button
        onClick={() => onAct(card, 'got_it')}
        className="flex-1 rounded-lg bg-brand px-3 py-3 text-sm font-semibold text-brand-fg transition-opacity active:opacity-80"
      >
        Knew it
      </button>
      {primary}
      <button
        onClick={() => onAct(card, saved ? 'unsave' : 'save')}
        aria-label={saved ? 'Remove from saved' : 'Save this card'}
        aria-pressed={saved}
        className={`shrink-0 rounded-lg border px-3 py-3 text-sm transition-colors ${
          saved ? 'border-brand bg-brand-muted text-brand' : 'border-border bg-surface text-fg-muted'
        }`}
      >
        {saved ? '★' : '☆'}
      </button>
    </div>
    </>
  );
}

/* ── the kinds ─────────────────────────────────────────────────────────────── */

function TeachingCard({
  card,
  onAct,
}: {
  card: Extract<FeedCard, { kind: 'lesson' | 'pattern' | 'quiz' }>;
  onAct: (card: FeedCard, action: FeedAction) => void;
}) {
  return (
    <Shell
      kind={card.kind}
      track={card.card.track}
      note={card.becauseOf ? `because ${card.becauseOf} went badly` : null}
      /* Pinned, not appended: a long pattern card scrolls inside itself, and a
         rating button that leaves the screen with the text is a button that
         does not get pressed. */
      footer={
        <>
          <Takeaway text={card.card.takeaway} />
          <Actions card={card} onAct={onAct} />
        </>
      }
    >
      <h2 className="text-xl font-semibold leading-tight tracking-tight text-fg">
        {card.card.title}
      </h2>
      <div className="mt-3 pb-2">
        <Body text={card.card.body} />
        {card.card.code && <Code code={card.card.code} />}
      </div>
    </Shell>
  );
}

/**
 * Quiz card component where selecting an option records the rating and reveals
 * the explanation.
 */
function QuizCard({
  card,
  onAct,
}: {
  card: Extract<FeedCard, { kind: 'quiz' }>;
  onAct: (card: FeedCard, action: FeedAction) => void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const answer = card.card.answerIdx ?? 0;
  const choices = card.card.choices ?? [];

  const choose = (i: number) => {
    if (chosen !== null) return;
    setChosen(i);
    onAct(card, i === answer ? 'got_it' : 'shaky');
  };

  return (
    <Shell
      kind="quiz"
      track={card.card.track}
      note={card.becauseOf ? `because ${card.becauseOf}` : null}
      /* No rating row: choosing IS the rating. Only the save button is pinned,
         and only once there is something worth keeping. */
      footer={
        chosen !== null ? (
          <div className="flex justify-end">
            <button
              onClick={() => onAct(card, card.state.saved ? 'unsave' : 'save')}
              aria-pressed={card.state.saved}
              className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                card.state.saved
                  ? 'border-brand bg-brand-muted text-brand'
                  : 'border-border bg-surface text-fg-muted'
              }`}
            >
              {card.state.saved ? '★ Saved' : '☆ Save'}
            </button>
          </div>
        ) : null
      }
    >
      <h2 className="text-xl font-semibold leading-tight tracking-tight text-fg">
        {card.card.title}
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-fg">{card.card.body}</p>

      <ul className="mt-4 space-y-2">
        {choices.map((choice, i) => {
          const isAnswer = i === answer;
          const picked = chosen === i;
          const style =
            chosen === null
              ? 'border-border bg-surface text-fg'
              : isAnswer
                ? 'border-success bg-success-muted text-fg'
                : picked
                  ? 'border-danger bg-danger-muted text-fg'
                  : 'border-border bg-surface text-fg-muted';
          return (
            <li key={choice}>
              <button
                onClick={() => choose(i)}
                disabled={chosen !== null}
                className={`w-full rounded-lg border px-3 py-3 text-left text-[14px] leading-snug transition-colors ${style}`}
              >
                {choice}
              </button>
            </li>
          );
        })}
      </ul>

      {chosen !== null && (
        <div className="mt-4 pb-1">
          <p className="text-[13px] font-semibold text-fg">
            {chosen === answer ? 'Right.' : 'Not this one.'}
          </p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-fg-muted">{card.card.explanation}</p>
          <div className="mt-4">
            <Takeaway text={card.card.takeaway} />
          </div>
        </div>
      )}
    </Shell>
  );
}

/**
 * Spoken practice prompt with a one-minute timer to practice concise verbal delivery.
 */
function QuestionCard({
  card,
  onAct,
  onPractice,
}: {
  card: Extract<FeedCard, { kind: 'drill' | 'recall' }>;
  onAct: (card: FeedCard, action: FeedAction) => void;
  onPractice: (mode: string, questionId: string) => void;
}) {
  const [left, setLeft] = useState<number | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, []);

  const startClock = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    setLeft(60);
    timer.current = window.setInterval(() => {
      setLeft((v) => {
        if (v === null || v <= 1) {
          if (timer.current !== null) window.clearInterval(timer.current);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
  };

  const recall = card.kind === 'recall';

  return (
    <Shell
      kind={card.kind}
      track={card.track}
      note={recall ? `${card.outcome === 'partial' ? 'Partial' : 'Unsolved'} last time` : null}
      /* Two rows of two and three, never one row of five: at 390px a fourth
         button in the rating row makes "Show again" wrap onto two lines. */
      footer={
        <>
          <div className="flex gap-2">
            <button
              onClick={startClock}
              className="flex-1 rounded-lg border border-border bg-surface px-3 py-3 text-sm font-medium tabular-nums text-fg transition-colors active:bg-surface-hover"
            >
              {left === null
                ? 'Start 60s'
                : left > 0
                  ? `${left}s — keep going`
                  : 'Time. How did that go?'}
            </button>
            <button
              onClick={() => onPractice(card.practice.mode, card.practice.questionId)}
              className="shrink-0 rounded-lg border border-brand bg-surface px-3 py-3 text-sm font-medium text-brand transition-colors active:bg-brand-muted"
            >
              Do it in a round
            </button>
          </div>
          <Actions card={card} onAct={onAct} />
        </>
      }
    >
      <h2 className="text-xl font-semibold leading-tight tracking-tight text-fg">{card.title}</h2>

      <p className="mt-1 text-[11px] uppercase tracking-wide text-fg-subtle">
        Say your approach out loud. Sixty seconds.
      </p>

      <p className="mt-3 text-[15px] leading-relaxed text-fg">{card.prompt}</p>

      {recall && (
        <div className="mt-4 rounded-md border border-border bg-surface-alt p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
            What the report said
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{card.reason}</p>
        </div>
      )}

    </Shell>
  );
}

/**
 * One line from one of your own reports.
 *
 * Shown verbatim, with the round it came from and the quote that earned it.
 * Nothing here is rewritten — the value of seeing a fix again is that it is
 * traceable to a recording you can still listen to.
 */
function FixCard({
  card,
  onAct,
}: {
  card: Extract<FeedCard, { kind: 'fix' }>;
  onAct: (card: FeedCard, action: FeedAction) => void;
}) {
  const when = new Date(card.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <Shell kind="fix" track={card.mode} note={when} footer={<Actions card={card} onAct={onAct} />}>
      <h2 className="text-lg font-semibold leading-snug tracking-tight text-fg">
        {card.dimension ? dimensionLabel(card.dimension) : 'Your last report said'}
      </h2>

      {card.score !== null && (
        <p className="mt-1 text-[12px] tabular-nums text-fg-subtle">
          Averaging {card.score} out of 5 across your recent rounds
        </p>
      )}

      <p className="mt-3 text-[15px] leading-relaxed text-fg">{card.fix}</p>

      {card.evidenceQuote && (
        <blockquote className="mt-4 border-l-2 border-border pl-3 text-[14px] italic leading-relaxed text-fg-muted">
          “{card.evidenceQuote}”
        </blockquote>
      )}
    </Shell>
  );
}

/** `followUpHandling` → "Follow-up handling". */
function dimensionLabel(id: string): string {
  const spaced = id.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Where you are, once, at the top.
 *
 * It carries no rating buttons on purpose: it is not something to learn, and a
 * scoreboard you can mark as "known" is a category error.
 */
function StatCard({ card }: { card: Extract<FeedCard, { kind: 'stat' }> }) {
  const delta =
    card.latestScore !== null && card.previousScore !== null
      ? card.latestScore - card.previousScore
      : null;

  return (
    <Shell kind="stat">
      <div className="flex h-full flex-col justify-center">
        <h2 className="text-2xl font-semibold tracking-tight text-fg">
          {card.streak > 0 ? `${card.streak} day${card.streak === 1 ? '' : 's'} in a row` : 'Start today'}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {card.todayCount > 0
            ? `${card.todayCount} card${card.todayCount === 1 ? '' : 's'} done today.`
            : 'Nothing yet today. Scroll.'}
        </p>

        <dl className="mt-6 grid grid-cols-3 gap-2">
          <Stat label="Due" value={String(card.dueCount)} />
          <Stat label="Rounds / week" value={String(card.roundsThisWeek)} />
          <Stat
            label="Last score"
            value={card.latestScore !== null ? String(Math.round(card.latestScore)) : '—'}
            hint={delta !== null ? `${delta >= 0 ? '+' : ''}${Math.round(delta)}` : undefined}
          />
        </dl>

        {card.weakTopics.length > 0 && (
          <div className="mt-6">
            <p className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
              Leaning towards
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {card.weakTopics.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-surface-alt px-2.5 py-1 text-[12px] text-fg-muted"
                >
                  {t}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
              Taken from the problems your reports say you did not finish, and the delivery
              dimensions you score lowest on.
            </p>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-alt p-3">
      <dd className="text-xl font-semibold tabular-nums text-fg">
        {value}
        {hint && <span className="ml-1 text-[11px] font-medium text-fg-subtle">{hint}</span>}
      </dd>
      <dt className="mt-0.5 text-[11px] text-fg-subtle">{label}</dt>
    </div>
  );
}
