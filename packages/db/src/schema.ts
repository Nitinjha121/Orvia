import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  EVALUATION_STATUSES,
  QUESTION_OUTCOMES,
  SESSION_STATUSES,
  VERDICTS,
  type InterviewMode,
} from '@orvia/shared';

/* ── enums ─────────────────────────────────────────────────────────────────── */

/**
 * The live databases hold `interview_mode` in the order the modes were ADDED,
 * not `INTERVIEW_MODES`' tab order, and Postgres enums are ordered — so pushing
 * the shared tuple would be a type rebuild, not a no-op. The order is kept
 * here; the set is pinned to the shared one at compile time, both ways.
 */
const INTERVIEW_MODES_DB_ORDER = [
  'dsa',
  'jd',
  'experience',
  'system_design',
  'concepts',
  'behavioural',
  'hr',
] as const satisfies readonly InterviewMode[];
const _everyModeHasAnEnumValue: [Exclude<InterviewMode, (typeof INTERVIEW_MODES_DB_ORDER)[number]>] extends [never]
  ? true
  : never = true;

export const interviewModeEnum = pgEnum('interview_mode', INTERVIEW_MODES_DB_ORDER);

export const sessionStatusEnum = pgEnum('session_status', SESSION_STATUSES);

export const speakerEnum = pgEnum('speaker', ['ai', 'user']);

export const verdictEnum = pgEnum('verdict', VERDICTS);

export const evalStatusEnum = pgEnum('eval_status', EVALUATION_STATUSES);

/**
 * Whether an ASSIGNED problem was solved. Four values, not a boolean:
 * `not_reached` has to be distinguishable from `unsolved`, or a three-question
 * round where the candidate only ever heard problem one retires all three.
 */
export const questionOutcomeEnum = pgEnum('question_outcome', QUESTION_OUTCOMES);


/* ── accounts ──────────────────────────────────────────────────────────────── */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** argon2id. Never bcrypt — passwords protect user history and recordings. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_uniq').on(t.email)],
);

/**
 * The whole point of accounts here: type your experience once, and every
 * future experience-based round is ready without pasting anything again.
 */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Free-form projects, responsibilities, achievements — the probe material. */
  experience: text('experience').notNull().default(''),
  /** Resume text, kept separate so it can be re-pasted without losing the above. */
  resume: text('resume').notNull().default(''),
  targetRole: text('target_role'),
  yearsExperience: real('years_experience'),

  /** Session defaults so the setup screen is one click. */
  defaultVoice: text('default_voice').notNull().default('Charon'),
  defaultDurationMinutes: integer('default_duration_minutes').notNull().default(30),
  defaultDifficulty: text('default_difficulty').notNull().default('standard'),
  defaultPersona: text('default_persona').notNull().default('neutral'),
  /** Tuned per person — the single most taste-dependent setting in the app. */
  silenceDurationMs: integer('silence_duration_ms').notNull().default(1400),
  /**
   * How much sustained sound counts as you starting to speak. Raising it stops
   * a cough, a keystroke or a breath from triggering barge-in and cutting the
   * interviewer off mid-sentence.
   */
  prefixPaddingMs: integer('prefix_padding_ms').notNull().default(600),
  preferredLanguage: text('preferred_language').notNull().default('python'),

  /**
   * The interview being prepared for. `targetDate` is a calendar day
   * (`YYYY-MM-DD`) in the reader's own zone, for the reason `feed_events.day_key`
   * is: the countdown answers "how many days", and a UTC day is the wrong one
   * for half the evening.
   */
  targetCompany: text('target_company'),
  targetDate: text('target_date'),
  /** Rounds per week the plan spreads across `targetModes`. */
  weeklyRounds: integer('weekly_rounds').notNull().default(4),
  /** `InterviewMode[]`. Empty means the plan's defaults. */
  targetModes: jsonb('target_modes').notNull().default([]),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Saved JDs, so a role you are actively interviewing for is one click away. */
