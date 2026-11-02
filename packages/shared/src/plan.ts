import { z } from 'zod';
import { INTERVIEW_MODES, MODE_SHORT_LABELS, type InterviewMode } from './modes.js';
import { DELIVERY_DIMENSIONS, type Verdict } from './evaluation.js';
import type { FocusResult } from './evaluation.js';

/**
 * Pure calculation rules for study plans, readiness scores, weekly recaps,
 * and onsite simulation loops derived from completed evaluation rounds.
 */

const DAY_MS = 86_400_000;

/** One round as the plan page reads it. */
export type PlanRound = {
  sessionId: string;
  mode: InterviewMode;
  kind: 'round' | 'drill';
  /** The reader's local calendar day the round started on. */
  dayKey: string;
  startedAt: string;
  durationMs: number | null;
  overallScore: number | null;
  overallVerdict: Verdict | null;
  rubricVersion: string | null;
  fillerRate: number | null;
  wordCount: number | null;
  delivery: Record<string, number>;
  /** The best-scored delivery quote of the round, for "your best moment". */
  bestEvidence: { dimension: string; score: number; quote: string; atMs: number | null } | null;
  /** Assigned problems the latest report marked `solved`. */
  solved: { id: string; title: string; difficulty: string | null }[];
};

export type FocusCheckEvent = { dayKey: string; result: FocusResult };

/* ── calendar days ─────────────────────────────────────────────────────────── */

const parseDay = (key: string) => Date.parse(`${key}T00:00:00Z`);

export function shiftDay(key: string, days: number): string {
  const t = parseDay(key);
  return Number.isNaN(t) ? key : new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of the week `key` falls in. */
export function weekOf(key: string): string {
  const t = parseDay(key);
  if (Number.isNaN(t)) return key;
  const weekday = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return shiftDay(key, -weekday);
}

/** Whole days from `today` to `target`; negative once it has passed. */
export function daysUntil(target: string, today: string): number | null {
  const a = parseDay(target);
  const b = parseDay(today);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / DAY_MS);
}

/** Round-scored rounds only: drills and rounds without a finished report are not evidence. */
const scored = (rounds: readonly PlanRound[]) =>
  rounds.filter((r) => r.kind === 'round' && r.overallScore !== null);

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const byStart = (a: PlanRound, b: PlanRound) => a.startedAt.localeCompare(b.startedAt);

/* ── readiness ─────────────────────────────────────────────────────────────── */

/** How many recent rounds readiness averages. One round is an anecdote. */
export const READINESS_WINDOW = 3;
/** Readiness at or above this is "ready" — a `pass` on the evaluator's own scale. */
export const READY_SCORE = 70;
export const CLOSE_SCORE = 55;

export type ReadinessBand = 'not_started' | 'building' | 'close' | 'ready';

export const READINESS_LABELS: Record<ReadinessBand, string> = {
  not_started: 'Not started',
  building: 'Building',
  close: 'Close',
  ready: 'Ready',
};

export type ModeReadiness = {
  mode: InterviewMode;
  /** Mean of the last `READINESS_WINDOW` scored rounds. Null with none. */
  score: number | null;
  rounds: number;
  band: ReadinessBand;
  lastDayKey: string | null;
  /** True when the averaged rounds were scored under different rubric versions. */
  mixedRubric: boolean;
};

/**
 * Per mode, where the most recent rounds put you.
 *
 * `ready` needs TWO rounds at the bar, not one: a single good round is the
 * outcome you would most like to believe and the one least worth trusting.
 */
export function readiness(rounds: readonly PlanRound[]): ModeReadiness[] {
  const s = scored(rounds).sort(byStart);
  return INTERVIEW_MODES.map((mode) => {
    const mine = s.filter((r) => r.mode === mode);
    const recent = mine.slice(-READINESS_WINDOW);
    const score = mean(recent.map((r) => r.overallScore!));
    const rounded = score === null ? null : Math.round(score);
    const band: ReadinessBand =
      rounded === null
        ? 'not_started'
        : rounded >= READY_SCORE && recent.length >= 2
          ? 'ready'
          : rounded >= CLOSE_SCORE
            ? 'close'
            : 'building';
    return {
      mode,
      score: rounded,
      rounds: mine.length,
      band,
      lastDayKey: mine.at(-1)?.dayKey ?? null,
      mixedRubric: new Set(recent.map((r) => r.rubricVersion)).size > 1,
    };
  });
}

