import type { QuestionOutcomeKind } from './evaluation.js';
import { RETIRING_OUTCOMES } from './evaluation.js';

/**
 * Shared random question selection ("Surprise me") and practice rotation logic
 * across interview modes (DSA, core concepts, and system design).
 */

/** The modes with a random draw. Others pick by hand or have nothing to pick. */
export const SURPRISE_MODES = ['dsa', 'concepts', 'system_design'] as const;
export type SurpriseMode = (typeof SURPRISE_MODES)[number];

/**
 * Normalized representation of a candidate practice question.
 * `facets` holds arbitrary categorization keys (difficulty, topics, level)
 * to support multi-faceted filtering uniformly across modes.
 */
export type DrawCandidate = { id: string; facets: Record<string, string[]> };

/**
 * What the draw is allowed to return.
 *
 * An EMPTY selection for a facet means "no constraint", never "nothing
 * allowed" — a fresh install has every facet empty and must still draw from
 * the whole list.
 */
export type DrawRules = {
  /** facet name → allowed values. Empty, or an absent key, is no constraint. */
  facets: Record<string, string[]>;
  /** Skip anything already handed out this cycle. The point of the feature. */
  avoidRepeats: boolean;
  /**
   * Only retire questions from rotation upon a verified clean `solved` verdict,
   * returning unsolved or partially solved questions for further practice.
   */
  repeatUnsolved: boolean;
};

export const DEFAULT_DRAW_RULES: DrawRules = {
  facets: {},
  avoidRepeats: true,
  repeatUnsolved: true,
};

/** One row of `GET /api/questions/attempted`. */
export type PracticeAttempt = {
  id: string;
  count: number;
  lastAt: string;
  outcome: QuestionOutcomeKind | null;
};

/** The columns of one `evaluations` row that decide which one speaks for a round. */
export type EvaluationAttempt = { sessionId: string; status: string; createdAt: Date | string };

const timeOf = (d: Date | string) => (typeof d === 'string' ? Date.parse(d) : d.getTime());

/**
 * The evaluation that speaks for each round.
 *
 * A re-run INSERTS a row, so a round can have several. With `completeOnly` (the
 * default) that is the newest COMPLETE one: a re-run that failed or is still
 * running has produced no verdicts, and letting it win would turn an `unsolved`
 * the previous report gave into a null, which retires the question.
 */
export function latestEvaluationBySession<T extends EvaluationAttempt>(
  rows: readonly T[],
  completeOnly = true,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    if (completeOnly && r.status !== 'complete') continue;
    const cur = out.get(r.sessionId);
    if (!cur || timeOf(r.createdAt) > timeOf(cur.createdAt)) out.set(r.sessionId, r);
  }
  return out;
}

/** One round that may have handed questions out, as `attemptsFromRounds` needs it. */
export type HandoutRound = {
  startedAt: string;
  /** What the config assigned, in the order the interviewer works through it. */
  ids: readonly string[];
  /** `sessions.current_question_idx`: how far the interviewer was heard to get. */
  reachedIdx: number;
  /** Verdicts from the round's latest COMPLETE evaluation; null when it has none. */
  verdicts: ReadonlyMap<string, QuestionOutcomeKind> | null;
};

/**
 * Rounds → one attempt per id, carrying the LATEST round's outcome.
 *
 * `null` means no verdict, and it stays null — the draw counts that as spent,
 * so a round whose report has not landed does not re-offer its question. A
 * `not_reached` verdict, or no verdict for a position past `reachedIdx`, is not
 * a handout at all.
 */
export function attemptsFromRounds(rounds: readonly HandoutRound[]): PracticeAttempt[] {
  const newestFirst = [...rounds].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const seen = new Map<string, PracticeAttempt>();
  for (const round of newestFirst) {
    for (const [idx, id] of [...new Set(round.ids)].entries()) {
      const outcome = round.verdicts?.get(id) ?? null;
      if (outcome === 'not_reached') continue;
      if (!outcome && idx > round.reachedIdx) continue;
      const prev = seen.get(id);
      if (prev) prev.count += 1;
      else seen.set(id, { id, count: 1, lastAt: round.startedAt, outcome });
    }
  }
  return [...seen.values()];
}

/**
 * Extracts question attempts within the current rotation cycle.
 * Attempts older than `cycleStartedAt` are excluded, allowing clean rotation
 * resets without deleting historical attempt records.
 */