export const jobDescriptions = pgTable(
  'job_descriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    company: text('company'),
    content: text('content').notNull(),
    /** Cached structured brief from the extractor, so parsing happens once. */
    brief: jsonb('brief'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_descriptions_user_idx').on(t.userId, t.createdAt)],
);

/* ── onsite loops ──────────────────────────────────────────────────────────── */

/**
 * Several rounds meant to be run back to back, judged together.
 *
 * Only the PLAN is stored. Which round filled each stage is read back from
 * `sessions.loop_id` / `loop_stage`, and the combined decision is derived from
 * those rounds' latest reports by `loopDecision` in `@orvia/shared` — a stored
 * verdict would go stale the moment a stage's report was re-run.
 */
export const loops = pgTable(
  'loops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** One of `LOOP_TEMPLATES`, kept for the label. */
    template: text('template').notNull(),
    /** `LoopStage[]`, copied from the template so editing a template never rewrites a loop. */
    stages: jsonb('stages').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
  },
  (t) => [index('loops_user_started_idx').on(t.userId, t.startedAt)],
);

/* ── the interview session ─────────────────────────────────────────────────── */

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: interviewModeEnum('mode').notNull(),
    status: sessionStatusEnum('status').notNull().default('live'),

    /** The validated `InterviewConfig` discriminated union. */
    config: jsonb('config').notNull(),
    /** The validated `SessionOptions`. */
    options: jsonb('options').notNull(),

    /** Pinned so an old session stays interpretable after a model rotation. */
    model: text('model').notNull(),
    voice: text('voice').notNull(),

    /** Verbatim system instruction sent to the interviewer, for reproducibility. */
    systemInstruction: text('system_instruction'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    /**
     * ABSOLUTE path to the candidate-only recording: `RecordingService`
     * resolves against the API package root and stores what it resolved.
     * Every reader takes it verbatim, and rewriting stored paths risks the one
     * artefact in this schema that cannot be regenerated.
     */
    audioPath: text('audio_path'),
    /**
     * The interviewer's voice, recorded separately.
     *
     * Kept apart from `audioPath` on purpose: the evaluator and the coach must
     * receive the candidate ALONE, because every delivery score is a claim
     * about how the candidate sounded. This track exists so a round can be
     * played back as the conversation it was.
     */
    aiAudioPath: text('ai_audio_path'),
    /**
     * When both tracks were archived to R2 and their local WAVs removed.
     * Paths retain original basenames so `ArchiveService.ensureLocal` can
     * restore them on demand without path rewriting.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Bytes this session occupies in R2, both tracks together. Summed at boot
     * to seed the free-tier budget without listing the bucket.
     */
    archiveBytes: integer('archive_bytes'),
    /** Last Live API session-resumption handle, for surviving a reconnect. */
    resumptionHandle: text('resumption_handle'),
    /**
     * Interviewer speaking time, accumulated from the output audio bytes we
     * forwarded. The fallback for the talk ratio when `aiAudioPath` is absent,
     * as it is on rounds recorded before that track existed.
     */
    aiSpeakingMs: integer('ai_speaking_ms').notNull().default(0),

    endReason: text('end_reason'),
    /**
     * Final editor contents. Denormalised from context_snapshots so the report
     * can show what you actually wrote next to a model solution without
     * replaying the whole snapshot history.
     */
    finalCode: text('final_code'),
    codeLanguage: text('code_language'),
    /**
     * Editor contents per question, keyed by `dsa_questions.id`.
     * Preserves per-problem code for multi-question rounds, while `finalCode`
     * retains the most recent buffer for compatibility and unkeyed rounds.
     */
    questionCode: jsonb('question_code'),
    /**
     * Which of `config.questionIds` the round is on, by index.
     * Tracked server-side so the interviewer, editor, persisted code, and
     * report remain synchronized on the active problem.
     */
    currentQuestionIdx: integer('current_question_idx').notNull().default(0),
    /**
     * Every stretch the interviewer spent unresponsive, and what was done
     * about it: `{ atMs, forMs, rungs, action, recovered }`.
     * Records stalls as concrete data for diagnostics and evaluations rather
     * than inferring them from candidate queries.
     */
    interviewerStalls: jsonb('interviewer_stalls'),
    guardEvents: jsonb('guard_events'),
    /**
     * Upstream Live socket events: close codes, handover warnings, renewals,
     * failovers, and context size at decision time (`UpstreamEvent`).
     * Null on older rounds.
     */
    upstreamEvents: jsonb('upstream_events'),
    /**
     * Total of those stretches. Excluded from the round's BUDGET — a candidate
     * does not spend their forty minutes waiting for a dead model — while
     * `duration_ms`, the recording and every turn offset stay wall-clock.
     */
    deadMs: integer('dead_ms').notNull().default(0),
    /**
     * `round` or `drill`. A drill retries one moment of a finished round after
     * its report — and its model answer — has been read, so it is kept out of
     * every trend, the practice rotation and the feed's signals: its score
     * measures the fix, not the candidate cold. Filtered on, so a column
     * rather than a key inside `drill`.
     */
    kind: text('kind').notNull().default('round'),
    /** `DrillRecord`: the moment retried and its "before". Null on a round. */
    drill: jsonb('drill'),
    /**
     * `FocusItem[]` the round carried — open commitments, or a drill's
     * weaknesses — snapshotted at start so a re-evaluation checks the list
     * the candidate actually saw.
     */
    focus: jsonb('focus'),
    loopId: uuid('loop_id').references(() => loops.id, { onDelete: 'set null' }),
    loopStage: integer('loop_stage'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_user_started_idx').on(t.userId, t.startedAt),
    index('sessions_mode_status_idx').on(t.mode, t.status),
    index('sessions_loop_idx').on(t.loopId),
  ],
);

