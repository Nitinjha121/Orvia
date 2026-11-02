import { z } from 'zod';
import { INTERVIEW_MODES } from './modes.js';

/**
 * Shared contracts and pure ordering rules for the learning feed.
 * The feed displays learning prompts and exercises without revealing full answer keys,
 * and feed bodies support formatted text and code blocks.
 */

/* ── the committed teaching bank ───────────────────────────────────────────── */

/**
 * Distinct card kinds for the teaching bank:
 * - `lesson`: concise conceptual explanation with a key takeaway.
 * - `pattern`: recognition drill pairing a cue with its corresponding technique.
 * - `quiz`: interactive question answered before the explanation unlocks.
 */
export const LEARNING_CARD_KINDS = ['lesson', 'pattern', 'quiz'] as const;
export type LearningCardKind = (typeof LEARNING_CARD_KINDS)[number];

/**
 * Which part of interviewing a card belongs to.
 *
 * The interview modes plus `general`, which is the material that is not about a
 * round at all — how to ask a clarifying question, what to do when you do not
 * know. That has nowhere to live in `INTERVIEW_MODES` and is some of the most
 * useful content here, so it gets a value rather than being forced into one.
 */
export const LEARNING_TRACKS = [...INTERVIEW_MODES, 'general'] as const;
export type LearningTrack = (typeof LEARNING_TRACKS)[number];

export const LEARNING_TRACK_LABELS: Record<LearningTrack, string> = {
  dsa: 'DSA',
  system_design: 'System design',
  concepts: 'Core concepts',
  jd: 'Role fit',
  experience: 'Your experience',
  behavioural: 'Behavioural',
  hr: 'HR & salary',
  general: 'Interview craft',
};

export const learningCardSchema = z
  .object({
    /** Stable slug. It is the review key, so renaming one forgets its history. */
    id: z
      .string()
      .min(3)
      .regex(/^[a-z0-9-]+$/, 'ids are lowercase slugs — they appear in review state'),
    kind: z.enum(LEARNING_CARD_KINDS),
    track: z.enum(LEARNING_TRACKS),

    /** Fits one phone line at the card's type size. Measured, not guessed. */
    title: z.string().min(3).max(72),

    /**
     * The teaching text. Blank lines separate paragraphs; nothing else is
     * markup. Capped because the card must not scroll on a phone — past this
     * it is two cards, and two cards is the better answer anyway.
     */
    body: z.string().min(20).max(1100),

    /** The one sentence to leave with. Pinned under the body, always visible. */
    takeaway: z.string().min(5).max(180),

    /** Shown in a mono block. Short enough to read without horizontal scroll. */
    code: z.string().max(900).optional(),
    codeLanguage: z.string().max(20).optional(),

    /**
     * Matched against the topics your own rounds went badly on, which is how
     * the feed personalises. Use LeetCode's topic names verbatim where one
     * exists (`dsa_questions.topics`), because that is what the match is
     * against — "Dynamic Programming", not "dp".
     */
    tags: z.array(z.string().min(1)).default([]),

    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),

    /* quiz only, enforced below */
    choices: z.array(z.string().min(1)).min(2).max(4).optional(),
    answerIdx: z.number().int().min(0).optional(),
    /** Why that answer, and why the tempting wrong one is wrong. */
    explanation: z.string().max(600).optional(),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['id'] });

    if (c.kind === 'quiz') {
      if (!c.choices) return fail(`${c.id}: a quiz needs choices`);
      if (c.answerIdx === undefined) return fail(`${c.id}: a quiz needs answerIdx`);
      if (c.answerIdx >= c.choices.length) {
        return fail(`${c.id}: answerIdx ${c.answerIdx} is past the last choice`);
      }
      if (!c.explanation) return fail(`${c.id}: a quiz needs an explanation`);
      // Two choices that read the same make the card unanswerable rather than
      // hard, and it is the typo you cannot see while writing the bank.
      const seen = new Set(c.choices.map((x) => x.trim().toLowerCase()));
      if (seen.size !== c.choices.length) return fail(`${c.id}: duplicate choices`);
    } else if (c.choices || c.answerIdx !== undefined) {
      fail(`${c.id}: only a quiz may carry choices`);
    }

    if (c.code && !c.codeLanguage) fail(`${c.id}: code without a language cannot be highlighted`);
  });

