import { Injectable, Inject } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  sessions,
  deliveryScores,
  questionOutcomes,
  dsaQuestions,
  conceptQuestions,
  type Database,
} from '@orvia/db';
import { unfinishedVerdicts, weakDimensions, type WeakDimension } from '@orvia/shared';
import { DB } from '../db/db.module';
import { latestEvaluations, type LatestEvaluation } from '../question-bank/latest-evaluations';

/**
 * Reads session history into the three personal signals the feed needs: weak
 * topics, unfinished problems, and lines worth re-showing from past reports.
 * Every read goes through the latest COMPLETE evaluation per round; the rules
 * that pick from it are in `@orvia/shared/feed` so `verify:feed` executes them.
 */

/**
 * Modes that can produce a recall. `system_design` is not one: it is scored by
 * phase and writes no `question_outcomes` rows, so a design recall cannot exist.
 */
const PRACTISABLE = ['dsa', 'concepts'] as const;
type PractisableMode = (typeof PRACTISABLE)[number];

/**
 * How far back the signals look.
 *
 * Twenty rounds rather than all of them: a fix from a round six months ago is
 * not evidence about how you interview now, and a weak-topic list that never
 * forgets would keep steering the feed towards something you fixed in March.
 */
const HISTORY_ROUNDS = 20;

export type RecallCandidate = {
  mode: PractisableMode;
  questionId: string;
  title: string;
  prompt: string;
  outcome: 'partial' | 'unsolved';
  reason: string;
  lastAttemptedAt: string;
  sessionId: string;
  /** LeetCode topics where the bank has them, for the weak-topic list. */
  topics: string[];
};

export type FixCandidate = {
  key: string;
  sessionId: string;
  mode: string;
  fix: string;
  dimension: string | null;
  score: number | null;
  evidenceQuote: string | null;
  at: string;
};

export type FeedSignals = {
  /**
   * Topics and delivery dimensions to pull matching cards forward. Mixed in one
   * list on purpose — a card is tagged with either, and the match is
   * case-insensitive, so "Dynamic Programming" and "structure" live together.
   */
  weakTopics: string[];
  recalls: RecallCandidate[];
  fixes: FixCandidate[];
  roundsThisWeek: number;
  latestScore: number | null;
  previousScore: number | null;
};

