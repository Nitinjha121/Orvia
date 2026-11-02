import { z } from 'zod';
import { CODE_LANGUAGES, NOTE_LANGUAGES } from './languages.js';

/**
 * Interview modes and configuration schemas.
 * Modes differ in the prompt context provided to the interviewer model;
 * audio streaming pipelines remain uniform across all modes.
 */
export const INTERVIEW_MODES = [
  'dsa',
  'system_design',
  'concepts',
  'jd',
  'experience',
  'behavioural',
  'hr',
] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const MODE_LABELS: Record<InterviewMode, string> = {
  dsa: 'DSA Interview',
  jd: 'Job Description Interview',
  experience: 'Experience-Based Interview',
  system_design: 'System Design Interview',
  concepts: 'Core Concepts Interview',
  behavioural: 'Behavioural Interview',
  hr: 'HR & Negotiation Round',
};

/**
 * Tab labels. Separate from `MODE_LABELS` because the tabs are one row and
 * seven of "Experience-Based Interview" wraps into a paragraph — while history,
 * the report header and `/api/health` all want the full name. Adding a mode
 * means adding both.
 */
export const MODE_SHORT_LABELS: Record<InterviewMode, string> = {
  dsa: 'DSA',
  system_design: 'System design',
  concepts: 'Concepts',
  jd: 'Job description',
  experience: 'Experience',
  behavioural: 'Behavioural',
  hr: 'HR & salary',
};

/** Modes that put a typing surface on screen beside the conversation. */
export const MODES_WITH_EDITOR: InterviewMode[] = ['dsa', 'system_design'];

/**
 * Fallback list shown before the API responds. The real list is DB-driven
 * (`GET /api/questions/collections`) so new categories need no code change.
 */
export const DEFAULT_COLLECTION = 'neetcode150';

/**
 * Minimum session duration for a question to count as attempted in the rotation.
 * Prevents premature disconnects or short aborts from consuming questions.
 */
export const HANDOUT_MIN_MS = 60_000;

export const dsaConfigSchema = z.object({
  mode: z.literal('dsa'),
  /** IDs from the local question bank. */
  questionIds: z.array(z.string()).min(1),
  /** Whether the candidate gets a code editor panel shared with the AI. */
  codeEditor: z.boolean().default(true),
  language: z.enum([...CODE_LANGUAGES, ...NOTE_LANGUAGES]).default('python'),
});

export const jdConfigSchema = z.object({
  mode: z.literal('jd'),
  jobDescription: z.string().min(50),
  /** Optional: focus the round (e.g. "backend depth", "behavioural"). */
  focus: z.string().optional(),
});

export const experienceConfigSchema = z.object({
  mode: z.literal('experience'),
  /** Free-form resume / projects / responsibilities / achievements dump. */
  experience: z.string().min(50),
  /** Optional: restrict probing to specific projects. */
  focusProjects: z.array(z.string()).optional(),
  /**
   * The role being prepared for. Steers WHICH of their claims get probed; it is
   * never part of the background. No default, so a round started without one
   * re-parses byte-identical to rounds recorded before this field existed.
   */
  jobDescription: z.string().min(50).optional(),
});

export const systemDesignConfigSchema = z.object({
  mode: z.literal('system_design'),
  /** e.g. "Design a rate limiter", or a custom prompt. */
  problem: z.string().min(5),
  /**
   * Bank problem identifier when the problem was selected from the bank.
   * Optional for custom user-supplied prompts or legacy sessions.
   */
  problemId: z.string().optional(),
  /** Target level shifts how deep the follow-ups go. */
  level: z.enum(['junior', 'mid', 'senior', 'staff']).default('mid'),
  /** Whether the candidate gets a diagram/notes panel shared with the AI. */
  scratchpad: z.boolean().default(true),
});

/**
 * Concepts interview mode: technical verbal screening without live coding.
 * Constrained by a closed list of question IDs to prevent model invention.
 */
export const conceptsConfigSchema = z.object({
  mode: z.literal('concepts'),
  /** IDs from `concept_questions`. */
  questionIds: z.array(z.string()).min(1),
  /**
   * How far past the definition the follow-ups push. The same question about
   * the event loop is a different interview at each of these.
   */
  depth: z.enum(['fundamentals', 'practical', 'internals']).default('practical'),
});

/**
 * Competency questions answered from the candidate's own history.
 *
 * `experience` is carried on the config rather than read from the profile at
 * round time so an old round stays reproducible: the brief the interviewer was
 * given is the one that was true when it ran.
 */