/**
 * One row per conversational turn, captured live. This is the structural
 * backbone the evaluator walks; the verbatim transcript is layered on top.
 */
export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    /** Monotonic ordering within the session. */
    idx: integer('idx').notNull(),
    speaker: speakerEnum('speaker').notNull(),

    /** Live API transcript — meaning-optimised, fillers stripped. */
    text: text('text').notNull(),

    /** ms offsets from session start. */
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms'),

    /** True when the model cut itself off because the candidate barged in. */
    interrupted: boolean('interrupted').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('turns_session_idx_uniq').on(t.sessionId, t.idx)],
);

/**
 * Out-of-band context the candidate produced by typing rather than speaking
 * (code editor in DSA mode, scratchpad in system design). Snapshotted so the
 * evaluator can see what was on screen when a question was answered.
 */
export const contextSnapshots = pgTable(
  'context_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    atMs: integer('at_ms').notNull(),
  },
  (t) => [index('context_snapshots_session_idx').on(t.sessionId, t.atMs)],
);

/**
 * Post-session verbatim transcript from `MODELS.transcriber`. Kept separate
 * from `turns` because it is a different artefact: filler-preserving, and the
 * raw material for delivery analysis.
 */
export const verbatimTranscripts = pgTable('verbatim_transcripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' })
    .unique(),
  model: text('model').notNull(),
  fullText: text('full_text').notNull(),
  /** Always `[]`: word timestamps return zero word objects on live models. */
  words: jsonb('words').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * "Say it better" rewrites, one row per round, replaced on regenerate. `items`
 * snapshots what was said beside each rewrite (`RephraseItem[]`). Status is
 * text, not an enum: `writing` past `REPHRASE_STALE_MS` reads as failed, so a
 * process that died mid-call leaves nothing unfinishable.
 */
export const turnRewrites = pgTable('turn_rewrites', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' })
    .unique(),
  status: text('status').notNull(),
  model: text('model'),
  items: jsonb('items').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/* ── evaluation ────────────────────────────────────────────────────────────── */

export const evaluations = pgTable(
  'evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    status: evalStatusEnum('status').notNull().default('pending'),
    model: text('model').notNull(),
    /** Which provider produced this. Only 'gemini' is implemented. */
    provider: text('provider').notNull().default('gemini'),
    /**
     * Whether the evaluator LISTENED to the recording or only read a transcript.
     * A transcript-only report's delivery scores carry less weight, and the
     * report must say so rather than implying it heard.
     */
    audioAnalysed: boolean('audio_analysed').notNull().default(false),
    /** The model behind the verbatim transcript the evaluator read. */
    transcriptSource: text('transcript_source'),
    /** Bump when the rubric changes so old scores are not silently compared. */
    rubricVersion: text('rubric_version').notNull(),

    /** 0-100. */
    overallScore: real('overall_score'),
    overallVerdict: verdictEnum('overall_verdict'),
    summary: text('summary'),
    /** Ranked, actionable — the three things to fix before the next session. */
    topFixes: jsonb('top_fixes'),

    /** Full structured payload as returned by the evaluator. */
    raw: jsonb('raw'),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('evaluations_session_created_idx').on(t.sessionId, t.createdAt)],
);

