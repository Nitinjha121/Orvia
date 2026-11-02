import { z } from 'zod';
import type { DrillView } from './drills.js';

/**
 * Rubric definitions, evaluation schema, and scoring anchors.
 * Bump RUBRIC_VERSION whenever scoring anchors or evaluation criteria change
 * so progress history remains consistent within each version.
 */
/**
 * 1.1.0 — added per-question complexity comparison (stated vs your code vs optimal).
 */
/**
 * 1.2.0 — evaluator given actual round duration to prevent erroneous deductions.
 */
/**
 * 1.3.0 — evaluator informed of missing interviewer turns with placeholders.
 */
/**
 * 1.4.0 — evaluator given measured interviewer dead-air windows.
 */
/**
 * 1.5.0 — speech metrics require dual waveforms; unmeasured metrics are omitted.
 */
export const RUBRIC_VERSION = '1.5.0';

/**
 * Every dimension is scored so that HIGHER IS ALWAYS BETTER, even where the
 * underlying trait is negative. "Nervousness" becomes "composure", "rambling"
 * becomes "concision". A report that mixes directions is unreadable at a
 * glance and impossible to chart.
 */
export type DeliveryDimension = {
  id: string;
  label: string;
  /** What is being measured, in one line, shown under the score. */
  question: string;
  /** Anchors for 1, 3 and 5. The model is given these verbatim. */
  anchors: { 1: string; 3: string; 5: string };
  /** Whether judging this needs the audio, or the transcript is enough. */
  needsAudio: boolean;
};