export function cycleAttempts(
  attempts: readonly PracticeAttempt[],
  cycleAt: string | null,
): Map<string, QuestionOutcomeKind | null> {
  const parsed = cycleAt ? Date.parse(cycleAt) : 0;
  const floor = Number.isNaN(parsed) ? 0 : parsed;
  const out = new Map<string, QuestionOutcomeKind | null>();
  for (const a of attempts) {
    const at = Date.parse(a.lastAt);
    if (!Number.isNaN(at) && at >= floor) out.set(a.id, a.outcome ?? null);
  }
  return out;
}

/**
 * Spent for the purposes of the draw.
 *
 * `null` — no finished report — counts as SPENT. No verdict is not the same as
 * having failed: without this, ending a round would immediately re-offer the
 * same question while its evaluation was still transcribing.
 */
export function isSpent(
  cycle: ReadonlyMap<string, QuestionOutcomeKind | null>,
  id: string,
  repeatUnsolved: boolean,
): boolean {
  if (!cycle.has(id)) return false;
  if (!repeatUnsolved) return true;
  const outcome = cycle.get(id) ?? null;
  return outcome === null || RETIRING_OUTCOMES.includes(outcome);
}

/**
 * Does this candidate satisfy the rules, repeats aside?
 *
 * ANY-of within a facet, not all-of: picking "graphs" and "dynamic
 * programming" should WIDEN the draw, not narrow it to problems tagged both —
 * which is often none of them. Across facets it is all-of, because difficulty
 * and topic are independent questions.
 */
export function matchesRules(candidate: DrawCandidate, rules: DrawRules): boolean {
  for (const [facet, allowed] of Object.entries(rules.facets)) {
    if (!allowed.length) continue;
    const have = candidate.facets[facet] ?? [];
    if (!have.some((v) => allowed.includes(v))) return false;
  }
  return true;
}

/** Everything the rules allow, repeats aside. */
export function ruleMatches<T extends DrawCandidate>(
  candidates: readonly T[],
  rules: DrawRules,
): T[] {
  return candidates.filter((c) => matchesRules(c, rules));
}

/** Allowed by the rules AND not yet spent this cycle — the cycle's remainder. */
export function eligible<T extends DrawCandidate>(
  candidates: readonly T[],
  rules: DrawRules,
  cycle: ReadonlyMap<string, QuestionOutcomeKind | null>,
): T[] {
  const matched = ruleMatches(candidates, rules);
  if (!rules.avoidRepeats) return matched;
  return matched.filter((c) => !isSpent(cycle, c.id, rules.repeatUnsolved));
}

/**
 * One candidate, uniformly at random.
 *
 * `random` is injectable so a test can pin the draw; nothing in the app passes
 * it.
 */
export function drawOne<T>(pool: readonly T[], random: () => number = Math.random): T | undefined {
  if (!pool.length) return undefined;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * Summary metrics for the current rotation cycle, distinguishing between
 * attempted, solved, and remaining questions.
 */
export function cycleTally(
  candidates: readonly DrawCandidate[],
  cycle: ReadonlyMap<string, QuestionOutcomeKind | null>,
): { solved: number; retry: number; pending: number; asked: number } {
  let solved = 0;
  let retry = 0;
  let pending = 0;
  for (const c of candidates) {
    if (!cycle.has(c.id)) continue;
    const outcome = cycle.get(c.id) ?? null;
    /**
     * A question the interviewer never got to was not asked, so it cannot be
     * counted as one. The API already drops these before they reach a client
     * — this is the same rule stated where the number is produced, so the
     * counter can never claim a question was put to someone when the
     * evaluator's own verdict says it was not.
     */
    if (outcome === 'not_reached') continue;
    if (outcome === null) pending += 1;
    else if (RETIRING_OUTCOMES.includes(outcome)) solved += 1;
    else retry += 1;
  }
  return { solved, retry, pending, asked: solved + retry + pending };
}

/**
 * User-facing diagnostic message explaining why no further questions match the current draw criteria.
 */
export function emptyPoolNote(
  counts: { total: number; ruleMatches: number; eligible: number; pool: number; pending: number },
  rules: DrawRules,
  unit = 'question',
  verdicts = true,
): string | null {
  if (counts.pool > 0 || counts.total === 0) return null;
  if (counts.ruleMatches === 0) return `No ${unit} in this list matches your rules.`;
  // "Picked", not "in this round": a design round picks ONE problem, and the
  // last one standing being the one already selected is the same situation.
  if (counts.eligible > 0) return `Everything these rules allow is already picked.`;
  if (verdicts && rules.repeatUnsolved && counts.pending > 0) {
    return (
      `That is every ${unit} these rules allow. ${counts.pending} more will come back ` +
      `if their reports say you did not solve them.`
    );
  }
  return `That is every ${unit} these rules allow. Reset the cycle to go round again.`;
}
