import { Injectable, Inject } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  learningCards,
  feedCardState,
  feedEvents,
  dsaQuestions,
  questionCollections,
  conceptQuestions,
  type Database,
} from '@orvia/db';
import {
  DAILY_CARD_GOAL,
  DEFAULT_COLLECTION,
  RATING_ACTIONS,
  rankFresh,
  scheduleReview,
  streakFrom,
  weave,
  type FeedAction,
  type FeedCard,
  type FeedCardState,
  type FeedPage,
  type FeedQueueName,
  type LearningCard,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import { TtlCache } from '../common/ttl-cache';
import { FeedSignalsService } from './feed-signals.service';
import { SpeechCacheService } from './speech-cache.service';

/**
 * Composes a personalized, interleaved page of feed cards.
 * Card ordering is deterministic for a given seed, all queues are optional,
 * and drill cards exclude answer keys and solutions.
 */

/** Sane bounds on one request. The client asks for eight at a time. */
const MAX_LIMIT = 30;
/**
 * Maximum cards composed per request before slicing to the page offset,
 * bounding re-weave work across pages.
 */
const MAX_COMPOSE = 500;

/** Drill candidates drawn per request, before ranking. Keeps the query small. */
const DRILL_POOL = 60;

/**
 * The teaching bank changes only when someone re-seeds, so it is read once per
 * process rather than on every scroll. Short enough that a re-seed appears
 * without a restart.
 */
const BANK_TTL_MS = 5 * 60_000;

/**
 * The personal signals are NOT cached, deliberately. They are six indexed
 * queries over one account's recent history, and the staleness would be
 * user-visible in the one moment it matters: a report landing while the feed is
 * open must turn into a recall card on the next page, not a minute later.
 */

type StateRow = {
  cardKey: string;
  timesSeen: number;
  strength: number;
  dueAt: Date | null;
  saved: boolean;
};

const NEW_CARD: FeedCardState = { timesSeen: 0, saved: false, strength: 0, dueAt: null };

@Injectable()
export class FeedService {
  private readonly bankCache = new TtlCache<'bank', LearningCard[]>(BANK_TTL_MS, 1);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly signals: FeedSignalsService,
    private readonly speech: SpeechCacheService,
  ) {}

  /* ── the feed ────────────────────────────────────────────────────────────── */

  async page(
    userId: string,
    opts: {
      offset: number;
      limit: number;
      seed: number;
      dayKey: string;
      voice?: string;
      narratedOnly?: boolean;
    },
  ): Promise<FeedPage> {
    const limit = Math.min(Math.max(opts.limit, 1), MAX_LIMIT);
    const offset = Math.max(opts.offset, 0);
    const now = new Date();

    const [bank, states, signals, days] = await Promise.all([
      this.bank(),
      this.states(userId),
      this.signals.signals(userId),
      this.activeDays(userId),
    ]);

    const stateOf = (key: string): FeedCardState => {
      const row = states.get(key);
      if (!row) return NEW_CARD;
      return {
        timesSeen: row.timesSeen,
        saved: row.saved,
        strength: row.strength,
        dueAt: row.dueAt?.toISOString() ?? null,
      };
    };
    /** In cooldown: seen or rated recently enough that it must not reappear. */
    const resting = (key: string) => {
      const due = states.get(key)?.dueAt;
      return !!due && due.getTime() > now.getTime();
    };

    const weak = signals.weakTopics;

    /**
     * Listening to generated narration only.
     *
     * Filtered HERE rather than in the browser: with a partly built cache the
     * narrated cards are scattered through the whole feed, so a client that
     * skipped the rest would page through everything to find them. The stat
     * card is exempt — it is never narrated and never read.
     */
    const voice = opts.voice ?? (await this.speech.defaultVoice());
    const narrated = opts.narratedOnly && voice ? await this.speech.narratedKeys(voice) : null;
    const audible = (key: string) => !narrated || narrated.has(key);

    /* ── the teaching bank, split into reviews and new material ───────────── */

    const teaching = bank.map((card) => ({ key: `card:${card.id}`, card, tags: card.tags }));

    const due = teaching
      .filter((t) => {
        if (!audible(t.key)) return false;
        const at = states.get(t.key)?.dueAt;
        return !!at && at.getTime() <= now.getTime();
      })
      // Most overdue first. A review that has been waiting a week is more
      // urgent than one that came due this morning, and `strength` already
      // decided how long each was allowed to wait.
      .sort((a, b) => (states.get(a.key)!.dueAt!.getTime() - states.get(b.key)!.dueAt!.getTime()));

    const fresh = rankFresh(
      teaching.filter((t) => !states.has(t.key) && audible(t.key)),
      weak,
      opts.seed,
    );

    /* ── things to actually go and answer ─────────────────────────────────── */

    const recallCards: FeedCard[] = signals.recalls
      .map((r) => ({
        kind: 'recall' as const,
        key: `recall:${r.mode}:${r.questionId}`,
        state: stateOf(`recall:${r.mode}:${r.questionId}`),
        track: r.mode,
        questionId: r.questionId,
        title: r.title,
        prompt: r.prompt,
        outcome: r.outcome,
        reason: r.reason,
        lastAttemptedAt: r.lastAttemptedAt,
        sessionId: r.sessionId,
        practice: { mode: r.mode, questionId: r.questionId },
      }))
      .filter((c) => !resting(c.key) && audible(c.key));

    const drillCards = (await this.drills(signals.recalls.map((r) => r.questionId), weak, opts.seed))
      .map((d) => ({ ...d, state: stateOf(d.key) }))
      .filter((c) => !resting(c.key) && audible(c.key));

    /* ── your own reports, one line at a time ─────────────────────────────── */

    const fixCards: FeedCard[] = signals.fixes
      .map((f) => ({
        kind: 'fix' as const,
        key: f.key,
        state: stateOf(f.key),
        sessionId: f.sessionId,
        mode: f.mode,
        fix: f.fix,
        dimension: f.dimension,
        score: f.score,
        evidenceQuote: f.evidenceQuote,
        at: f.at,
      }))
      .filter((c) => !resting(c.key) && audible(c.key));

    /* ── weave, then slice to the page ────────────────────────────────────── */

    const queues: Record<FeedQueueName, FeedCard[]> = {
      due: due.map((t) => teachingCard(t, stateOf(t.key), null)),
      new: fresh.map((t) => teachingCard(t, stateOf(t.key), matchedTopic(t.tags, weak))),
      // Unfinished business ahead of fresh drills: a problem your own report
      // says you did not solve is a better use of the slot than a problem you
      // have never been asked.
      drill: [...recallCards, ...drillCards],
      fix: fixCards,
    };

    const woven = weave(queues, Math.min(offset + limit, MAX_COMPOSE));
    const cards = woven.slice(offset);

    const todayCount = await this.todayCount(userId, opts.dayKey);
    const streak = streakFrom(days, opts.dayKey);

    // The stat card is pinned to the top of the first page and appears nowhere
    // else: it is the only card that is not something to learn.
    if (offset === 0) {
      cards.unshift({
        kind: 'stat',
        key: 'stat:today',
        state: NEW_CARD,
        todayCount,
        streak,
        dueCount: due.length,
        roundsThisWeek: signals.roundsThisWeek,
        latestScore: signals.latestScore,
        previousScore: signals.previousScore,
        weakTopics: weak.slice(0, 4),
      });
    }

    /**
     * Narration is attached last, to the page rather than to every candidate:
     * the weave discards most of what it considered, and a manifest lookup for
     * a card nobody will see is work for nothing.
     */
    if (voice) {
      await Promise.all(
        cards.map(async (card) => {
          card.audio = await this.speech.clipsFor(card.key, voice);
        }),
      );
    }

    return {
      cards,
      nextOffset: woven.length >= offset + limit ? offset + limit : null,
      meta: { todayCount, streak, dueCount: due.length, goal: DAILY_CARD_GOAL },
    };
  }

  /* ── interactions ────────────────────────────────────────────────────────── */

  /**
   * Records a user feed interaction and computes updated card state.
   * Logs every action as an append-only event while updating aggregate card state.
   */
  async interact(
    userId: string,
    input: { cardKey: string; action: FeedAction; dayKey: string; snapshot?: unknown },
  ): Promise<FeedCardState> {
    const now = new Date();

    /** Updates card state within a transaction to prevent concurrent action races. */
    const row = await this.db.transaction(async (tx) => {
      await tx
        .insert(feedCardState)
        .values({ userId, cardKey: input.cardKey, timesSeen: 0, lastSeenAt: now })
        .onConflictDoNothing({ target: [feedCardState.userId, feedCardState.cardKey] });

      const [existing] = await tx
        .select()
        .from(feedCardState)
        .where(and(eq(feedCardState.userId, userId), eq(feedCardState.cardKey, input.cardKey)))
        .for('update');

      const after = scheduleReview(
        { strength: existing?.strength ?? 0, dueAt: existing?.dueAt ?? null },
        input.action,
        now,
      );
      const saved =
        input.action === 'save' ? true : input.action === 'unsave' ? false : (existing?.saved ?? false);

      const [updated] = await tx
        .update(feedCardState)
        .set({
          timesSeen: sql`${feedCardState.timesSeen} + 1`,
          strength: after.strength,
          dueAt: after.dueAt,
          saved,
          // Only a save writes a snapshot, and unsaving clears it.
          snapshot:
            input.action === 'save'
              ? (input.snapshot ?? null)
              : input.action === 'unsave'
                ? null
                : (existing?.snapshot ?? null),
          lastAction: input.action,
          lastSeenAt: now,
        })
        .where(and(eq(feedCardState.userId, userId), eq(feedCardState.cardKey, input.cardKey)))
        .returning();

      await tx.insert(feedEvents).values({
        userId,
        cardKey: input.cardKey,
        action: input.action,
        dayKey: input.dayKey,
      });
      return updated;
    });

    return {
      timesSeen: row!.timesSeen,
      saved: row!.saved,
      strength: row!.strength,
      dueAt: row!.dueAt?.toISOString() ?? null,
    };
  }

  /**
   * Returns saved cards, newest first. Uses stored snapshots to preserve derived cards,
   * falling back to bank resolution if snapshot is absent.
   */
  async saved(userId: string): Promise<{ key: string; card: unknown }[]> {
    const rows = await this.db
      .select()
      .from(feedCardState)
      .where(and(eq(feedCardState.userId, userId), eq(feedCardState.saved, true)))
      .orderBy(desc(feedCardState.lastSeenAt));

    if (!rows.length) return [];

    const missing = rows.filter((r) => !r.snapshot && r.cardKey.startsWith('card:'));
    const bank = missing.length
      ? await this.db
          .select()
          .from(learningCards)
          .where(inArray(learningCards.id, missing.map((r) => r.cardKey.slice('card:'.length))))
      : [];
    const byId = new Map(bank.map((b) => [b.id, b]));

    const out: { key: string; card: unknown }[] = [];
    for (const r of rows) {
      if (r.snapshot) {
        out.push({ key: r.cardKey, card: r.snapshot });
        continue;
      }
      const row = byId.get(r.cardKey.slice('card:'.length));
      if (row) {
        const card = rowToCard(row);
        out.push({
          key: r.cardKey,
          card: {
            kind: card.kind,
            key: r.cardKey,
            card,
            becauseOf: null,
            // Rebuilt rather than omitted: the renderer reads `state` on every
            // card, and a saved entry with none would blank the page.
            state: {
              timesSeen: r.timesSeen,
              saved: r.saved,
              strength: r.strength,
              dueAt: r.dueAt?.toISOString() ?? null,
            },
          },
        });
      }
    }
    return out;
  }

  /* ── reads ───────────────────────────────────────────────────────────────── */

  private bank(): Promise<LearningCard[]> {
    return this.bankCache.fetch('bank', async () => {
      const rows = await this.db.select().from(learningCards).orderBy(asc(learningCards.orderIdx));
      return rows.map(rowToCard);
    });
  }

  private async states(userId: string): Promise<Map<string, StateRow>> {
    const rows = await this.db
      .select({
        cardKey: feedCardState.cardKey,
        timesSeen: feedCardState.timesSeen,
        strength: feedCardState.strength,
        dueAt: feedCardState.dueAt,
        saved: feedCardState.saved,
      })
      .from(feedCardState)
      .where(eq(feedCardState.userId, userId));
    return new Map(rows.map((r) => [r.cardKey, r]));
  }

  /** Distinct days with at least one RATING — see `RATING_ACTIONS`. */
  private async activeDays(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ dayKey: feedEvents.dayKey })
      .from(feedEvents)
      .where(and(eq(feedEvents.userId, userId), inArray(feedEvents.action, [...RATING_ACTIONS])));
    return rows.map((r) => r.dayKey);
  }

  private async todayCount(userId: string, dayKey: string): Promise<number> {
    const rows = await this.db
      .selectDistinct({ cardKey: feedEvents.cardKey })
      .from(feedEvents)
      .where(
        and(
          eq(feedEvents.userId, userId),
          eq(feedEvents.dayKey, dayKey),
          inArray(feedEvents.action, [...RATING_ACTIONS]),
        ),
      );
    // Distinct CARDS, not presses: rating the same card twice after a relearn
    // is one card learnt, and a goal you can close by pressing one button
    // twelve times is not a goal.
    return rows.length;
  }

  /**
   * Selects drill questions from default collections and concepts, prompt only.
   * Redacts solutions and rubrics; excludes active recall problems.
   */
  private async drills(
    excludeIds: string[],
    weak: string[],
    seed: number,
  ): Promise<Omit<Extract<FeedCard, { kind: 'drill' }>, 'state'>[]> {
    const exclude = new Set(excludeIds);

    const [dsa, concepts] = await Promise.all([
      this.db
        .select({
          id: dsaQuestions.id,
          title: dsaQuestions.title,
          prompt: dsaQuestions.prompt,
          difficulty: dsaQuestions.difficulty,
          topics: dsaQuestions.topics,
        })
        .from(questionCollections)
        .innerJoin(dsaQuestions, eq(dsaQuestions.id, questionCollections.questionId))
        .where(eq(questionCollections.collection, DEFAULT_COLLECTION))
        .orderBy(asc(questionCollections.orderIdx))
        .limit(DRILL_POOL),
      this.db
        .select({
          id: conceptQuestions.id,
          title: conceptQuestions.title,
          prompt: conceptQuestions.prompt,
          difficulty: conceptQuestions.difficulty,
          topic: conceptQuestions.topic,
        })
        .from(conceptQuestions)
        .orderBy(asc(conceptQuestions.orderIdx))
        .limit(DRILL_POOL),
    ]);

    const candidates = [
      ...dsa.map((q) => ({
        kind: 'drill' as const,
        key: `drill:dsa:${q.id}`,
        track: 'dsa' as const,
        questionId: q.id,
        title: q.title,
        prompt: q.prompt,
        difficulty: q.difficulty,
        tags: (q.topics as string[]) ?? [],
        practice: { mode: 'dsa' as const, questionId: q.id },
      })),
      ...concepts.map((q) => ({
        kind: 'drill' as const,
        key: `drill:concepts:${q.id}`,
        track: 'concepts' as const,
        questionId: q.id,
        title: q.title,
        prompt: q.prompt,
        difficulty: q.difficulty,
        tags: [q.topic],
        practice: { mode: 'concepts' as const, questionId: q.id },
      })),
    ].filter((c) => !exclude.has(c.questionId));

    return rankFresh(candidates, weak, seed);
  }
}