/** Per-question report card rows. */
export const questionEvaluations = pgTable(
  'question_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),

    idx: integer('idx').notNull(),
    /** Turn that carried the question, for jump-to-audio in the UI. */
    questionTurnId: uuid('question_turn_id').references(() => turns.id, { onDelete: 'set null' }),

    question: text('question').notNull(),
    myAnswer: text('my_answer').notNull(),
    idealAnswer: text('ideal_answer').notNull(),

    whatWasGood: jsonb('what_was_good').notNull(),
    whatWasMissing: jsonb('what_was_missing').notNull(),
    howToImprove: text('how_to_improve').notNull(),
    /** Working reference implementation, shown beside the candidate's own code. */
    modelSolution: text('model_solution'),
    modelSolutionLanguage: text('model_solution_language'),

    /**
     * `ComplexityAxis[]` — claimed vs actual vs optimal per axis (time, space, etc.).
     * Stored as JSONB to allow flexible axes without schema migrations, defaulting
     * to empty array for backwards compatibility.
     */
    complexity: jsonb('complexity').notNull().default([]),

    /** 0-10. */
    score: real('score').notNull(),
    verdict: verdictEnum('verdict').notNull(),

    /** ms offsets so the report can replay just this exchange. */
    startMs: integer('start_ms'),
    endMs: integer('end_ms'),
  },
  (t) => [
    uniqueIndex('question_evals_eval_idx_uniq').on(t.evaluationId, t.idx),
    // SET NULL has to find the referencing rows when a turn is deleted.
    index('question_evals_turn_idx').on(t.questionTurnId),
  ],
);

/**
 * Tracks whether the candidate solved each assigned problem, keyed to `dsa_questions`
 * for the no-repeat rotation. Keyed to `evaluations` rather than `sessions` so re-evaluations
 * can update judgements; queries read the latest evaluation for each session.
 */
export const questionOutcomes = pgTable(
  'question_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),
    /**
     * `dsa_questions.id`. No foreign key: a bank re-ingest that drops a slug
     * must not silently delete the evidence that you solved it, and the title
     * is resolved by lookup with a fallback to the slug anyway.
     */
    questionId: text('question_id').notNull(),
    /** Position in the round, so "problem two" means the same thing everywhere. */
    idx: integer('idx').notNull(),

    outcome: questionOutcomeEnum('outcome').notNull(),
    /** One sentence: why this outcome and not the neighbouring one. */
    reason: text('reason').notNull(),
    /**
     * The candidate's own words that decided it. Null for `not_reached`, where
     * by definition they said nothing. Kept because this field removes a
     * problem from someone's practice rotation, and a claim that consequential
     * has to be auditable.
     */
    evidenceQuote: text('evidence_quote'),
  },
  (t) => [
    uniqueIndex('question_outcomes_eval_question_uniq').on(t.evaluationId, t.questionId),
    index('question_outcomes_question_idx').on(t.questionId),
  ],
);

/**
 * The communication/presence dimensions — the part the user actually wants.
 * One row per dimension per evaluation, each REQUIRING an evidence quote so
 * scores are auditable rather than vibes.
 */
export const deliveryScores = pgTable(
  'delivery_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),

    /** e.g. 'confidence', 'nervousness', 'rambling', 'structure', 'listening'. */
    dimension: text('dimension').notNull(),
    /** 1-5 against a fixed anchored rubric. */
    score: real('score').notNull(),
    assessment: text('assessment').notNull(),
    /** Verbatim quote from the transcript backing the score. Non-negotiable. */
    evidenceQuote: text('evidence_quote'),
    evidenceAtMs: integer('evidence_at_ms'),
  },
  (t) => [uniqueIndex('delivery_scores_eval_dim_uniq').on(t.evaluationId, t.dimension)],
);

/* ── commitments ───────────────────────────────────────────────────────────── */

