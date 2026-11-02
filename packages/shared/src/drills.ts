import { DELIVERY_DIMENSIONS, type FocusResult, type Verdict } from './evaluation.js';
import type { InterviewMode } from './modes.js';

/**
 * Core domain types and utilities for moments (report weaknesses),
 * drills (targeted practice on a specific question), and commitments (candidate goals).
 * Evaluated as focus items without exposing previous mistakes to the interviewer.
 */

/** A question scored at or below this, out of ten, is offered for a retry. */
export const MOMENT_QUESTION_MAX_SCORE = 7;
/** A delivery dimension scored at or below this, out of five, is offered. */
export const MOMENT_DELIVERY_MAX_SCORE = 3;
/** How many weaknesses one drill carries. More than three is a list, not a focus. */
export const MAX_DRILL_FOCUS = 3;

/**
 * Default drill length. A coding or design question needs time to write
 * something; a spoken answer plus two follow-ups fits in five, which is the
 * shortest round `sessionOptionsSchema` allows.
 */
export const DRILL_MINUTES: Record<InterviewMode, number> = {
  dsa: 15,
  system_design: 15,
  concepts: 5,
  jd: 5,
  experience: 5,
  behavioural: 5,
  hr: 5,
};
export const DRILL_MINUTE_CHOICES = [5, 10, 15] as const;

/**
 * Modes whose interviewer guards key on the round's bank ids
 * (`QuestionScopeGuard`, the starter skeletons). A drill there must narrow the
 * round to ONE real problem, so an unmatched question cannot be drilled.
 */
const NEEDS_BANK_ID: readonly InterviewMode[] = ['dsa'];
/** Modes with a bank to narrow to when the question can be matched. */
const HAS_BANK: readonly InterviewMode[] = ['dsa', 'concepts', 'behavioural'];

export type MomentBefore = {
  score: number;
  outOf: 10 | 5;
  verdict: Verdict | null;
  quote: string | null;
  /** Where the moment starts in the source recording, when it was measured. */
  atMs: number | null;
};

export type Moment = {
  /** `q:<question_evaluations.id>` or `d:<dimension>`. */
  id: string;
  kind: 'question' | 'delivery';
  /** A delivery dimension's id. Null for a question moment. */
  dimension: string | null;
  label: string;
  /** What the drill puts to the candidate. Null when it cannot be placed. */
  question: string | null;
  /** The bank row the drill narrows to, when the mode has one and it matched. */
  questionId: string | null;
  /** Shown on screen during the drill and checked by the evaluator after it. */
  focus: string[];
  /** The report's own advice, shown beside the focus. */
  advice: string;
  before: MomentBefore;
  /** Why this moment cannot be drilled. Null when it can. */
  unavailable: string | null;
};

/** A drill's score next to the moment it retried. */
export type DrillAttempt = {
  sessionId: string;
  startedAt: string;
  evaluationStatus: string | null;
  /** Same scale as `before`. Null until the report lands, or if it has no match. */
  after: number | null;
  outOf: 10 | 5;
  applied: number;
  checked: number;
};

export type MomentsView = {
  sessionId: string;
  /** False on a drill's own report: a drill's moments are its source's. */
  offersMoments: boolean;
  /** Why there are no moments, when there are none. */
  reason: string | null;
  moments: (Moment & { attempts: DrillAttempt[] })[];
};

/** What a drill session stores in `sessions.drill`. */
export type DrillRecord = {
  sourceSessionId: string;
  sourceEvaluationId: string;
  momentId: string;
  kind: Moment['kind'];
  dimension: string | null;
  label: string;
  question: string;
  focus: string[];
  advice: string;
  before: MomentBefore;
};

export type DrillView = DrillRecord & {
  after: { score: number | null; outOf: 10 | 5; verdict: Verdict | null; quote: string | null };
  /** Every drill of this moment, oldest first, this one included. */
  attempts: DrillAttempt[];
};