/* ── row mapping ───────────────────────────────────────────────────────────── */

function rowToCard(row: typeof learningCards.$inferSelect): LearningCard {
  return {
    id: row.id,
    kind: row.kind as LearningCard['kind'],
    track: row.track as LearningCard['track'],
    title: row.title,
    body: row.body,
    takeaway: row.takeaway,
    code: row.code ?? undefined,
    codeLanguage: row.codeLanguage ?? undefined,
    tags: (row.tags as string[]) ?? [],
    difficulty: row.difficulty as LearningCard['difficulty'],
    choices: (row.choices as string[] | null) ?? undefined,
    answerIdx: row.answerIdx ?? undefined,
    explanation: row.explanation ?? undefined,
  };
}

function teachingCard(
  t: { key: string; card: LearningCard },
  state: FeedCardState,
  becauseOf: string | null,
): FeedCard {
  /**
   * `kind` and `card.kind` are the same value read twice, which TypeScript
   * cannot correlate across two positions of one union — so this is asserted
   * rather than written out as a three-way switch that would say the same
   * thing three times.
   */
  return { kind: t.card.kind, key: t.key, state, card: t.card, becauseOf } as FeedCard;
}

/**
 * Which weak topic pulled this card forward, for the line the card shows.
 *
 * Returns the first match rather than all of them: the card says "because
 * Dynamic Programming went badly", and a list of three reasons reads as an
 * algorithm explaining itself rather than as an explanation.
 */
function matchedTopic(tags: readonly string[], weak: readonly string[]): string | null {
  const lower = new Set(weak.map((w) => w.toLowerCase()));
  return tags.find((t) => lower.has(t.toLowerCase())) ?? null;
}