/**
 * A fix the candidate chose to carry into their next rounds.
 *
 * Stored because choosing it is a USER action no report records. Whether it has
 * been met is not stored: it is derived from `focus_checks` by
 * `commitmentProgress`, so a re-run report can move it and nothing goes stale.
 * Only dropping it is written down.
 */
export const commitments = pgTable(
  'commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** The round whose report suggested it, when it came from one. */
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    droppedAt: timestamp('dropped_at', { withTimezone: true }),
  },
  (t) => [index('commitments_user_idx').on(t.userId, t.createdAt)],
);

/**
 * The evaluator's verdict on each focus item a round carried.
 *
 * Hangs off `evaluations`, like `question_outcomes`, because it is a model
 * judgement a re-run must be able to change. `key` is a commitment id or a
 * drill focus key; no foreign key, so dropping a commitment never deletes the
 * evidence that it was once met.
 */
export const focusChecks = pgTable(
  'focus_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** The item as the round carried it, so the check reads without a join. */
    text: text('text').notNull(),
    source: text('source').notNull(),
    /** One of `FOCUS_RESULTS`. */
    result: text('result').notNull(),
    evidenceQuote: text('evidence_quote'),
    note: text('note').notNull(),
  },
  (t) => [
    uniqueIndex('focus_checks_eval_key_uniq').on(t.evaluationId, t.key),
    index('focus_checks_key_idx').on(t.key),
  ],
);

/**
 * Deterministic, model-free measurements computed from the verbatim transcript
 * and audio timings. These are the honest trend line — unlike LLM scores they
 * are stable across model versions and rubric changes.
 */
export const speechMetrics = pgTable('speech_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' })
    .unique(),

  totalSpeakingMs: integer('total_speaking_ms'),
  wordCount: integer('word_count').notNull(),
  wordsPerMinute: real('words_per_minute'),

  fillerCount: integer('filler_count').notNull(),
  /** Fillers per 100 words — comparable across sessions of different lengths. */
  fillerRate: real('filler_rate').notNull(),
  fillerBreakdown: jsonb('filler_breakdown').notNull(),

  /** Median ms between the AI finishing and the candidate starting. */
  medianResponseLatencyMs: integer('median_response_latency_ms'),
  longestSilenceMs: integer('longest_silence_ms'),
  /** Candidate speaking time / total speaking time. */
  talkRatio: real('talk_ratio'),
  /** Mean words per candidate turn — a proxy for verbosity. */
  meanTurnWords: real('mean_turn_words').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ── what the mentor remembers ─────────────────────────────────────────────── */

/**
 * Notes the mentor has learned from conversation (goals, patterns, preferences,
 * and context) that cannot be derived from scores alone. Stored as free text.
 */
export const mentorMemories = pgTable(
  'mentor_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Coarse bucket (goal, pattern, preference, context) for prompt grouping.
     * Stored as text rather than an enum so adding buckets requires no migration.
     */
    kind: text('kind').notNull().default('pattern'),
    content: text('content').notNull(),

    /** The round that prompted it, so a claim can be traced to its evidence. */
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),

    /**
     * Bumped when the same thing is observed again instead of writing a second
     * near-identical row. This is what lets the mentor say "this is the fourth
     * round in a row" rather than repeating itself as if it were new.
     */
    timesObserved: integer('times_observed').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mentor_memories_user_idx').on(t.userId, t.updatedAt),
    index('mentor_memories_source_session_idx').on(t.sourceSessionId),
  ],
);

/**
 * Persisted coach or mentor transcripts (text only, no audio).
 * Queried on demand via tools rather than automatically loaded into the prompt context.
 */
export const coachConversations = pgTable(
  'coach_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** 'session' — one round with the coach. 'account' — the mentor. */
    scope: text('scope').notNull(),

    /**
     * The round a session-scoped conversation was about. Null for the mentor,
     * which is not about any one round, and nulled rather than cascaded if the
     * round is deleted — what was said still happened.
     */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    /** Denormalised so the index does not have to count rows to be useful. */
    messageCount: integer('message_count').notNull().default(0),
    /** Wall-clock length, excluding nothing — the client clock pauses, this does not. */
    durationMs: integer('duration_ms').notNull().default(0),
    /** `sessions.upstream_events`, for the coach and the mentor. */
    upstreamEvents: jsonb('upstream_events'),
  },
  (t) => [
    index('coach_conversations_user_idx').on(t.userId, t.startedAt),
    index('coach_conversations_session_idx').on(t.sessionId),
  ],
);