/* ── the week's plan ───────────────────────────────────────────────────────── */

/** Modes planned for when the profile names none: the three a typical loop is made of. */
export const DEFAULT_TARGET_MODES: readonly InterviewMode[] = ['dsa', 'system_design', 'behavioural'];
export const DEFAULT_WEEKLY_ROUNDS = 4;

export type WeekSlot = { mode: InterviewMode; planned: number; done: number; why: string };

/**
 * How this week's rounds should be spread, weakest first.
 *
 * A mode you have never tried outranks every scored one, because "no idea" is
 * a weaker position than any number. No mode gets more than half the week: a
 * plan that is four rounds of your worst mode is a plan nobody follows.
 */
export function weeklyPlan(
  ready: readonly ModeReadiness[],
  targetModes: readonly InterviewMode[],
  weeklyRounds: number,
  rounds: readonly PlanRound[],
  todayKey: string,
): WeekSlot[] {
  const modes = (targetModes.length ? targetModes : DEFAULT_TARGET_MODES).filter((m, i, a) => a.indexOf(m) === i);
  const week = weekOf(todayKey);
  const doneIn = (mode: InterviewMode) =>
    rounds.filter((r) => r.kind === 'round' && r.mode === mode && weekOf(r.dayKey) === week).length;

  const rank = (m: InterviewMode) => {
    const r = ready.find((x) => x.mode === m);
    return r?.score ?? -1;
  };
  const order = [...modes].sort((a, b) => rank(a) - rank(b));
  const cap = Math.max(1, Math.ceil(weeklyRounds / 2));
  const planned = new Map<InterviewMode, number>(order.map((m) => [m, 0]));

  let left = Math.max(0, Math.round(weeklyRounds));
  // Round-robin down the weakness order, so every target mode gets one before
  // the weakest gets a second.
  while (left > 0 && order.some((m) => planned.get(m)! < cap)) {
    for (const m of order) {
      if (left === 0) break;
      if (planned.get(m)! >= cap) continue;
      planned.set(m, planned.get(m)! + 1);
      left--;
    }
  }

  return order
    .filter((m) => planned.get(m)! > 0)
    .map((m) => {
      const r = ready.find((x) => x.mode === m);
      const why =
        !r || r.band === 'not_started'
          ? `No ${MODE_SHORT_LABELS[m]} round yet`
          : `${MODE_SHORT_LABELS[m]} readiness ${r.score}`;
      return { mode: m, planned: planned.get(m)!, done: doneIn(m), why };
    });
}

/* ── the weekly recap ──────────────────────────────────────────────────────── */