export type LearningCard = z.output<typeof learningCardSchema>;

/* ── what the feed hands the browser ───────────────────────────────────────── */

export const FEED_CARD_KINDS = [
  'lesson',
  'pattern',
  'quiz',
  'drill',
  'recall',
  'fix',
  'stat',
] as const;
export type FeedCardKind = (typeof FEED_CARD_KINDS)[number];

/**
 * Per-card state, so a card can say what you already did with it.
 *
 * Sent with every card rather than fetched separately: the whole feed is one
 * request on a phone connection, and a second round-trip to find out whether
 * the card in front of you is saved would arrive after you had scrolled past.
 */
export type FeedCardState = {
  timesSeen: number;
  saved: boolean;
  /** 0 (new or just relearned) to `MAX_STRENGTH`. */
  strength: number;
  /** ISO. Null for a card that has never been rated. */
  dueAt: string | null;
  /**
   * The last button pressed. Absent until something is pressed, which is what
   * lets the card confirm a RATING without also confirming a scroll-past.
   */
  lastAction?: FeedAction;
};

/**
 * One pre-generated audio clip, and the silence that follows it.
 *
 * A card becomes several clips only where its script contains a deliberate
 * pause — a quiz's thinking gap, a drill's minute to answer. Everything else is
 * one clip, because the pause is the only thing a single file cannot express.
 */
export type FeedAudioClip = { url: string; pauseAfterMs: number };

type FeedCardBase = {
  key: string;
  state: FeedCardState;
  /**
   * Pre-generated narration, when it exists for this card.
   *
   * Null for anything drawn from your own history — a fix quotes your report,
   * so there is nothing to generate in advance — and null before the cache has
   * been built. The client falls back to the browser's own speech synthesis,
   * which is why that path cannot be deleted.
   */
  audio?: FeedAudioClip[] | null;
};

/**
 * Generic shape for teaching bank cards, parameterized so discriminator
 * narrowing via `Extract<FeedCard, { kind: K }>` resolves correctly.
 */
type TeachingCardOf<K extends LearningCardKind> = FeedCardBase & {
  kind: K;
  card: LearningCard & { kind: K };
  /** Set when this card surfaced because a topic went badly for you. */
  becauseOf: string | null;
};

export type FeedTeachingCard =
  | TeachingCardOf<'lesson'>
  | TeachingCardOf<'pattern'>
  | TeachingCardOf<'quiz'>;

/**
 * A real bank question, put to you with no answer attached.
 *
 * The ask is deliberately "say it out loud for sixty seconds, then start the
 * round" rather than "here is the answer": the round is where the question is
 * actually worth something, and a feed that spends questions by showing their
 * keys would quietly empty the rotation the practice screen draws from.
 */
export type FeedDrillCard = FeedCardBase & {
  kind: 'drill';
  track: LearningTrack;
  questionId: string;
  title: string;
  prompt: string;
  difficulty: string | null;
  tags: string[];
  /** Starts a round on exactly this question. */
  practice: { mode: 'dsa' | 'concepts' | 'system_design' | 'behavioural'; questionId: string };
};

/**
 * A question your own latest round did NOT solve, offered again.
 *
 * Distinct from `drill` because the pitch is different and because the source
 * of truth is different: this one comes from `question_outcomes`, so it can
 * name what happened and when. Unfinished business, in the feed, where you will
 * actually see it.
 */
export type FeedRecallCard = FeedCardBase & {
  kind: 'recall';
  track: LearningTrack;
  questionId: string;
  title: string;
  prompt: string;
  outcome: 'partial' | 'unsolved';
  /** The evaluator's one-line reason, verbatim. */
  reason: string;
  lastAttemptedAt: string;
  sessionId: string;
  practice: { mode: 'dsa' | 'concepts' | 'system_design' | 'behavioural'; questionId: string };
};