/** What `deriveMoments` reads from one complete report. */
export type MomentSource = {
  mode: InterviewMode;
  questions: {
    id: string;
    question: string;
    score: number;
    verdict: Verdict;
    whatWasMissing: string[];
    howToImprove: string;
    startMs: number | null;
  }[];
  delivery: {
    dimension: string;
    score: number;
    assessment: string;
    evidenceQuote: string | null;
    evidenceAtMs: number | null;
  }[];
  /** The round's own bank questions, in round order. Empty for modes with none. */
  bank: BankEntry[];
};

/** `statement` is the prompt the interviewer read aloud, when the bank has one. */
export type BankEntry = { id: string; title: string; statement?: string };

const norm = (s: string) =>
  ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const words = (s: string) => new Set(norm(s).trim().split(' ').filter((w) => w.length > 2));

/**
 * A report question that shares at least this fraction of its words with one
 * statement, and this much more than with any other, is about that problem.
 */
const STATEMENT_MIN_SHARE = 0.5;
const STATEMENT_MIN_LEAD = 0.2;

/**
 * Matches a report question to an assigned bank question by exact title match,
 * longest unambiguous title subset, or highest word-overlap with problem statements.
 */
export function matchBankQuestion(question: string, bank: readonly BankEntry[]): string | null {
  if (bank.length === 1) return bank[0]!.id;
  const text = norm(question);
  const hits = bank.filter((b) => norm(b.title).trim() !== '' && text.includes(norm(b.title)));
  if (hits.length) {
    const longest = hits.reduce((a, b) => (norm(b.title).length > norm(a.title).length ? b : a));
    return hits.every((h) => norm(longest.title).includes(norm(h.title))) ? longest.id : null;
  }

  const asked = words(question);
  if (!asked.size) return null;
  const shares = bank
    .filter((b) => b.statement)
    .map((b) => {
      const said = words(b.statement!);
      let shared = 0;
      for (const w of asked) if (said.has(w)) shared++;
      return { id: b.id, share: shared / asked.size };
    })
    .sort((a, b) => b.share - a.share);
  const [best, next] = shares;
  if (!best || best.share < STATEMENT_MIN_SHARE) return null;
  return !next || best.share - next.share >= STATEMENT_MIN_LEAD ? best.id : null;
}

/** The report question being answered at `atMs`: the last one asked at or before it. */
export function questionAt<T extends { startMs: number | null }>(questions: readonly T[], atMs: number | null): T | null {
  if (atMs == null) return null;
  let best: T | null = null;
  for (const q of questions) {
    if (q.startMs == null || q.startMs > atMs) continue;
    if (!best || q.startMs >= (best.startMs ?? -1)) best = q;
  }
  return best;
}

/**
 * The moments one report offers, weakest first.
 *
 * Questions come before delivery at the same weakness, because a delivery
 * drill still has to put a question — the one that was being answered when the
 * quote was said — and that question is only as good as its own row.
 */