export const DELIVERY_DIMENSIONS: DeliveryDimension[] = [
  {
    id: 'confidence',
    label: 'Confidence',
    question: 'Did you sound like you believed what you were saying?',
    anchors: {
      1: 'Tentative throughout. Statements rise like questions; frequent hedging ("I think maybe", "I could be wrong"). An interviewer would doubt claims that were actually correct.',
      3: 'Assured on familiar ground, visibly less so when pushed. Some hedging, but recovers.',
      5: 'Steady and self-assured without overclaiming. States what is known plainly and flags genuine uncertainty deliberately rather than nervously.',
    },
    needsAudio: true,
  },
  {
    id: 'composure',
    label: 'Composure',
    question: 'Did you stay steady, or did nerves show?',
    anchors: {
      1: 'Audibly nervous — rushed pace, unsteady voice, audible stumbles. Nerves interfered with the content.',
      3: 'Some early nerves that settle. Occasional acceleration when uncertain.',
      5: 'Calm throughout, including under probing. Pace and tone stay level when challenged.',
    },
    needsAudio: true,
  },
  {
    id: 'decisiveness',
    label: 'Decisiveness',
    question: 'Did you commit to an answer, or circle it?',
    anchors: {
      1: 'Long stalls before answering. Repeatedly restarts, abandons a direction and returns to it without resolving.',
      3: 'Takes a moment to commit, then follows the thread through.',
      5: 'Picks a direction quickly, states it, and either commits or explicitly changes course with a reason.',
    },
    needsAudio: true,
  },
  {
    id: 'clarity',
    label: 'Clarity',
    question: 'Could the interviewer follow what you meant?',
    anchors: {
      1: 'Hard to follow. Ambiguous pronouns, undefined terms, ideas arriving out of order.',
      3: 'Mostly clear, with passages that need a second pass to parse.',
      5: 'Consistently easy to follow. Terms defined before use, one idea at a time.',
    },
    needsAudio: false,
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    question: 'Did you explain WHY, not just WHAT?',
    anchors: {
      1: 'Asserts conclusions with no justification. "We used Redis" with no reason offered even when asked.',
      3: 'Gives reasons when asked, but rarely volunteers them.',
      5: 'Reasoning is visible by default — options considered, trade-offs named, the choice justified before being asked.',
    },
    needsAudio: false,
  },
  {
    id: 'structure',
    label: 'Structure',
    question: 'Were your answers organised, or did they arrive as a stream?',
    anchors: {
      1: 'No discernible shape. Starts mid-thought, jumps between levels of detail.',
      3: 'Loose structure. Gets there, but the listener assembles the order.',
      5: 'Signposted and ordered — approach first, then reasoning, then detail, then complexity or trade-offs.',
    },
    needsAudio: false,
  },
  {
    id: 'concision',
    label: 'Concision',
    question: 'Did you get to the point, or ramble?',
    anchors: {
      1: 'Substantially over-long. Restates the same point repeatedly; the answer is buried.',
      3: 'Somewhat verbose. The point lands, later than it needed to.',
      5: 'Tight. Answers the question, adds the necessary support, and stops.',
    },
    needsAudio: false,
  },
  {
    id: 'fluency',
    label: 'Fluency',
    question: 'How much did filler words and verbal tics intrude?',
    anchors: {
      1: 'Filler dominates — heavy "um", "uh", "like", "you know" to the point of distraction.',
      3: 'Noticeable filler, clustered where you were thinking, but the content still carries.',
      5: 'Clean delivery. Pauses are silent rather than filled.',
    },
    needsAudio: true,
  },
  {
    id: 'listening',
    label: 'Listening',
    question: 'Did you answer the question that was actually asked?',
    anchors: {
      1: 'Answers a different question — often the one you wanted, not the one asked. Misses the point of follow-ups.',
      3: 'Addresses the question, sometimes after a detour.',
      5: 'Answers precisely what was asked, and asks for clarification when the question is genuinely ambiguous.',
    },
    needsAudio: false,
  },
  {
    id: 'followUpHandling',
    label: 'Handling follow-ups',
    question: 'How did you respond when pushed?',
    anchors: {
      1: 'Defensive or destabilised. Repeats the original answer louder, or abandons a correct position under mild pressure.',
      3: 'Engages with the challenge, sometimes rattled by it.',
      5: 'Treats probing as collaboration. Defends what holds up, concedes what does not, updates cleanly.',
    },
    needsAudio: true,
  },
  {
    id: 'professionalism',
    label: 'Professionalism',
    question: 'Did the register match a real interview?',
    anchors: {
      1: 'Register is off — dismissive of the question, overly casual, or disparaging about past colleagues or employers.',
      3: 'Appropriate throughout, with occasional slips into over-familiarity.',
      5: 'Consistently professional and warm. Comfortable without being casual.',
    },
    needsAudio: true,
  },
  {
    id: 'humility',
    label: 'Calibration',
    question: 'Was your confidence proportionate to what you actually knew?',
    anchors: {
      1: 'Overclaims. Presents guesses as facts, or dismisses alternatives without engaging. Reads as arrogant.',
      3: 'Broadly calibrated, occasionally more certain than the evidence supports.',
      5: 'Confidence tracks knowledge. Says "I do not know" cleanly and without apology, then reasons toward an answer.',
    },
    needsAudio: false,
  },
];

export const DELIVERY_DIMENSION_IDS = DELIVERY_DIMENSIONS.map((d) => d.id);

/* ── verdicts ──────────────────────────────────────────────────────────────── */

export const VERDICTS = ['strong_pass', 'pass', 'borderline', 'fail'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  strong_pass: 'Strong pass',
  pass: 'Pass',
  borderline: 'Borderline',
  fail: 'Fail',
};

/* ── deterministic speech metrics ──────────────────────────────────────────── */

/**
 * Measured in code, never asked of the model — LLMs cannot count reliably, and
 * these need to be stable across model and rubric changes to be worth
 * charting. They are passed to the evaluator as established facts, so a field
 * that could not be measured is NULL, never estimated (see 1.5.0 above).
 */
export type SpeechMetrics = {
  /** Null without the candidate's waveform. */
  totalSpeakingMs: number | null;
  wordCount: number;
  /** Null without the candidate's waveform, or under a second of speech. */
  wordsPerMinute: number | null;
  fillerCount: number;
  /** Per 100 words, so sessions of different lengths compare. */
  fillerRate: number;
  fillerBreakdown: Record<string, number>;
  /** Null unless measured between BOTH waveforms. */
  medianResponseLatencyMs: number | null;
  /** Null unless measured between BOTH waveforms. */
  longestSilenceMs: number | null;
  /** Your speaking time as a fraction of all speaking time. Null without your waveform. */
  talkRatio: number | null;
  meanTurnWords: number;
};