/**
 * One thing your last report told you to fix, restated on its own screen.
 *
 * A report is read once and closed. The fixes in it are the part with a shelf
 * life of weeks, so they come back here between rounds rather than living only
 * at the bottom of a page nobody reopens.
 */
export type FeedFixCard = FeedCardBase & {
  kind: 'fix';
  sessionId: string;
  /** What the round was, so the advice has a setting. */
  mode: string;
  fix: string;
  /** Present when the fix came from a delivery dimension rather than topFixes. */
  dimension: string | null;
  score: number | null;
  evidenceQuote: string | null;
  at: string;
};

/**
 * Your own numbers, at the top of the feed and nowhere else.
 *
 * Exactly one, and only on the first page: a feed that keeps interrupting
 * itself to show you a scoreboard is the thing this feature was built to
 * replace. It is here because opening the app should answer "where am I" before
 * it asks for twenty minutes.
 */
export type FeedStatCard = FeedCardBase & {
  kind: 'stat';
  /** Cards rated today, against `DAILY_CARD_GOAL`. */
  todayCount: number;
  /** Consecutive days with at least one rated card, today included. */
  streak: number;
  /** Reviews that have come due. */
  dueCount: number;
  roundsThisWeek: number;
  /** Latest overall score and the one before it, for a direction. Null-safe. */
  latestScore: number | null;
  previousScore: number | null;
  /** The topics the boost is currently favouring, so the feed is legible. */
  weakTopics: string[];
};

export type FeedCard =
  | FeedTeachingCard
  | FeedDrillCard
  | FeedRecallCard
  | FeedFixCard
  | FeedStatCard;

export type FeedPage = {
  cards: FeedCard[];
  /** Pass back as `offset` for the next page. Null when the feed is exhausted. */
  nextOffset: number | null;
  meta: {
    todayCount: number;
    streak: number;
    dueCount: number;
    goal: number;
  };
};

/* ── interactions ──────────────────────────────────────────────────────────── */

/**
 * Feed interaction actions:
 * - `got_it` / `shaky`: rating actions that adjust card strength and count towards streaks.
 * - `seen` / `skip`: passive cooldown actions without affecting card strength.
 * - `save` / `unsave`: bookmarking toggles.
 */
export const FEED_ACTIONS = ['seen', 'got_it', 'shaky', 'skip', 'save', 'unsave'] as const;
export type FeedAction = (typeof FEED_ACTIONS)[number];

/** The actions that count as work done, for the day counter and the streak. */
export const RATING_ACTIONS: readonly FeedAction[] = ['got_it', 'shaky'];

export const feedInteractionSchema = z.object({
  /** `FeedCard.key`, opaque to the server beyond being the state's identity. */
  cardKey: z.string().min(1).max(200),
  action: z.enum(FEED_ACTIONS),
  /**
   * The reader's local calendar date (`YYYY-MM-DD`), sent by the client so streak
   * calculations respect the user's local timezone rather than server UTC.
   */
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  /**
   * The card snapshot as rendered, stored verbatim for saved items so dynamically
   * derived cards (recalls, fixes) remain viewable after underlying states change.
   */
  snapshot: z.unknown().optional(),
});
export type FeedInteraction = z.infer<typeof feedInteractionSchema>;

/* ── spaced repetition ─────────────────────────────────────────────────────── */

/**
 * Days until the next review, indexed by strength.
 *
 * Deliberately shorter than a flashcard app's ladder. The horizon here is an
 * interview loop measured in weeks, not retention measured in years, and a card
 * you will next see in six months is a card that was not worth writing.
 */
export const REVIEW_INTERVALS_DAYS = [1, 2, 4, 9, 18, 35] as const;
export const MAX_STRENGTH = REVIEW_INTERVALS_DAYS.length - 1;

const DAY_MS = 86_400_000;