export const coachMessages = pgTable(
  'coach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => coachConversations.id, { onDelete: 'cascade' }),

    /** Monotonic ordering within the conversation. */
    idx: integer('idx').notNull(),
    speaker: speakerEnum('speaker').notNull(),
    text: text('text').notNull(),
    /** ms offset from the start of the conversation. */
    atMs: integer('at_ms').notNull().default(0),
  },
  (t) => [uniqueIndex('coach_messages_conversation_idx_uniq').on(t.conversationId, t.idx)],
);

/* ── question bank ─────────────────────────────────────────────────────────── */

export const dsaQuestions = pgTable(
  'dsa_questions',
  {
    /** LeetCode title slug — stable, human-readable, and dedupes across lists. */
    id: text('id').primaryKey(),
    leetcodeId: text('leetcode_id'),
    url: text('url'),

    title: text('title').notNull(),
    difficulty: text('difficulty').notNull(),
    topics: jsonb('topics').notNull(),

    /**
     * Written to be READ ALOUD: one short paragraph, no markdown, no code, no
     * example tables. A LeetCode-style statement with I/O examples sounds
     * absurd spoken and burns the round's clock.
     */
    prompt: text('prompt').notNull(),

    /**
     * Starter skeletons, keyed by our editor language id.
     * Sourced to compile and run against online judges: LeetCode signatures for
     * free problems, or LintCode signatures when practiceUrl points there.
     */
    codeSnippets: jsonb('code_snippets'),

    /**
     * Where to run the starter skeleton above when different from LeetCode.
     * Provided for problems whose code signatures require an alternative judge.
     */
    practiceUrl: text('practice_url'),

    /** Given ONLY to the evaluator — never the interviewer, never the candidate. */
    referenceSolution: text('reference_solution'),
    optimalComplexity: text('optimal_complexity'),
    /** What a strong candidate is expected to surface unprompted. */
    keyInsights: jsonb('key_insights'),

    /** True when the statement was reconstructed without LeetCode's own text. */
    fromTitleOnly: boolean('from_title_only').notNull().default(false),

    /**
     * LeetCode's "Constraints:" lines, in its own notation (`10^4`), for the
     * INTERVIEWER to answer "what's the input size?" from. `prompt` drops them
     * because they cannot be read aloud as part of the statement, and with
     * nothing to answer from the interviewer invented ranges. Public on
     * LeetCode, so not an answer key. Null for paid-only problems.
     */
    constraints: jsonb('constraints'),
  },
  (t) => [index('dsa_questions_difficulty_idx').on(t.difficulty)],
);

/**
 * Curated question lists, as DATA rather than code — adding "Top Meta
 * Questions" or "Blind 75" later is a row here plus one entry in the ingest
 * script, with no schema change and no redeploy of the UI.
 */
export const collections = pgTable('collections', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  blurb: text('blurb').notNull(),
  /** Where the list came from, so it can be refreshed later. */
  sourceType: text('source_type').notNull().default('leetcode-list'),
  sourceRef: text('source_ref'),
  orderIdx: integer('order_idx').notNull().default(0),
});

/**
 * Join table rather than a column on the question: the curated lists overlap
 * (a problem can be in NeetCode 150 AND the Google list), so each problem is
 * stored ONCE and linked to as many collections as it belongs to. Each link
 * keeps that list's own ordering.
 */
export const questionCollections = pgTable(
  'question_collections',
  {
    collection: text('collection')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => dsaQuestions.id, { onDelete: 'cascade' }),
    /** Position within that list, so the UI can show it in the curated order. */
    orderIdx: integer('order_idx').notNull(),
  },
  (t) => [
    uniqueIndex('question_collections_uniq').on(t.collection, t.questionId),
    index('question_collections_order_idx').on(t.collection, t.orderIdx),
  ],
);

export const systemDesignProblems = pgTable('system_design_problems', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  level: text('level').notNull(),
  prompt: text('prompt').notNull(),
  /** Phase-by-phase expectations, used by the evaluator to score each phase. */
  rubricNotes: jsonb('rubric_notes'),
  orderIdx: integer('order_idx').notNull().default(0),
});