export const behaviouralConfigSchema = z.object({
  mode: z.literal('behavioural'),
  /** IDs from `behavioural_questions`. Closed list, as above. */
  questionIds: z.array(z.string()).min(1),
  /** The candidate's background, so the probing has something to check against. */
  experience: z.string().default(''),
});

/**
 * Behavioral and HR compensation negotiation scenario configuration.
 * Captures target roles and salary expectations as optional context for realistic negotiation practice.
 */
export const hrConfigSchema = z.object({
  mode: z.literal('hr'),
  /** ID from `hr_scenarios`. */
  scenarioId: z.string().min(1),
  targetRole: z.string().optional(),
  /** Free text, not a number: "₹24L fixed + 4L variable" is the honest shape. */
  currentCompensation: z.string().optional(),
  expectedCompensation: z.string().optional(),
  noticePeriod: z.string().optional(),
  /** What else is on the table, if anything. Drives how hard the round pushes. */
  competingOffers: z.string().optional(),
  /** Why they are looking — the question every HR round opens with. */
  reasonForLeaving: z.string().optional(),
});

export const interviewConfigSchema = z.discriminatedUnion('mode', [
  dsaConfigSchema,
  jdConfigSchema,
  experienceConfigSchema,
  systemDesignConfigSchema,
  conceptsConfigSchema,
  behaviouralConfigSchema,
  hrConfigSchema,
]);
export type InterviewConfig = z.infer<typeof interviewConfigSchema>;

/**
 * System design rounds are the one mode with a canonical shape. Giving the
 * interviewer an explicit phase ladder stops it from rambling and makes the
 * evaluator's job tractable (it can score each phase).
 */
export const SYSTEM_DESIGN_PHASES = [
  'requirements',
  'estimation',
  'api_design',
  'data_model',
  'high_level_design',
  'deep_dive',
  'bottlenecks_and_tradeoffs',
] as const;
export type SystemDesignPhase = (typeof SYSTEM_DESIGN_PHASES)[number];

/**
 * The longest round that can be booked. Exported because the abandoned-round
 * sweep in `SessionService` derives its window from it.
 */
export const MAX_DURATION_MINUTES = 90;

export const DIFFICULTIES = ['warmup', 'standard', 'hard'] as const;
export const PERSONAS = ['friendly', 'neutral', 'terse'] as const;

/**
 * Which company's interview loop the interviewer imitates. It changes what gets
 * PROBED — leadership principles, alternatives, speed, pragmatism — and never
 * the rubric: the evaluator scores every style against the same anchors, so a
 * style is not a reason to bump `RUBRIC_VERSION`.
 */
export const INTERVIEW_STYLES = ['general', 'amazon', 'google', 'meta', 'startup'] as const;
export type InterviewStyle = (typeof INTERVIEW_STYLES)[number];

export const STYLE_LABELS: Record<InterviewStyle, string> = {
  general: 'General',
  amazon: 'Amazon',
  google: 'Google',
  meta: 'Meta',
  startup: 'Startup',
};

export const sessionOptionsSchema = z.object({
  /** Wall-clock target. The interviewer paces itself against this. */
  durationMinutes: z.number().int().min(5).max(MAX_DURATION_MINUTES).default(30),
  difficulty: z.enum(DIFFICULTIES).default('standard'),
  /** Interviewer persona — changes tone, not rigour. */
  persona: z.enum(PERSONAS).default('neutral'),
  voice: z.string().default('Charon'),
  /**
   * Optional with no default, so a round recorded before styles existed
   * re-parses to exactly the options it was stored with — `test:replay`
   * compares them byte for byte. Absent means `general`.
   */
  style: z.enum(INTERVIEW_STYLES).optional(),
});
export type SessionOptions = z.infer<typeof sessionOptionsSchema>;

/**
 * A retry of one moment from a finished round. Only the reference travels: the
 * server rebuilds the drill's config, focus and "before" from the source
 * round's report, so the browser cannot start a drill on anything the report
 * did not say.
 */
export const drillRefSchema = z.object({
  sessionId: z.string().uuid(),
  momentId: z.string().min(1).max(80),
});
export type DrillRef = z.infer<typeof drillRefSchema>;

export const startSessionSchema = z.object({
  config: interviewConfigSchema,
  options: sessionOptionsSchema.prefault({}),
  drill: drillRefSchema.optional(),
  /** An onsite loop this round is the next stage of. Validated server-side. */
  loopId: z.string().uuid().optional(),
});
export type StartSessionInput = z.infer<typeof startSessionSchema>;
