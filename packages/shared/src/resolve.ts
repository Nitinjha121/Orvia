import type { QuestionOutcomeKind } from './evaluation.js';
import { shiftDay } from './plan.js';

/**
 * Spaced repetition logic for re-solving previously missed DSA problems.
 * Queue schedules are derived dynamically from completed round evaluations.
 */

/**
 * Days until the next re-solve, by step. A miss puts a problem at step 0; each
 * solve climbs one step; a solve at the last step masters it and it leaves the
 * queue. A miss anywhere drops it back to step 0.
 */
export const RESOLVE_INTERVALS_DAYS = [3, 7, 21] as const;

/** One assigned problem in one round, as the server reports it. */
export type ResolveAttempt = {
  questionId: string;
  sessionId: string;
  startedAt: string;
  /**
   * The latest complete report's verdict. `null` while that round's report is
   * still being written; a round whose evaluation failed is not sent at all,
   * or it would read as "pending" for ever.
   */
  outcome: QuestionOutcomeKind | null;
  /** The evaluator's one-line reason, for a verdict. */
  reason: string | null;
};

/** `GET /api/questions/resolve`. */
export type ResolveHistory = {
  attempts: ResolveAttempt[];
  /** Titles for every id in `attempts`, joined from the bank. */
  questions: { id: string; title: string; difficulty: string; topics: string[] }[];
};

export type ResolveItem = {
  questionId: string;
  /** 0 after a miss; 1 and 2 after one and two solves since it. */
  step: number;
  /** The day it is due, `YYYY-MM-DD`. */
  dueKey: string;
  /** The miss that put it here, with the evaluator's reason. */
  miss: { sessionId: string; dayKey: string; outcome: 'partial' | 'unsolved'; reason: string | null };
  /** Every verdict on it, oldest first. */
  history: { sessionId: string; dayKey: string; outcome: QuestionOutcomeKind }[];
  /** A round on it has ended and its report is not in yet. */
  pending: boolean;
};

/**
 * Derives due re-solve problems ordered by next due date.
 * Missed problems advance up the interval ladder with each successful solve;
 * rounds before `since` are excluded to support queue resets without data deletion.
 */
export function resolveQueue(
  attempts: readonly (ResolveAttempt & { dayKey: string })[],
  since: string | null = null,
): ResolveItem[] {
  const parsed = since ? Date.parse(since) : 0;
  const floor = Number.isNaN(parsed) ? 0 : parsed;
  const ordered = attempts
    .filter((a) => Date.parse(a.startedAt) >= floor)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const items = new Map<string, ResolveItem>();
  const history = new Map<string, ResolveItem['history']>();

  for (const a of ordered) {
    if (a.outcome === 'not_reached') continue;
    const item = items.get(a.questionId);
    if (a.outcome === null) {
      if (item) item.pending = true;
      continue;
    }
    const past = history.get(a.questionId) ?? [];
    past.push({ sessionId: a.sessionId, dayKey: a.dayKey, outcome: a.outcome });
    history.set(a.questionId, past);

    if (a.outcome === 'partial' || a.outcome === 'unsolved') {
      items.set(a.questionId, {
        questionId: a.questionId,
        step: 0,
        dueKey: shiftDay(a.dayKey, RESOLVE_INTERVALS_DAYS[0]),
        miss: { sessionId: a.sessionId, dayKey: a.dayKey, outcome: a.outcome, reason: a.reason },
        history: past,
        pending: false,
      });
    } else if (item) {
      const step = item.step + 1;
      if (step >= RESOLVE_INTERVALS_DAYS.length) items.delete(a.questionId);
      else Object.assign(item, { step, dueKey: shiftDay(a.dayKey, RESOLVE_INTERVALS_DAYS[step]!), pending: false });
    }
  }

  return [...items.values()].sort(
    (a, b) => a.dueKey.localeCompare(b.dueKey) || a.questionId.localeCompare(b.questionId),
  );
}

/** Due on or before `todayKey`, and not waiting on a report. */
export const isDue = (item: ResolveItem, todayKey: string) => !item.pending && item.dueKey <= todayKey;
