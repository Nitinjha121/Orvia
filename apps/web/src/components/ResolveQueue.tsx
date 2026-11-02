import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RESOLVE_INTERVALS_DAYS, daysUntil, isDue, resolveQueue,
  type QuestionOutcomeKind, type ResolveHistory, type ResolveItem,
} from '@orvia/shared';
import { useApi } from '../hooks/useApi';
import { localDayKey } from '../lib/time';
import { clearCycle, cycleStart, resetCycle } from '../lib/practice';
import { diffColor } from '../lib/colors';
import { ErrorNote } from './ui/ErrorNote';
import { Modal } from './ui/Modal';
import { ConfirmButton } from './ui/ConfirmButton';

const OUTCOME: Record<QuestionOutcomeKind, { label: string; color: string }> = {
  solved: { label: 'Solved', color: 'var(--orvia-color-success)' },
  partial: { label: 'Partial', color: 'var(--orvia-color-warning)' },
  unsolved: { label: 'Unsolved', color: 'var(--orvia-color-danger)' },
  not_reached: { label: 'Not reached', color: 'var(--orvia-color-fg-subtle)' },
};

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const STEP_LABELS = RESOLVE_INTERVALS_DAYS.map((d) => (d % 7 === 0 ? plural(d / 7, 'week') : plural(d, 'day')));

/** How the ladder reads in one sentence, wherever it is shown. */
export const RESOLVE_EXPLAINER =
  `A problem a report marks partial or unsolved comes back after ${STEP_LABELS.join(', then ')}. ` +
  'Solve it three times in a row and it is done; miss it and it starts again.';

/** Formats a date key as "25 Sep" on the reader's calendar. */
const shortDate = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** The draw's cycle markers hold this one too: same storage, same semantics. */
const RESET_SCOPE = 'resolve:dsa';

/**
 * The re-solve queue, folded on the reader's own calendar (`resolveQueue`),
 * from the "start over" marker in this browser when there is one.
 */
export function useResolveQueue() {
  const state = useApi<ResolveHistory>('/api/questions/resolve');
  const today = localDayKey();
  const [since, setSince] = useState<string | null>(() => cycleStart(RESET_SCOPE));
  const attempts = useMemo(
    () => (state.data?.attempts ?? []).map((a) => ({ ...a, dayKey: localDayKey(new Date(a.startedAt)) })),
    [state.data],
  );
  const items = useMemo(() => resolveQueue(attempts, since), [attempts, since]);
  /** What a reset is hiding, so the undo can say what it brings back. */
  const hidden = useMemo(
    () => (since ? resolveQueue(attempts).filter((i) => !items.some((x) => x.questionId === i.questionId)).length : 0),
    [attempts, items, since],
  );
  const bank = useMemo(() => new Map((state.data?.questions ?? []).map((q) => [q.id, q])), [state.data]);
  const startOver = useCallback(() => setSince(resetCycle(RESET_SCOPE)), []);
  const undoStartOver = useCallback(() => {
    clearCycle(RESET_SCOPE);
    setSince(null);
  }, []);
  return {
    today,
    items,
    due: items.filter((i) => isDue(i, today)),
    upcoming: items.filter((i) => !isDue(i, today)),
    bank,
    since,
    hidden,
    startOver,
    undoStartOver,
    error: state.error,
    reload: state.reload,
    loaded: state.data !== null,
  };
}

export type ResolveQueueState = ReturnType<typeof useResolveQueue>;

function when(item: ResolveItem, today: string): { text: string; color: string } {
  if (item.pending) return { text: 'Waiting for the report', color: 'var(--orvia-color-fg-subtle)' };
  const d = daysUntil(item.dueKey, today) ?? 0;
  if (d < 0) return { text: `Overdue by ${-d} day${d === -1 ? '' : 's'}`, color: 'var(--orvia-color-warning)' };
  if (d === 0) return { text: 'Due today', color: 'var(--orvia-color-warning)' };
  if (d === 1) return { text: 'Due tomorrow', color: 'var(--orvia-color-fg-muted)' };
  return { text: `Due ${shortDate(item.dueKey)}`, color: 'var(--orvia-color-fg-muted)' };
}

/** Three segments, one per spacing; filled once a solve has cleared it. */
function Ladder({ step }: { step: number }) {
  return (
    <span className="flex items-center gap-1" role="img"
          aria-label={`${step} of ${RESOLVE_INTERVALS_DAYS.length} re-solves done`}>
      {STEP_LABELS.map((label, i) => (
        <span key={label} title={label}
              className="h-1.5 w-5 rounded-full"
              style={{
                background: i < step ? 'var(--orvia-color-success)' : 'var(--orvia-color-surface-alt)',
                outline: i === step ? '1px solid var(--orvia-color-border)' : undefined,
              }} />
      ))}
      <span className="ml-1 text-[11px] tabular-nums text-fg-subtle">
        {step}/{RESOLVE_INTERVALS_DAYS.length}
      </span>
    </span>
  );
}