/**
 * How soon a card you fumbled comes back.
 *
 * Inside one sitting, on purpose: the second look while the first is still in
 * your head is the one that sticks, and it costs a card's worth of scroll. Any
 * value over about twenty minutes makes it a different day's problem instead.
 */
export const RELEARN_MS = 10 * 60_000;

/** A card scrolled past unrated is quiet until tomorrow, not gone. */
export const SEEN_COOLDOWN_MS = 12 * 3_600_000;
/** `skip` is a stronger "not now" than scrolling past, and says so. */
export const SKIP_COOLDOWN_MS = 4 * DAY_MS;

/** Cards to rate in a day for the ring to close. About eight minutes. */
export const DAILY_CARD_GOAL = 12;

export type ReviewState = { strength: number; dueAt: Date | null };

/**
 * The next review, from the current state and what you just pressed.
 *
 * Pure and exported so `verify:feed` can walk a card through a fortnight of
 * ratings without a database. `save` and `unsave` return the state untouched:
 * bookmarking something is not a claim about whether you know it, and letting
 * it reset the ladder would make the save button quietly destructive.
 */
export function scheduleReview(state: ReviewState, action: FeedAction, now: Date): ReviewState {
  const at = (ms: number) => new Date(now.getTime() + ms);

  switch (action) {
    case 'got_it': {
      // Clamped on the way in as well as up: a strength read back from a row
      // written by an older ladder must not index past the end of this one.
      const from = Math.min(Math.max(state.strength, 0), MAX_STRENGTH);
      // The gap is bought by the rung you were ON, so the first correct answer
      // buys a day and a card already at the top buys five weeks again. Every
      // entry in the table is reachable, which is what makes the table the
      // whole specification of the ladder.
      return { strength: Math.min(from + 1, MAX_STRENGTH), dueAt: at(REVIEW_INTERVALS_DAYS[from]! * DAY_MS) };
    }
    case 'shaky':
      // All the way down, not one rung. A card you could not produce is not
      // three-quarters known, and the ladder only means anything if falling off
      // it costs something.
      return { strength: 0, dueAt: at(RELEARN_MS) };
    case 'skip':
      return { strength: state.strength, dueAt: at(SKIP_COOLDOWN_MS) };
    case 'seen':
      /**
       * Scrolling past does not alter an existing future schedule. Overdue items
       * receive the standard seen cooldown so unrated items are not immediately reserviced.
       */
      return {
        strength: state.strength,
        dueAt:
          state.dueAt && state.dueAt.getTime() > now.getTime()
            ? state.dueAt
            : at(SEEN_COOLDOWN_MS),
      };
    default:
      return state;
  }
}

/**
 * Formats a card's next scheduled review time as a human-readable interval.
 * Returns null if the card has no scheduled review.
 */
export function describeNextReview(dueAt: string | Date | null, now: Date): string | null {
  if (!dueAt) return null;
  const at = typeof dueAt === 'string' ? Date.parse(dueAt) : dueAt.getTime();
  if (Number.isNaN(at)) return null;

  const ms = at - now.getTime();
  if (ms <= 0) return 'now';
  if (ms < 90 * 60_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 20 * 3_600_000) return `in ${Math.round(ms / 3_600_000)} hours`;
  if (ms < 2 * DAY_MS) return 'tomorrow';

  const days = Math.round(ms / DAY_MS);
  if (days < 14) return `in ${days} days`;

  const weeks = Math.round(days / 7);
  return `in ${weeks} week${weeks === 1 ? '' : 's'}`;
}

/* ── listening to the feed ─────────────────────────────────────────────────── */

/** A thing to say, or a silence to leave. */
export type SpeechSegment = { say: string } | { pause: number };

/** How long the listener gets to answer a drill out loud before the feed moves on. */
export const DRILL_ANSWER_PAUSE_MS = 45_000;
/** The gap between a quiz's options and its answer. */
export const QUIZ_THINK_PAUSE_MS = 6_000;

/**
 * Transforms a card into a speakable script. Code blocks are replaced with
 * visual cues, text is formatted for natural synthesis, and quizzes insert
 * pauses before revealing answers.
 */