@Injectable()
export class FeedSignalsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async signals(userId: string): Promise<FeedSignals> {
    const rounds = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      // Drills out: a drill's advice and verdicts are about one moment already
      // studied, and would push the rounds' own fixes off the feed.
      .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'round')))
      .orderBy(desc(sessions.startedAt))
      .limit(HISTORY_ROUNDS);

    if (!rounds.length) {
      return {
        weakTopics: [],
        recalls: [],
        fixes: [],
        roundsThisWeek: 0,
        latestScore: null,
        previousScore: null,
      };
    }

    const roundById = new Map(rounds.map((r) => [r.id, r]));
    const sessionIds = rounds.map((r) => r.id);

    const latest = await latestEvaluations(this.db, sessionIds);

    /**
     * In the rounds' own order — newest first — rather than the evaluations'.
     * A re-run six weeks later must not present an old round as your latest
     * work, which is exactly what ordering by `evaluations.createdAt` would do.
     */
    const finished = sessionIds
      .map((id) => latest.get(id))
      .filter((e): e is LatestEvaluation => !!e);

    const scored = finished.filter((e) => e.overallScore !== null);

    const [recalls, dimensions] = await Promise.all([
      this.recalls(finished, roundById),
      this.weakDimensions(finished.slice(0, 5).map((e) => e.id)),
    ]);

    const weekAgo = Date.now() - 7 * 86_400_000;

    return {
      weakTopics: [
        // Topics first: a concrete problem you could not finish is a better
        // steer than a delivery average, and `rankFresh` only needs ONE hit to
        // pull a card into the front bucket, so order is presentation only.
        ...new Set(recalls.flatMap((r) => r.topics)),
        ...dimensions.map((d) => d.dimension),
      ],
      recalls,
      fixes: this.fixes(finished, dimensions, roundById),
      roundsThisWeek: rounds.filter((r) => r.startedAt.getTime() >= weekAgo).length,
      latestScore: scored[0]?.overallScore ?? null,
      previousScore: scored[1]?.overallScore ?? null,
    };
  }

  /**
   * Problems your latest report says you did not finish — see
   * `unfinishedVerdicts` for why every outcome row is walked, not just these.
   */
  private async recalls(
    finished: readonly LatestEvaluation[],
    roundById: Map<string, { id: string; mode: string; startedAt: Date }>,
  ): Promise<RecallCandidate[]> {
    const practisable = finished.filter((e) =>
      PRACTISABLE.includes(roundById.get(e.sessionId)?.mode as PractisableMode),
    );
    if (!practisable.length) return [];

    const rows = await this.db
      .select({
        evaluationId: questionOutcomes.evaluationId,
        questionId: questionOutcomes.questionId,
        outcome: questionOutcomes.outcome,
        reason: questionOutcomes.reason,
      })
      .from(questionOutcomes)
      .where(inArray(questionOutcomes.evaluationId, practisable.map((e) => e.id)));

    const wanted = unfinishedVerdicts(practisable.map((e) => e.id), rows);
    if (!wanted.length) return [];

    const ids = [...new Set(wanted.map((r) => r.questionId))];
    const [dsa, concepts] = await Promise.all([
      this.db
        .select({
          id: dsaQuestions.id,
          title: dsaQuestions.title,
          prompt: dsaQuestions.prompt,
          topics: dsaQuestions.topics,
        })
        .from(dsaQuestions)
        .where(inArray(dsaQuestions.id, ids)),
      this.db
        .select({
          id: conceptQuestions.id,
          title: conceptQuestions.title,
          prompt: conceptQuestions.prompt,
          // The concepts bank's only classification, carried as "topics" so a
          // fumbled Node question steers the feed towards Node cards.
          topic: conceptQuestions.topic,
        })
        .from(conceptQuestions)
        .where(inArray(conceptQuestions.id, ids)),
    ]);

    const bank = new Map<string, { title: string; prompt: string; topics: string[] }>();
    for (const q of dsa) bank.set(q.id, { title: q.title, prompt: q.prompt, topics: (q.topics as string[]) ?? [] });
    for (const q of concepts) bank.set(q.id, { title: q.title, prompt: q.prompt, topics: [q.topic] });

    const evalToSession = new Map(practisable.map((e) => [e.id, e.sessionId]));
    const out: RecallCandidate[] = [];
    for (const r of wanted) {
      const round = roundById.get(evalToSession.get(r.evaluationId) ?? '');
      const q = bank.get(r.questionId);
      // A slug that has left the bank has no prompt to show and no round to
      // start, so it is dropped rather than rendered as a card that goes nowhere.
      if (!round || !q) continue;
      out.push({
        mode: round.mode as PractisableMode,
        questionId: r.questionId,
        title: q.title,
        prompt: q.prompt,
        outcome: r.outcome as 'partial' | 'unsolved',
        reason: r.reason,
        lastAttemptedAt: round.startedAt.toISOString(),
        sessionId: round.id,
        topics: q.topics,
      });
    }
    return out;
  }

  /**
   * The delivery dimensions you score worst on, averaged over recent rounds —
   * one nervous morning should not redirect a fortnight of feed.
   */
  private async weakDimensions(evaluationIds: string[]): Promise<WeakDimension[]> {
    if (!evaluationIds.length) return [];
    const rows = await this.db
      .select({
        evaluationId: deliveryScores.evaluationId,
        dimension: deliveryScores.dimension,
        score: deliveryScores.score,
        assessment: deliveryScores.assessment,
        evidenceQuote: deliveryScores.evidenceQuote,
      })
      .from(deliveryScores)
      .where(inArray(deliveryScores.evaluationId, evaluationIds));
    return weakDimensions(evaluationIds, rows);
  }

  /**
   * Generates fix cards directly from evaluator reports: top fixes and weak delivery assessments.
   * Uses original phrasing so advice is directly traceable to the source round.
   */
  private fixes(
    finished: { id: string; sessionId: string; topFixes: unknown; createdAt: Date }[],
    dimensions: WeakDimension[],
    roundById: Map<string, { id: string; mode: string; startedAt: Date }>,
  ): FixCandidate[] {
    const out: FixCandidate[] = [];

    /**
     * Three rounds, not twenty. These are the cards most likely to feel like
     * nagging, and a fix you have already acted on reappearing for a month is
     * how a feed loses its credibility.
     */
    for (const e of finished.slice(0, 3)) {
      const round = roundById.get(e.sessionId);
      if (!round) continue;
      const list = Array.isArray(e.topFixes) ? (e.topFixes as unknown[]) : [];
      for (const [i, fix] of list.entries()) {
        if (typeof fix !== 'string' || !fix.trim()) continue;
        out.push({
          key: `fix:${e.id}:top:${i}`,
          sessionId: e.sessionId,
          mode: round.mode,
          fix,
          dimension: null,
          score: null,
          evidenceQuote: null,
          at: round.startedAt.toISOString(),
        });
      }
    }

    // Attributed to the round the assessment was written for, so the card can
    // be traced back to it — not to the newest round, which may have scored
    // this dimension well.
    const sessionOf = new Map(finished.map((e) => [e.id, e.sessionId]));
    for (const d of dimensions) {
      const round = roundById.get(sessionOf.get(d.evaluationId) ?? '');
      if (!round) continue;
      out.push({
        key: `fix:${d.evaluationId}:dim:${d.dimension}`,
        sessionId: round.id,
        mode: round.mode,
        fix: d.assessment,
        dimension: d.dimension,
        // The MEAN across recent rounds, not the source round's score. The card
        // is a claim about a pattern, and one round's number beside a pattern's
        // text would be two different measurements in one sentence.
        score: Math.round(d.mean * 10) / 10,
        evidenceQuote: d.evidenceQuote,
        at: round.startedAt.toISOString(),
      });
    }

    return out;
  }
}