function Row({
  item, queue, picked, onResolve,
}: { item: ResolveItem; queue: ResolveQueueState; picked: boolean; onResolve: (id: string) => void }) {
  const q = queue.bank.get(item.questionId);
  const w = when(item, queue.today);
  const miss = OUTCOME[item.miss.outcome];
  const since = item.history.slice(-4);

  return (
    <li className="min-w-0 rounded-md border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-fg">
            <span className="min-w-0">{q?.title ?? item.questionId}</span>
            {q && (
              <span className="text-[11px] font-semibold capitalize" style={{ color: diffColor(q.difficulty) }}>
                {q.difficulty}
              </span>
            )}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium tabular-nums" style={{ color: w.color }}>{w.text}</span>
            <Ladder step={item.step} />
          </p>
        </div>
        <button type="button" onClick={() => onResolve(item.questionId)} disabled={picked}
          aria-label={picked ? `${q?.title ?? item.questionId} is picked` : `Re-solve ${q?.title ?? item.questionId}`}
          className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity ${
            picked
              ? 'cursor-default bg-success-muted text-success'
              : isDue(item, queue.today)
                ? 'bg-brand text-brand-fg hover:opacity-90'
                : 'border border-border text-fg hover:bg-surface-hover'}`}>
          {picked ? '✓ Picked' : 'Re-solve'}
        </button>
      </div>

      {item.miss.reason && (
        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
          <span className="font-semibold" style={{ color: miss.color }}>{miss.label}</span>
          {' on '}{shortDate(item.miss.dayKey)}: {item.miss.reason}{' '}
          <Link to={`/session/${item.miss.sessionId}`} className="whitespace-nowrap font-medium text-brand hover:underline">
            See report
          </Link>
        </p>
      )}

      {since.length > 1 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-subtle">
          {since.map((h, i) => (
            <span key={h.sessionId} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden>→</span>}
              <Link to={`/session/${h.sessionId}`} className="flex items-center gap-1 hover:text-fg">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: OUTCOME[h.outcome].color }} aria-hidden />
                {OUTCOME[h.outcome].label.toLowerCase()} {shortDate(h.dayKey)}
              </Link>
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

function StartOver({ queue }: { queue: ResolveQueueState }) {
  return (
    <ConfirmButton label="Start over" question="Clear the queue? Your reports are kept."
      confirmLabel="Yes, start over" onConfirm={queue.startOver}
      className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline" />
  );
}

/** Said after a reset, for as long as it is hiding anything, with the way back. */
function StartedOver({ queue }: { queue: ResolveQueueState }) {
  if (!queue.since || !queue.hidden) return null;
  return (
    <p aria-live="polite" className="text-xs text-fg-muted">
      Started over on {shortDate(localDayKey(new Date(queue.since)))}: {queue.hidden} earlier{' '}
      {queue.hidden === 1 ? 'problem is' : 'problems are'} hidden.{' '}
      <button type="button" onClick={queue.undoStartOver} className="font-medium text-brand hover:underline">
        Undo
      </button>
    </p>
  );
}

/**
 * Rows, the first `initial` of them shown and the rest behind a button: twenty
 * overdue problems in one list reads as a debt, not a plan.
 */
export function ResolveList({
  items, queue, onResolve, picked = [], initial = 5,
}: {
  items: ResolveItem[];
  queue: ResolveQueueState;
  onResolve: (questionId: string) => void;
  picked?: readonly string[];
  initial?: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, initial);
  return (
    <>
      <ul className="space-y-2">
        {shown.map((item) => (
          <Row key={item.questionId} item={item} queue={queue}
               picked={picked.includes(item.questionId)} onResolve={onResolve} />
        ))}
      </ul>
      {items.length > shown.length && (
        <button type="button" onClick={() => setAll(true)}
          className="mt-2 text-xs font-medium text-brand hover:underline">
          Show {items.length - shown.length} more
        </button>
      )}
    </>
  );
}

/**
 * The setup screen's entry point: one line above the DSA list, opening the due
 * problems in a modal. Absent when nothing is due. `onResolve` ticks a problem
 * on the form and never starts a round — that tap is the user's, and it is the
 * one that grants the microphone — so the modal stays open for picking more.
 */
export function ResolveStrip({
  picked, onResolve,
}: { picked: readonly string[]; onResolve: (questionId: string) => void }) {
  const queue = useResolveQueue();
  const [open, setOpen] = useState(false);
  if (queue.error) {
    return <ErrorNote message={`The re-solve queue did not load: ${queue.error}`} onRetry={queue.reload} />;
  }
  if (!queue.due.length) {
    return queue.since && queue.hidden ? (
      <div className="rounded-md border border-border bg-surface-alt px-3 py-2"><StartedOver queue={queue} /></div>
    ) : null;
  }
  const pickedHere = queue.due.filter((i) => picked.includes(i.questionId)).length;
  const overdue = queue.due.filter((i) => (daysUntil(i.dueKey, queue.today) ?? 0) < 0).length;

  return (
    <>
      <div className="flex items-center gap-3 rounded-md border border-border bg-surface-alt px-3 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-fg">
          <span className="font-semibold tabular-nums">{queue.due.length}</span>{' '}
          {queue.due.length === 1 ? 'problem' : 'problems'} due to re-solve
          {overdue > 0 && <span className="text-fg-muted"> · {overdue} overdue</span>}
          {pickedHere > 0 && <span className="text-success"> · {pickedHere} picked</span>}
        </p>
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
          className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90">
          Review
        </button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)}
        title={<>Due to re-solve <span className="font-normal tabular-nums text-fg-muted">· {queue.due.length}</span></>}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="text-xs text-fg-muted">
              {pickedHere
                ? `${pickedHere} picked. Close this, check the settings, then press Start.`
                : 'Pick one or more. Nothing starts until you press Start.'}
            </p>
            <div className="flex items-center gap-3">
              <StartOver queue={queue} />
              <Link to="/plan" className="text-xs text-fg-subtle hover:text-fg hover:underline">Whole queue</Link>
              <button type="button" onClick={() => setOpen(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-hover">
                Done
              </button>
            </div>
          </div>
        }>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">
          {RESOLVE_EXPLAINER} Oldest first.
        </p>
        <ResolveList items={queue.due} queue={queue} picked={picked} onResolve={onResolve} />
      </Modal>
    </>
  );
}

/** The Plan page's section: everything on the ladder, in three bands. */
export function ResolveSection({ onResolve }: { onResolve: (questionId: string) => void }) {
  const queue = useResolveQueue();
  const [showLater, setShowLater] = useState(false);
  const weekOut = queue.upcoming.filter((i) => (daysUntil(i.dueKey, queue.today) ?? 0) <= 7);
  const later = queue.upcoming.filter((i) => !weekOut.includes(i));

  return (
    <section aria-labelledby="resolve-section" className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="resolve-section" className="text-sm font-semibold text-fg">Re-solve queue</h2>
        {queue.loaded && queue.items.length > 0 && (
          <span className="flex items-baseline gap-3 text-xs tabular-nums text-fg-muted">
            {[
              [queue.due.length, 'due'], [weekOut.length, 'this week'], [later.length, 'later'],
            ].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ')}
            <StartOver queue={queue} />
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
        {RESOLVE_EXPLAINER} Only rounds count: a drill is scored after you have read the answer.
        Start over clears the queue; only rounds after it count, and nothing is deleted.
      </p>
      <div className="mt-2 empty:hidden"><StartedOver queue={queue} /></div>
      {queue.error && <ErrorNote className="mt-3" message={`The queue did not load: ${queue.error}`} onRetry={queue.reload} />}
      {!queue.loaded && !queue.error && <p className="mt-3 text-sm text-fg-subtle">Loading…</p>}

      {queue.loaded && (
        <div className="mt-4 space-y-5">
          {queue.items.length === 0 && (
            <p className="text-sm text-fg-subtle">
              {queue.since && queue.hidden
                ? 'A clean slate. Problems a report marks partial or unsolved from now on will appear here.'
                : 'Nothing to re-solve. When a report marks a DSA problem partial or unsolved, it will appear here.'}
            </p>
          )}

          {queue.items.length > 0 && (
            <div>
              <Band title="Due now" />
              {queue.due.length ? (
                <>
                  {queue.due.length > 5 && (
                    <p className="mb-2 text-xs text-fg-muted">
                      Oldest first. One or two a day clears this faster than a long session.
                    </p>
                  )}
                  <ResolveList items={queue.due} queue={queue} onResolve={onResolve} />
                </>
              ) : (
                <p className="text-sm text-fg-subtle">All caught up for today.</p>
              )}
            </div>
          )}

          {weekOut.length > 0 && (
            <div>
              <Band title="Coming up this week" />
              <ResolveList items={weekOut} queue={queue} onResolve={onResolve} initial={3} />
            </div>
          )}

          {later.length > 0 && (
            showLater ? (
              <div>
                <Band title="Later" />
                <ResolveList items={later} queue={queue} onResolve={onResolve} initial={later.length} />
              </div>
            ) : (
              <button type="button" onClick={() => setShowLater(true)}
                className="text-xs font-medium text-brand hover:underline">
                Show {later.length} due later
              </button>
            )
          )}
        </div>
      )}
    </section>
  );
}

function Band({ title }: { title: string }) {
  return <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</p>;
}