export function speakableCard(card: FeedCard): SpeechSegment[] {
  switch (card.kind) {
    case 'stat':
      return [
        {
          say:
            card.streak > 0
              ? `You are on a ${card.streak} day streak, with ${card.todayCount} cards done today.`
              : 'Nothing done today yet.',
        },
      ];

    case 'quiz': {
      const c = card.card;
      const options = (c.choices ?? []).map(
        (choice, i) => `Option ${ORDINALS[i] ?? String(i + 1)}. ${spoken(choice)}`,
      );
      const answer = c.choices?.[c.answerIdx ?? 0] ?? '';
      return [
        { say: `Quiz. ${spoken(c.title)}` },
        { say: spoken(c.body) },
        ...options.map((say) => ({ say })),
        { pause: QUIZ_THINK_PAUSE_MS },
        { say: `The answer is ${spoken(answer)}.` },
        { say: spoken(c.explanation ?? '') },
      ];
    }

    case 'drill':
    case 'recall':
      return [
        { say: `${card.kind === 'recall' ? 'Unfinished business.' : 'Your turn.'} ${spoken(card.title)}` },
        { say: spoken(card.prompt) },
        { say: 'Answer it out loud. Sixty seconds.' },
        { pause: DRILL_ANSWER_PAUSE_MS },
      ];

    case 'fix':
      return [
        { say: 'From your own report.' },
        { say: spoken(card.fix) },
        ...(card.evidenceQuote ? [{ say: `You said: ${spoken(card.evidenceQuote)}` }] : []),
      ];

    default: {
      const c = card.card;
      return [
        { say: spoken(c.title) },
        ...splitParagraphs(c.body).map((say) => ({ say })),
        ...(c.code ? [{ say: 'There is a code example on screen.' }] : []),
        { say: `Remember: ${spoken(c.takeaway)}` },
      ];
    }
  }
}

const ORDINALS = ['one', 'two', 'three', 'four'];

/**
 * Collapse a script into the units that can each be ONE audio file: runs of
 * speech, separated by the pauses between them.
 *
 * Shared by the generator and the player so a card's clips and its silences
 * cannot drift apart — the generator writes N files, the player expects N files
 * and knows how long to wait after each.
 */
export function speechGroups(segments: readonly SpeechSegment[]): { text: string; pauseAfterMs: number }[] {
  const groups: { text: string; pauseAfterMs: number }[] = [];
  let spoken: string[] = [];

  for (const segment of segments) {
    if ('say' in segment) {
      if (segment.say.trim()) spoken.push(segment.say.trim());
      continue;
    }
    // A pause with nothing before it would produce an empty clip; carry it onto
    // the previous group instead, which is what "wait after that" means.
    if (spoken.length) {
      groups.push({ text: spoken.join(' '), pauseAfterMs: segment.pause });
      spoken = [];
    } else if (groups.length) {
      groups[groups.length - 1]!.pauseAfterMs += segment.pause;
    }
  }

  if (spoken.length) groups.push({ text: spoken.join(' '), pauseAfterMs: 0 });
  return groups;
}

/** Paragraphs become separate utterances so a pause lands where the writing meant one. */
function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((p) => spoken(p))
    .filter(Boolean);
}

/**
 * Known acronyms pronounced as individual letters by speech synthesizers.
 * Other capitalized words are lowercased to avoid harsh synthesis emphasis.
 */
const SPOKEN_ACRONYMS = new Set([
  'ABAC', 'ACID', 'ANN', 'AOF', 'API', 'AWS', 'BM25', 'CAP', 'CDN', 'CORS', 'CPU', 'CRUD',
  'CSRF', 'DNS', 'DSU', 'FIFO', 'GPU', 'HLS', 'HNSW', 'HTTP', 'HTTPS', 'IVS', 'JSON', 'JWT',
  'LFU', 'LRU', 'MVCC', 'OIDC', 'OOM', 'PKCE', 'RAG', 'RAM', 'RBAC', 'RDB', 'REST', 'SIGKILL',
  'SIGTERM', 'SNS', 'SQL', 'SQS', 'SSD', 'SSE', 'SSO', 'STAR', 'TCP', 'TLS', 'TTL', 'UDP',
  'XSS', 'YAML',
]);