export function deriveMoments(src: MomentSource): Moment[] {
  const out: Moment[] = [];

  const place = (q: MomentSource['questions'][number] | null) => {
    if (!q) {
      return {
        question: null,
        questionId: null,
        unavailable: 'The quote could not be placed at a question in the round, so there is nothing to put to you again.',
      };
    }
    const questionId = HAS_BANK.includes(src.mode) ? matchBankQuestion(q.question, src.bank) : null;
    if (NEEDS_BANK_ID.includes(src.mode) && !questionId) {
      return {
        question: q.question,
        questionId: null,
        unavailable: 'This question could not be matched to one problem in the round, so it cannot be put to you on its own.',
      };
    }
    return { question: q.question, questionId, unavailable: null };
  };

  for (const q of src.questions) {
    if (q.score > MOMENT_QUESTION_MAX_SCORE) continue;
    const missing = q.whatWasMissing.map((m) => m.trim()).filter(Boolean);
    const p = place(q);
    out.push({
      id: `q:${q.id}`,
      kind: 'question',
      dimension: null,
      label: q.question.length > 90 ? `${q.question.slice(0, 87).trimEnd()}…` : q.question,
      question: p.question,
      questionId: p.questionId,
      focus: (missing.length ? missing : [q.howToImprove.trim()]).filter(Boolean).slice(0, MAX_DRILL_FOCUS),
      advice: q.howToImprove,
      before: { score: q.score, outOf: 10, verdict: q.verdict, quote: null, atMs: q.startMs },
      unavailable: p.unavailable,
    });
  }

  for (const d of src.delivery) {
    if (d.score > MOMENT_DELIVERY_MAX_SCORE || !d.evidenceQuote) continue;
    const dim = DELIVERY_DIMENSIONS.find((x) => x.id === d.dimension);
    if (!dim) continue;
    const p = place(questionAt(src.questions, d.evidenceAtMs));
    out.push({
      id: `d:${d.dimension}`,
      kind: 'delivery',
      dimension: d.dimension,
      label: dim.label,
      question: p.question,
      questionId: p.questionId,
      focus: [`${dim.label}: ${dim.anchors[5]}`],
      advice: d.assessment,
      before: { score: d.score, outOf: 5, verdict: null, quote: d.evidenceQuote, atMs: d.evidenceAtMs },
      unavailable: p.unavailable,
    });
  }

  const weakness = (m: Moment) => m.before.score / m.before.outOf;
  return out.sort((a, b) => weakness(a) - weakness(b) || (a.kind === b.kind ? 0 : a.kind === 'question' ? -1 : 1));
}

/**
 * Which of a drill's own report questions is the retried one.
 *
 * A drill has one question, but the evaluator may still split it — a
 * clarifying exchange, a follow-up — so the retried question is the one whose
 * text shares the most words with what was put, and with no overlap at all
 * there is no honest "after" and the answer is null.
 */
export function drillQuestionMatch<T extends { question: string }>(put: string, questions: readonly T[]): T | null {
  if (questions.length === 1) return questions[0]!;
  const want = words(put);
  let best: T | null = null;
  let bestScore = 0;
  for (const q of questions) {
    const got = words(q.question);
    let shared = 0;
    for (const w of got) if (want.has(w)) shared++;
    if (shared > bestScore) {
      best = q;
      bestScore = shared;
    }
  }
  return best;
}

/* ── commitments ───────────────────────────────────────────────────────────── */

export const MAX_OPEN_COMMITMENTS = 3;
/** Applied in this many consecutive rounds that gave it a chance, and it is done. */
export const COMMITMENT_CLOSE_STREAK = 2;

export type CommitmentProgress = {
  status: 'open' | 'closed';
  /** Consecutive `applied` at the end of the history, `no_chance` skipped. */
  streak: number;
  applied: number;
  /** Rounds that gave it a chance: everything but `no_chance`. */
  chances: number;
};

/**
 * Where a commitment stands, from its checks OLDEST FIRST.
 *
 * `no_chance` neither counts nor breaks the run — the round simply did not ask
 * for it. Once the run reaches `COMMITMENT_CLOSE_STREAK` it is closed, and
 * stays closed: a closed commitment is no longer carried, so nothing after it
 * could be a fair test.
 */
export function commitmentProgress(results: readonly FocusResult[]): CommitmentProgress {
  let streak = 0;
  let applied = 0;
  let chances = 0;
  for (const r of results) {
    if (r === 'no_chance') continue;
    chances++;
    if (r === 'applied') {
      applied++;
      streak++;
      if (streak >= COMMITMENT_CLOSE_STREAK) return { status: 'closed', streak, applied, chances };
    } else {
      streak = 0;
    }
  }
  return { status: 'open', streak, applied, chances };
}

/** `GET /api/commitments`, one row. */
export type CommitmentView = {
  id: string;
  text: string;
  sourceSessionId: string | null;
  createdAt: string;
  status: 'open' | 'closed' | 'dropped';
  progress: CommitmentProgress;
  /** Every round that carried it and has a verdict on it, oldest first. */
  history: { sessionId: string; startedAt: string; result: FocusResult }[];
};