/**
 * Counted against the verbatim transcript. Ordered longest-first so multi-word
 * phrases match before their single-word prefixes ("you know" before "know").
 */
export const FILLER_PATTERNS: { id: string; pattern: RegExp }[] = [
  { id: 'you know', pattern: /\byou know\b/gi },
  { id: 'i mean', pattern: /\bi mean\b/gi },
  { id: 'sort of', pattern: /\bsort of\b/gi },
  { id: 'kind of', pattern: /\bkind of\b/gi },
  { id: 'basically', pattern: /\bbasically\b/gi },
  { id: 'actually', pattern: /\bactually\b/gi },
  { id: 'literally', pattern: /\bliterally\b/gi },
  { id: 'obviously', pattern: /\bobviously\b/gi },
  { id: 'right?', pattern: /\bright\?/gi },
  { id: 'um', pattern: /\bu+m+\b/gi },
  { id: 'uh', pattern: /\bu+h+\b/gi },
  { id: 'er', pattern: /\ber+\b/gi },
  { id: 'like', pattern: /\blike\b/gi },
  { id: 'so', pattern: /\bso,/gi },
];

/* ── the report ────────────────────────────────────────────────────────────── */

/**
 * One axis of a complexity comparison: candidate's claim, actual cost of their
 * code, and optimal algorithmic cost. Comparing all three distinguishes between
 * misanalyzing one's own code and implementing a suboptimal algorithm.
 */
export const complexityAxisSchema = z.object({
  /** 'time' | 'space' | 'output' — the last is the size of the returned result. */
  axis: z.enum(['time', 'space', 'output']),
  /**
   * What they said, in their own terms, normalised to big-O notation.
   *
   * NULL when they never stated it. This must never be inferred, guessed or
   * back-filled from what the code does: the entire value of the column is
   * that it reports what the candidate actually claimed, and a fabricated
   * claim is worse than a blank. "Not stated" is itself a finding.
   */
  stated: z.string().nullable(),
  /**
   * The candidate's exact words, so the claim is auditable and can be replayed.
   * Null whenever `stated` is null.
   */
  statedQuote: z.string().nullable(),
  statedAtMs: z.number().nullable().optional(),
  /** The true cost of THE CODE THEY WROTE, whether or not it is optimal. */
  actual: z.string(),
  /** The cost of the model solution shown beside it. */
  optimal: z.string(),
  /**
   * Did the claim match their own code? `null` when nothing was stated, so the
   * UI can show "not stated" rather than a red cross for a question that was
   * never reached.
   */
  correct: z.boolean().nullable(),
});
export type ComplexityAxis = z.infer<typeof complexityAxisSchema>;

export const questionEvaluationSchema = z.object({
  question: z.string(),
  myAnswer: z.string(),
  idealAnswer: z.string(),
  /**
   * A working reference implementation, for coding rounds. Produced by the
   * evaluator rather than read from the question bank, so every question has
   * one and it is written in the language the candidate actually used.
   */
  modelSolution: z.string().nullable().optional(),
  modelSolutionLanguage: z.string().nullable().optional(),
  /**
   * Stated-vs-actual complexity, one entry per axis. Empty for rounds with no
   * code and for questions where complexity never came up — an empty array
   * hides the whole section rather than rendering a table of blanks.
   */
  complexity: z.array(complexityAxisSchema).default([]),
  whatWasGood: z.array(z.string()),
  whatWasMissing: z.array(z.string()),
  howToImprove: z.string(),
  score: z.number().min(0).max(10),
  verdict: z.enum(VERDICTS),
  startMs: z.number().nullable().optional(),
});
export type QuestionEvaluation = z.infer<typeof questionEvaluationSchema>;

/* ── did you actually solve it? ────────────────────────────────────────────── */

/**
 * Problem-level outcomes for assigned questions (one entry per id in
 * `sessions.config.questionIds`). Kept separate from conversation-scoped
 * question evaluations to map directly back to bank problem IDs for rotation.
 */