export type WeeklyRecap = {
  weekKey: string;
  rounds: number;
  drills: number;
  lastWeekRounds: number;
  meanScore: number | null;
  lastWeekMeanScore: number | null;
  fillerRate: number | null;
  lastWeekFillerRate: number | null;
  /** The delivery dimension that rose most against the four weeks before. */
  mostImproved: { dimension: string; label: string; delta: number } | null;
  fixesApplied: number;
  fixesChecked: number;
  best: (NonNullable<PlanRound['bestEvidence']> & { sessionId: string; label: string }) | null;
};

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export function weeklyRecap(
  rounds: readonly PlanRound[],
  checks: readonly FocusCheckEvent[],
  todayKey: string,
): WeeklyRecap {
  const week = weekOf(todayKey);
  const lastWeek = shiftDay(week, -7);
  const inWeek = (r: { dayKey: string }, w: string) => weekOf(r.dayKey) === w;

  const all = rounds.filter((r) => r.kind === 'round');
  const now = all.filter((r) => inWeek(r, week));
  const before = all.filter((r) => inWeek(r, lastWeek));
  const scoredNow = scored(now);
  const scoredBefore = scored(before);

  const filler = (xs: PlanRound[]) =>
    mean(xs.filter((r) => r.fillerRate !== null && (r.wordCount ?? 0) >= 100).map((r) => r.fillerRate!));

  // Four weeks before this one, so one bad week last week does not flatter this one.
  const baseline = scored(all).filter((r) => {
    const w = weekOf(r.dayKey);
    return w < week && w >= shiftDay(week, -28);
  });
  let mostImproved: WeeklyRecap['mostImproved'] = null;
  for (const dim of DELIVERY_DIMENSIONS) {
    const a = mean(scoredNow.map((r) => r.delivery[dim.id]).filter((x): x is number => typeof x === 'number'));
    const b = mean(baseline.map((r) => r.delivery[dim.id]).filter((x): x is number => typeof x === 'number'));
    if (a === null || b === null) continue;
    const delta = Math.round((a - b) * 10) / 10;
    if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) {
      mostImproved = { dimension: dim.id, label: dim.label, delta };
    }
  }

  let best: WeeklyRecap['best'] = null;
  for (const r of [...now].sort(byStart)) {
    const e = r.bestEvidence;
    if (!e) continue;
    // Ties go to the later round: the newest version of you is the one to hear.
    if (!best || e.score >= best.score) {
      best = { ...e, sessionId: r.sessionId, label: `${MODE_SHORT_LABELS[r.mode]}, ${r.dayKey}` };
    }
  }

  const weekChecks = checks.filter((c) => inWeek(c, week) && c.result !== 'no_chance');

  return {
    weekKey: week,
    rounds: now.length,
    drills: rounds.filter((r) => r.kind === 'drill' && inWeek(r, week)).length,
    lastWeekRounds: before.length,
    meanScore: round1(mean(scoredNow.map((r) => r.overallScore!))),
    lastWeekMeanScore: round1(mean(scoredBefore.map((r) => r.overallScore!))),
    fillerRate: round1(filler(now)),
    lastWeekFillerRate: round1(filler(before)),
    mostImproved,
    fixesApplied: weekChecks.filter((c) => c.result === 'applied').length,
    fixesChecked: weekChecks.length,
    best,
  };
}

/* ── personal bests ────────────────────────────────────────────────────────── */

/** A filler rate from fewer words than this is noise, not a record. */
export const FILLER_BEST_MIN_WORDS = 300;

export type PersonalBest = {
  id: string;
  label: string;
  value: string;
  sessionId: string | null;
  dayKey: string | null;
};

/**
 * Records worth beating, each linked to the round that set it.
 *
 * Scores only count within the CURRENT rubric version — a best set under a
 * rubric that has since moved is not one you can beat on equal terms. Measured
 * numbers (filler rate, problems solved, the streak) are rubric-free and count
 * across all of history.
 */