/* ── the spoken rounds: concepts, behavioural, HR ──────────────────────────── */

/**
 * A technology or discipline for concepts rounds (Node, React, Kafka, etc.).
 * Stored as browsable topics so new topics and questions can be added without
 * schema or UI changes.
 */
export const conceptTopics = pgTable('concept_topics', {
  /** Stable slug: 'nodejs', 'react', 'kafka', 'distributed-systems'. */
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  blurb: text('blurb').notNull(),
  orderIdx: integer('order_idx').notNull().default(0),
});

/**
 * One conceptual question, and what a strong spoken answer to it contains.
 *
 * Unlike `dsa_questions` there is no upstream to ingest from, so these are
 * curated in-repo and seeded from the committed bank. One topic per question,
 * not a join table: a question about React's reconciler belongs to React, and
 * the overlap that made `question_collections` necessary does not exist here.
 */
export const conceptQuestions = pgTable(
  'concept_questions',
  {
    /** Slug, prefixed by topic so it reads as an id: 'nodejs-event-loop-phases'. */
    id: text('id').primaryKey(),
    topic: text('topic')
      .notNull()
      .references(() => conceptTopics.id, { onDelete: 'cascade' }),

    /** Short label for the picker. The prompt below is what is read aloud. */
    title: text('title').notNull(),
    difficulty: text('difficulty').notNull(),

    /**
     * Written to be READ ALOUD — one or two spoken sentences, no markdown, no
     * code, numbers as words. Same rule as `dsa_questions.prompt`, and for the
     * same reason: an interviewer reading a bulleted list out loud is absurd.
     */
    prompt: text('prompt').notNull(),

    /**
     * Follow-up angles, in escalating depth. Given to the INTERVIEWER — these
     * are questions, never answers, so handing them over does not breach the
     * rule that the interviewer must not know what a good answer looks like.
     */
    probes: jsonb('probes').notNull(),

    /** Given ONLY to the evaluator — never the interviewer, never the candidate. */
    expectedPoints: jsonb('expected_points').notNull(),
    /** The wrong answers people give confidently. Evaluator-only. */
    commonMistakes: jsonb('common_mistakes').notNull().default([]),

    orderIdx: integer('order_idx').notNull().default(0),
  },
  (t) => [index('concept_questions_topic_idx').on(t.topic, t.orderIdx)],
);

/** The competency a behavioural question tests — conflict, ownership, failure. */
export const behaviouralCompetencies = pgTable('behavioural_competencies', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  blurb: text('blurb').notNull(),
  orderIdx: integer('order_idx').notNull().default(0),
});

/**
 * A competency question, answered from the candidate's own history.
 *
 * `strongAnswer` is evaluator-only and describes the SHAPE of a good answer —
 * a specific situation, their own actions rather than the team's, a decision
 * with a reason, a measurable outcome. It cannot describe the content, because
 * the content is the candidate's life and the model does not know it.
 */