/** Written forms that read badly, and what to say instead. */
const SPOKEN_REPLACEMENTS: [RegExp, string][] = [
  [/\bp50\b/g, 'p fifty'],
  [/\bp90\b/g, 'p ninety'],
  [/\bp95\b/g, 'p ninety five'],
  [/\bp99\b/g, 'p ninety nine'],
  [/\bvs\.?\b/gi, 'versus'],
  [/\bN\+1\b/g, 'N plus one'],
  [/\be\.g\.\s*/gi, 'for example, '],
  [/\bi\.e\.\s*/gi, 'that is, '],
];

/**
 * Normalizes text for speech synthesis, expanding symbols (e.g. big-O notation)
 * and smoothing punctuation for natural spoken intonation.
 */
function spoken(text: string): string {
  let out = text
    .replace(/\bO\(([^)]+)\)/g, (_, inside: string) => `order ${inside}`)
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/["“”]/g, '')
    // Emphasis capitals down to ordinary words, acronyms left alone.
    .replace(/\b[A-Z]{3,}\b/g, (word) => (SPOKEN_ACRONYMS.has(word) ? word : word.toLowerCase()));

  for (const [pattern, replacement] of SPOKEN_REPLACEMENTS) out = out.replace(pattern, replacement);

  out = out
    .replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

  // A falling tone at the end of every segment, so consecutive segments do not
  // run together into one flat paragraph.
  return out && !/[.!?]$/.test(out) ? `${out}.` : out;
}

/**
 * Consecutive days ending today (or yesterday), from the days you rated
 * anything.
 *
 * Yesterday counts as the end of the run so that a streak is not reported as
 * broken at breakfast, before the day it is asking about has had a chance to
 * happen. `days` may arrive in any order and with duplicates.
 */
export function streakFrom(days: readonly string[], today: string): number {
  const set = new Set(days);
  const shift = (key: string, byDays: number) => {
    const t = Date.parse(`${key}T00:00:00Z`);
    return Number.isNaN(t) ? null : new Date(t + byDays * DAY_MS).toISOString().slice(0, 10);
  };

  let cursor = set.has(today) ? today : shift(today, -1);
  if (!cursor || !set.has(cursor)) return 0;

  let n = 0;
  while (cursor && set.has(cursor)) {
    n += 1;
    cursor = shift(cursor, -1);
  }
  return n;
}

/* ── composing a page ──────────────────────────────────────────────────────── */

/**
 * Interleaved feed pattern: balanced mix of reviews (`due`), fresh concepts (`new`),
 * active practice (`drill`), and report weaknesses (`fix`).
 */
export const FEED_WEAVE = ['due', 'new', 'new', 'drill', 'new', 'due', 'new', 'fix'] as const;
export type FeedQueueName = (typeof FEED_WEAVE)[number];

/** Priority when the weave asks for an empty queue. New material first. */
const FALLBACK_ORDER: readonly FeedQueueName[] = ['new', 'due', 'drill', 'fix'];

/**
 * Interleave the queues into one page, consuming each in the order given.
 *
 * Pure, generic over the item type, and total: it returns as many items as
 * exist when they run out early, and never emits the same item twice because
 * every queue is consumed by shifting a copy.
 */
export function weave<T>(queues: Record<FeedQueueName, readonly T[]>, limit: number): T[] {
  const left: Record<FeedQueueName, T[]> = {
    due: [...queues.due],
    new: [...queues.new],
    drill: [...queues.drill],
    fix: [...queues.fix],
  };

  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    const wanted = FEED_WEAVE[i % FEED_WEAVE.length]!;
    const from = left[wanted].length ? wanted : FALLBACK_ORDER.find((q) => left[q].length);
    if (!from) break;
    out.push(left[from].shift()!);
  }
  return out;
}