export function personalBests(rounds: readonly PlanRound[], currentRubric: string): PersonalBest[] {
  const real = rounds.filter((r) => r.kind === 'round').sort(byStart);
  const current = scored(real).filter((r) => r.rubricVersion === currentRubric);
  const out: PersonalBest[] = [];

  for (const mode of INTERVIEW_MODES) {
    const mine = current.filter((r) => r.mode === mode);
    if (!mine.length) continue;
    // Earliest round to reach the top score, so the record has a date it was set.
    const top = mine.reduce((a, b) => (b.overallScore! > a.overallScore! ? b : a));
    out.push({
      id: `best-score:${mode}`,
      label: `Best ${MODE_SHORT_LABELS[mode]} score`,
      value: `${Math.round(top.overallScore!)}`,
      sessionId: top.sessionId,
      dayKey: top.dayKey,
    });
  }

  const strong = current.find((r) => r.overallVerdict === 'strong_pass');
  if (strong) {
    out.push({
      id: 'first-strong-pass',
      label: 'First strong pass',
      value: MODE_SHORT_LABELS[strong.mode],
      sessionId: strong.sessionId,
      dayKey: strong.dayKey,
    });
  }

  const fluent = real.filter((r) => r.fillerRate !== null && (r.wordCount ?? 0) >= FILLER_BEST_MIN_WORDS);
  if (fluent.length) {
    const low = fluent.reduce((a, b) => (b.fillerRate! < a.fillerRate! ? b : a));
    out.push({
      id: 'lowest-filler',
      label: 'Fewest filler words',
      value: `${low.fillerRate} per 100 words`,
      sessionId: low.sessionId,
      dayKey: low.dayKey,
    });
  }

  const hard = real.find((r) => r.solved.some((q) => q.difficulty?.toLowerCase() === 'hard'));
  if (hard) {
    out.push({
      id: 'first-hard',
      label: 'First Hard problem solved',
      value: hard.solved.find((q) => q.difficulty?.toLowerCase() === 'hard')!.title,
      sessionId: hard.sessionId,
      dayKey: hard.dayKey,
    });
  }

  const most = real.reduce<PlanRound | null>((a, b) => (b.solved.length > (a?.solved.length ?? 0) ? b : a), null);
  if (most && most.solved.length >= 2) {
    out.push({
      id: 'most-solved',
      label: 'Most problems solved in one round',
      value: `${most.solved.length}`,
      sessionId: most.sessionId,
      dayKey: most.dayKey,
    });
  }

  const full = current.filter((r) => Object.keys(r.delivery).length >= DELIVERY_DIMENSIONS.length - 2);
  if (full.length) {
    const avg = (r: PlanRound) => mean(Object.values(r.delivery))!;
    const top = full.reduce((a, b) => (avg(b) > avg(a) ? b : a));
    out.push({
      id: 'best-delivery',
      label: 'Best delivery average',
      value: `${avg(top).toFixed(1)} / 5`,
      sessionId: top.sessionId,
      dayKey: top.dayKey,
    });
  }

  const streak = longestDayStreak(real.map((r) => r.dayKey));
  if (streak.days >= 2) {
    out.push({
      id: 'longest-streak',
      label: 'Longest run of days with a round',
      value: `${streak.days} days`,
      sessionId: null,
      dayKey: streak.endKey,
    });
  }

  return out;
}

export function longestDayStreak(days: readonly string[]): { days: number; endKey: string | null } {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let endKey: string | null = null;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && shiftDay(sorted[i - 1]!, 1) === sorted[i] ? run + 1 : 1;
    if (run > best) {
      best = run;
      endKey = sorted[i]!;
    }
  }
  return { days: best, endKey };
}

/* ── onsite loops ──────────────────────────────────────────────────────────── */

export const loopStageSchema = z.object({
  mode: z.enum(INTERVIEW_MODES),
  minutes: z.number().int().min(5).max(90),
});
export type LoopStage = z.infer<typeof loopStageSchema>;

export const LOOP_TEMPLATES = {
  onsite: {
    label: 'Full onsite',
    blurb: 'Two coding rounds, a design round and a behavioural round, the way most big-company loops run.',
    stages: [
      { mode: 'dsa', minutes: 45 },
      { mode: 'dsa', minutes: 45 },
      { mode: 'system_design', minutes: 45 },
      { mode: 'behavioural', minutes: 30 },
    ],
  },
  short: {
    label: 'Short loop',
    blurb: 'One of each, shorter — a loop you can finish in an evening.',
    stages: [
      { mode: 'dsa', minutes: 30 },
      { mode: 'system_design', minutes: 30 },
      { mode: 'behavioural', minutes: 20 },
    ],
  },
  startup: {
    label: 'Startup',
    blurb: 'Coding, a deep dive into what you have built, then the offer conversation.',
    stages: [
      { mode: 'dsa', minutes: 30 },
      { mode: 'experience', minutes: 30 },
      { mode: 'hr', minutes: 20 },
    ],
  },
  final: {
    label: 'Final round',
    blurb: 'The hiring manager, then HR.',
    stages: [
      { mode: 'behavioural', minutes: 30 },
      { mode: 'hr', minutes: 20 },
    ],
  },
} as const satisfies Record<string, { label: string; blurb: string; stages: readonly LoopStage[] }>;
export type LoopTemplateId = keyof typeof LOOP_TEMPLATES;
export const LOOP_TEMPLATE_IDS = Object.keys(LOOP_TEMPLATES) as LoopTemplateId[];

export const createLoopSchema = z.object({
  template: z.enum(LOOP_TEMPLATE_IDS as [LoopTemplateId, ...LoopTemplateId[]]),
});