export const behaviouralQuestions = pgTable(
  'behavioural_questions',
  {
    id: text('id').primaryKey(),
    competency: text('competency')
      .notNull()
      .references(() => behaviouralCompetencies.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    /** Read aloud. */
    prompt: text('prompt').notNull(),
    /** Interviewer-facing follow-ups that push for specifics. */
    probes: jsonb('probes').notNull(),
    /** Evaluator-only: what a strong answer to THIS question contains. */
    strongAnswer: jsonb('strong_answer').notNull(),

    orderIdx: integer('order_idx').notNull().default(0),
  },
  (t) => [index('behavioural_questions_competency_idx').on(t.competency, t.orderIdx)],
);

/**
 * An HR / negotiation round, stored as a scenario with sequential beats
 * where subsequent prompts depend on earlier responses.
 */
/* ── the learning feed ─────────────────────────────────────────────────────── */

/**
 * The teaching bank for the feed. Kept in a dedicated table so answers and
 * explanations can be displayed to learners without exposing interview question keys.
 * Seeded from `scripts/data/learning-cards.mts`.
 */
export const learningCards = pgTable(
  'learning_cards',
  {
    /** Slug from the file. Also the review key's suffix — renaming forgets. */
    id: text('id').primaryKey(),
    /** 'lesson' | 'pattern' | 'quiz'. Not an enum: adding a kind is content work. */
    kind: text('kind').notNull(),
    /** An `InterviewMode`, or 'general' for material that belongs to no round. */
    track: text('track').notNull(),

    title: text('title').notNull(),
    /**
     * Written to be READ, which is the exact inverse of every `prompt` column
     * above — those are spoken aloud by the interviewer and forbid markup, code
     * and lists. Blank lines separate paragraphs here and a code block is
     * normal. Do not carry either rule across.
     */
    body: text('body').notNull(),
    takeaway: text('takeaway').notNull(),

    code: text('code'),
    codeLanguage: text('code_language'),

    /**
     * Matched against the topics your own rounds went badly on. LeetCode's own
     * topic names where one exists, because `dsa_questions.topics` is the other
     * side of that match.
     */
    tags: jsonb('tags').notNull().default([]),
    difficulty: text('difficulty').notNull().default('medium'),

    /** quiz only: the options, the index of the right one, and why. */
    choices: jsonb('choices'),
    answerIdx: integer('answer_idx'),
    explanation: text('explanation'),

    orderIdx: integer('order_idx').notNull().default(0),
  },
  (t) => [index('learning_cards_track_idx').on(t.track, t.orderIdx)],
);

/**
 * User progress on a learning card. Keyed by string `card_key` across all feed
 * sources (lessons, problem recalls, and report fixes) so review intervals and
 * bookmarks share a single space without foreign-key cascade deletions.
 */
export const feedCardState = pgTable(
  'feed_card_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. `lesson:sliding-window-variable`, `recall:dsa:two-sum`. */
    cardKey: text('card_key').notNull(),

    timesSeen: integer('times_seen').notNull().default(0),
    /** 0 to `MAX_STRENGTH` in `@orvia/shared`. Only a rating moves it. */
    strength: integer('strength').notNull().default(0),
    /**
     * When it may appear again. Null means never rated and never scrolled past,
     * which is what makes a card eligible as NEW rather than as a review — the
     * two are different queues in the weave and must stay distinguishable.
     */
    dueAt: timestamp('due_at', { withTimezone: true }),
    saved: boolean('saved').notNull().default(false),
    /**
     * Saved card snapshot, preserved so derived cards (problem recalls and fixes)
     * remain viewable after their underlying trigger condition clears.
     */
    snapshot: jsonb('snapshot'),
    /** The last button pressed, so the card can render what you said about it. */
    lastAction: text('last_action'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('feed_card_state_user_card_uniq').on(t.userId, t.cardKey),
    /** The due-review query, which runs on every feed request. */
    index('feed_card_state_due_idx').on(t.userId, t.dueAt),
    index('feed_card_state_saved_idx').on(t.userId, t.saved),
  ],
);

/**
 * Append-only log of every feed rating.
 * `day_key` is the reader's local calendar date sent by the client,
 * ensuring daily streaks reflect the user's local day boundaries rather than UTC.
 */
export const feedEvents = pgTable(
  'feed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardKey: text('card_key').notNull(),
    /** One of `FEED_ACTIONS`. */
    action: text('action').notNull(),
    /** `YYYY-MM-DD`, the reader's own calendar day. See above. */
    dayKey: text('day_key').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('feed_events_user_day_idx').on(t.userId, t.dayKey)],
);

export const hrScenarios = pgTable('hr_scenarios', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  blurb: text('blurb').notNull(),
  /** 'recruiter_screen' | 'offer_negotiation' | 'counter_offer' | 'exit'. */
  stage: text('stage').notNull(),

  /** Who the candidate is talking to, in one line — read into the opening. */
  persona: text('persona').notNull(),

  /**
   * `{ beat, ask, pressure }[]`, in order. `ask` is what the interviewer puts
   * to the candidate; `pressure` is how it pushes if the candidate deflects.
   * jsonb rather than a table because a beat has no identity outside its
   * scenario and is never queried on its own.
   */
  beats: jsonb('beats').notNull(),

  /** Evaluator-only: what holding your ground actually looks like here. */
  rubricNotes: jsonb('rubric_notes').notNull().default([]),

  orderIdx: integer('order_idx').notNull().default(0),
});