/**
 * Deterministic pseudo-random value in [0, 1) computed from a string key and seed,
 * providing stable ordering within a session while enabling varied layouts across sessions.
 */
export function jitter(key: string, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h / 0xffffffff;
}

/**
 * Prioritizes unread teaching cards matching weak performance topics,
 * applying deterministic jitter within priority buckets to ensure topic variety.
 */
export function rankFresh<T extends { key: string; tags: readonly string[] }>(
  cards: readonly T[],
  weakTopics: readonly string[],
  seed: number,
): T[] {
  const weak = new Set(weakTopics.map((t) => t.toLowerCase()));
  const scored = cards.map((c) => {
    const hits = weak.size ? c.tags.filter((t) => weak.has(t.toLowerCase())).length : 0;
    // Bucketed, not summed: a card tagged with three of your weak topics is not
    // three times more urgent than one tagged with a single weak topic, and
    // treating it that way would surface the same over-tagged cards for ever.
    return { c, bucket: hits > 0 ? 0 : 1, j: jitter(c.key, seed) };
  });
  scored.sort((a, b) => a.bucket - b.bucket || a.j - b.j);
  return scored.map((s) => s.c);
}

/* ── personal signals ──────────────────────────────────────────────────────── */

/**
 * Extracts questions from the latest evaluation outcomes where the latest verdict
 * is partial or unsolved. Walks rounds newest-first so newer solved outcomes take precedence.
 */
export function unfinishedVerdicts<R extends { evaluationId: string; questionId: string; outcome: string }>(
  evaluationIds: readonly string[],
  rows: readonly R[],
): R[] {
  const out: R[] = [];
  const seen = new Set<string>();
  for (const evaluationId of evaluationIds) {
    for (const r of rows) {
      if (r.evaluationId !== evaluationId || seen.has(r.questionId)) continue;
      seen.add(r.questionId);
      if (r.outcome === 'partial' || r.outcome === 'unsolved') out.push(r);
    }
  }
  return out;
}

/** A delivery dimension counts as weak below this, on the 1-5 anchored scale. */
export const WEAK_DIMENSION_MAX = 3.5;

export type WeakDimension = {
  dimension: string;
  mean: number;
  /** From the newest round that scored this dimension WEAK, never a stronger one. */
  assessment: string;
  evidenceQuote: string | null;
  evaluationId: string;
};

/**
 * The worst delivery dimensions, averaged over `evaluationIds` (newest first).
 *
 * The mean decides WHETHER a dimension is weak; the words shown come from the
 * newest round that actually scored it below `WEAK_DIMENSION_MAX`. Taking the
 * newest assessment regardless of score put a 5/5 round's praise on a card
 * headed as the thing to fix. A mean below the line guarantees such a round.
 */
export function weakDimensions(
  evaluationIds: readonly string[],
  rows: readonly {
    evaluationId: string;
    dimension: string;
    score: number;
    assessment: string;
    evidenceQuote: string | null;
  }[],
  limit = 3,
): WeakDimension[] {
  const by = new Map<string, { total: number; n: number; source?: (typeof rows)[number] }>();
  for (const id of evaluationIds) {
    for (const r of rows) {
      if (r.evaluationId !== id) continue;
      const cur = by.get(r.dimension) ?? { total: 0, n: 0 };
      cur.total += r.score;
      cur.n += 1;
      if (!cur.source && r.score < WEAK_DIMENSION_MAX) cur.source = r;
      by.set(r.dimension, cur);
    }
  }
  const out: WeakDimension[] = [];
  for (const [dimension, v] of by) {
    const mean = v.total / v.n;
    if (mean >= WEAK_DIMENSION_MAX || !v.source) continue;
    out.push({
      dimension,
      mean,
      assessment: v.source.assessment,
      evidenceQuote: v.source.evidenceQuote,
      evaluationId: v.source.evaluationId,
    });
  }
  return out.sort((a, b) => a.mean - b.mean).slice(0, limit);
}