export const QUESTION_OUTCOMES = ['solved', 'partial', 'unsolved', 'not_reached'] as const;
export type QuestionOutcomeKind = (typeof QUESTION_OUTCOMES)[number];

export const QUESTION_OUTCOME_LABELS: Record<QuestionOutcomeKind, string> = {
  solved: 'Solved',
  partial: 'Partly solved',
  unsolved: 'Not solved',
  not_reached: 'Not reached',
};

/**
 * Outcomes that retire a question from rotation. Only `solved` retires a problem;
 * `partial` and `not_reached` remain in rotation for future practice.
 */
export const RETIRING_OUTCOMES: readonly QuestionOutcomeKind[] = ['solved'];

export const questionOutcomeSchema = z.object({
  /** `dsa_questions.id` — a LeetCode slug from THIS round's assigned list. */
  questionId: z.string(),
  outcome: z.enum(QUESTION_OUTCOMES),
  /** One sentence. Why this verdict and not the neighbouring one. */
  reason: z.string(),
  /**
   * The candidate's own words that decide it, so a claim this consequential is
   * auditable — it is what removes a question from your practice rotation.
   * Null only for `not_reached`, where by definition they said nothing.
   */
  evidenceQuote: z.string().nullable(),
});
export type QuestionOutcome = z.infer<typeof questionOutcomeSchema>;

/* ── what the candidate said they were working on ──────────────────────────── */

/**
 * Whether a fix the candidate carried INTO this round showed up in it.
 *
 * `no_chance` is separate from `not_applied` because a round can give no
 * opening for a fix at all — "state the complexity before coding" in an HR
 * round — and counting that as a miss would break a streak the candidate did
 * nothing to break.
 */
export const FOCUS_RESULTS = ['applied', 'partly', 'not_applied', 'no_chance'] as const;
export type FocusResult = (typeof FOCUS_RESULTS)[number];

export const FOCUS_RESULT_LABELS: Record<FocusResult, string> = {
  applied: 'Applied',
  partly: 'Partly',
  not_applied: 'Not applied',
  no_chance: 'No chance this round',
};

/**
 * One item the round carried: a commitment from an earlier report (`key` is
 * its id) or, in a drill, one of the weaknesses the moment was retried for.
 * Snapshotted onto the session at start, so a re-evaluation judges the same
 * list the candidate saw on screen.
 */
export const focusItemSchema = z.object({
  key: z.string(),
  text: z.string(),
  source: z.enum(['commitment', 'drill']),
});
export type FocusItem = z.infer<typeof focusItemSchema>;

export const focusCheckSchema = z.object({
  /** One of THIS round's focus keys — a closed enum in the response schema. */
  key: z.string(),
  result: z.enum(FOCUS_RESULTS),
  /**
   * The candidate's words showing it. Required for `applied` and `partly`
   * (`persistFocusChecks` drops either without one); null for `no_chance`, and
   * for a `not_applied` that was an omission with nothing to quote.
   */
  evidenceQuote: z.string().nullable(),
  /** One sentence: why this result and not the neighbouring one. */
  note: z.string(),
});
export type FocusCheck = z.infer<typeof focusCheckSchema>;

export const deliveryScoreSchema = z.object({
  dimension: z.string(),
  score: z.number().min(1).max(5),
  assessment: z.string(),
  /** Required: a score without evidence is generic coaching prose. */
  evidenceQuote: z.string().nullable(),
  evidenceAtMs: z.number().nullable().optional(),
});
export type DeliveryScore = z.infer<typeof deliveryScoreSchema>;

export const evaluationReportSchema = z.object({
  overallScore: z.number().min(0).max(100),
  overallVerdict: z.enum(VERDICTS),
  summary: z.string(),
  topFixes: z.array(z.string()),
  questions: z.array(questionEvaluationSchema),
  /**
   * Defaulted rather than required: non-DSA rounds have no assigned bank
   * questions, and an old report has none stored. An empty array hides the
   * section rather than rendering an empty table.
   */
  assignedQuestions: z.array(questionOutcomeSchema).default([]),
  delivery: z.array(deliveryScoreSchema),
  /** Defaulted for the reason `assignedQuestions` is: most rounds carry no focus. */
  focusChecks: z.array(focusCheckSchema).default([]),
});
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export type EvaluationStatus = 'pending' | 'transcribing' | 'evaluating' | 'complete' | 'failed';