/** A round that fills a stage: long enough to have put the material to you. */
export type LoopStageRound = {
  sessionId: string;
  stage: number;
  mode: InterviewMode;
  status: string;
  durationMs: number | null;
  startedAt: string;
  verdict: Verdict | null;
  score: number | null;
  evaluationStatus: string | null;
};

/**
 * Resolves qualifying rounds per loop stage and identifies the next active stage.
 * The latest qualifying round wins, requiring sufficient duration and a valid or pending evaluation.
 */
export function loopProgress(
  stages: readonly LoopStage[],
  rounds: readonly LoopStageRound[],
  minMs: number,
): { filled: (LoopStageRound | null)[]; next: number | null } {
  const filled = stages.map((s, i) => {
    const mine = rounds
      .filter((r) =>
        r.stage === i && r.mode === s.mode && (r.durationMs ?? 0) >= minMs &&
        (r.status === 'completed' || r.evaluationStatus !== null))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return mine.at(-1) ?? null;
  });
  const next = filled.findIndex((f) => f === null);
  return { filled, next: next === -1 ? null : next };
}

export const LOOP_DECISIONS = ['pending', 'strong_hire', 'hire', 'lean_no', 'no_hire'] as const;
export type LoopDecision = (typeof LOOP_DECISIONS)[number];

export const LOOP_DECISION_LABELS: Record<LoopDecision, string> = {
  pending: 'Waiting on reports',
  strong_hire: 'Strong hire',
  hire: 'Hire',
  lean_no: 'Leaning no hire',
  no_hire: 'No hire',
};

/**
 * The loop's combined decision, by a FIXED rule rather than a model's opinion.
 *
 * It is the rule most hiring committees roughly apply: one clear fail sinks
 * the loop, two borderlines do too, and a strong hire needs strength in at
 * least half the rounds with no doubts anywhere. Stated in `reasons` so the
 * page can say exactly why, which a model's verdict could not.
 */
export function loopDecision(verdicts: readonly (Verdict | null)[]): { decision: LoopDecision; reasons: string[] } {
  if (!verdicts.length || verdicts.some((v) => v === null)) {
    return { decision: 'pending', reasons: ['Every round needs a finished report before the loop can be decided.'] };
  }
  const n = verdicts.length;
  const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
  const fails = count('fail');
  const borderline = count('borderline');
  const strong = count('strong_pass');

  if (fails > 0) {
    return { decision: 'no_hire', reasons: [`${fails} round${fails > 1 ? 's' : ''} failed — a single clear fail usually ends a loop.`] };
  }
  if (borderline >= 2) {
    return { decision: 'lean_no', reasons: [`${borderline} borderline rounds — two doubts rarely survive a hiring committee.`] };
  }
  if (borderline === 0 && strong * 2 >= n) {
    return { decision: 'strong_hire', reasons: [`No doubts, and ${strong} of ${n} rounds were strong passes.`] };
  }
  return {
    decision: 'hire',
    reasons: [
      borderline === 1
        ? 'One borderline round, carried by passes everywhere else.'
        : `Every round passed; ${strong} of ${n} were strong.`,
    ],
  };
}

/** `GET /api/loops/:id`, and each row of the list. */
export type LoopView = {
  id: string;
  template: string;
  label: string;
  startedAt: string;
  abandonedAt: string | null;
  stages: (LoopStage & { round: LoopStageRound | null })[];
  /** Index of the next stage to run; null once every stage has a round. */
  next: number | null;
  decision: LoopDecision;
  reasons: string[];
};

/** `GET /api/plan`: raw facts, which the browser folds with the rules above on the reader's own calendar. */
export type PlanSummary = {
  currentRubric: string;
  target: {
    targetCompany: string | null;
    targetRole: string | null;
    targetDate: string | null;
    weeklyRounds: number;
    targetModes: InterviewMode[];
  };
  /** `PlanRound` without `dayKey`, which only the browser can compute. */
  rounds: Omit<PlanRound, 'dayKey'>[];
  /** Every focus verdict on a commitment, with when its round started. */
  checks: { startedAt: string; result: FocusResult }[];
  loops: LoopView[];
};