/** What was actually run, kept on the report so the history is self-describing. */
export type SessionMeta = {
  mode: string;
  voice: string;
  interviewerModel: string;
  plannedMinutes: number | null;
  actualMs: number | null;
  difficulty: string | null;
  persona: string | null;
  /** Null on rounds recorded before styles existed, which ran as `general`. */
  style: string | null;
  startedAt: string;
  /** The last buffer touched. Correct on its own only for a one-question round. */
  finalCode: string | null;
  codeLanguage: string | null;
  /**
   * What was written for EACH question, keyed by question id.
   *
   * `finalCode` above is one column that every context push overwrote, so a
   * multi-question round reported whichever question happened to be open when
   * the candidate stopped typing and lost the rest. Null on rounds recorded
   * before this was kept, and on rounds with nothing to key on.
   */
  questionCode: Record<string, { code?: string; language?: string | null }> | null;
  /**
   * The problems this round covered, with their source links, so the report can
   * offer to open them where the code can actually be run. Taken from the
   * question bank rather than from the report text — the evaluator writes the
   * question in its own words, which is not something to build a URL from.
   */
  problems: { id: string; title: string; url: string | null }[];
};

/** Stored under `evaluations.raw.degraded`; each reason is shown to the candidate verbatim. */
export type EvaluationDegraded = {
  audio: string | null;
  verbatim: string | null;
};

export type EvaluationView = {
  id: string;
  sessionId: string;
  session: SessionMeta | null;
  status: EvaluationStatus;
  rubricVersion: string;
  model: string;
  provider: string;
  /** False when the evaluator read a transcript instead of hearing the audio. */
  audioAnalysed: boolean;
  transcriptSource: string | null;
  /**
   * Explains why audio recording or verbatim transcription is missing if degraded
   * (e.g. file size cap exceeded or transcription segment dropout).
   */
  degraded: EvaluationDegraded | null;
  overallScore: number | null;
  overallVerdict: Verdict | null;
  summary: string | null;
  topFixes: string[] | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  questions: (QuestionEvaluation & { id: string; idx: number })[];
  /**
   * One row per problem the round assigned, with the title resolved from the
   * question bank. Empty for modes with no bank to assign from (everything but
   * `dsa` and `concepts`) and for reports written before outcomes were
   * recorded.
   */
  assignedQuestions: (QuestionOutcome & {
    idx: number;
    title: string;
    difficulty: string | null;
    url: string | null;
  })[];
  delivery: DeliveryScore[];
  metrics: SpeechMetrics | null;
  /**
   * Every focus item the round carried, with the evaluator's verdict on it.
   * `result` is null when the item was carried but this report has no verdict
   * for it — an older report, or one the evaluator skipped — and never
   * defaulted to a miss.
   */
  focus: (FocusItem & {
    result: FocusResult | null;
    evidenceQuote: string | null;
    note: string | null;
  })[];
  /** Set only on a drill: what it retried and how the retry compares. */
  drill: DrillView | null;
  /**
   * The newest evaluation of this round when it is NOT the one shown above —
   * set only when a re-run failed and an earlier report completed, so the
   * failure does not hide the good report. Null otherwise.
   */
  latestAttempt: {
    id: string;
    status: EvaluationStatus;
    error: string | null;
    createdAt: string;
  } | null;
};

/**
 * Response schema when a session has no evaluation row.
 * `pending` indicates whether an evaluation is actively in-flight, allowing
 * clients to differentiate between in-progress work and sessions that will not be scored.
 */
export type NoEvaluation = {
  status: 'none';
  /** A run is genuinely in flight. The ONLY case where polling should continue. */
  pending: boolean;
  /** Why there is no report, in the user's words. Null while `pending`. */
  reason: string | null;
  /** Whether asking for one now could plausibly produce a report. */
  evaluable: boolean;
};
