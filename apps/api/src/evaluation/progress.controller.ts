import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import {
  sessions, evaluations, deliveryScores, speechMetrics, questionEvaluations,
  dsaQuestions, type Database,
} from '@orvia/db';
import { RUBRIC_VERSION } from '@orvia/shared';
import { DB } from '../db/db.module';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';

@Controller('api/progress')
@UseGuards(AuthGuard)
export class ProgressController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * The trend line. Only completed evaluations are returned, and each point
   * carries its rubric version — scores from different rubrics are not
   * comparable, and the UI has to be able to say so rather than silently
   * plotting them on the same axis.
   */
  @Get()
  async get(@CurrentUser() user: PublicUser) {
    const allRows = await this.db
      .select({
        sessionId: sessions.id,
        evaluationId: evaluations.id,
        mode: sessions.mode,
        config: sessions.config,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
        overallScore: evaluations.overallScore,
        overallVerdict: evaluations.overallVerdict,
        rubricVersion: evaluations.rubricVersion,
        audioAnalysed: evaluations.audioAnalysed,
        wordsPerMinute: speechMetrics.wordsPerMinute,
        fillerRate: speechMetrics.fillerRate,
        talkRatio: speechMetrics.talkRatio,
        meanTurnWords: speechMetrics.meanTurnWords,
        medianResponseLatencyMs: speechMetrics.medianResponseLatencyMs,
      })
      .from(sessions)
      .innerJoin(evaluations, eq(evaluations.sessionId, sessions.id))
      .leftJoin(speechMetrics, eq(speechMetrics.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.userId, user.id),
          // A drill retries one moment after its model answer was read, so
          // its score is not a point on the trend.
          eq(sessions.kind, 'round'),
          eq(evaluations.status, 'complete'),
          isNotNull(evaluations.overallScore),
        ),
      )
      // Tie-broken on the evaluation's own timestamp: several evaluations can
      // share a session, so ordering by `startedAt` alone left the order of
      // those rows up to Postgres — and the UI reads the last one as "latest".
      .orderBy(asc(sessions.startedAt), asc(evaluations.createdAt));

    /**
     * Deduplicates multiple evaluations per session so each session contributes
     * exactly one point. The latest evaluation per session wins.
     */
    const latestBySession = new Map<string, (typeof allRows)[number]>();
    for (const r of allRows) latestBySession.set(r.sessionId, r);
    const rows = [...latestBySession.values()];

    // Per-dimension history, so the UI can show which parts of delivery are
    // actually moving rather than only the aggregate.
    const dims = rows.length
      ? await this.db
          .select({
            evaluationId: deliveryScores.evaluationId,
            dimension: deliveryScores.dimension,
            score: deliveryScores.score,
          })
          .from(deliveryScores)
      : [];

    const byEval = new Map<string, Record<string, number>>();
    for (const d of dims) {
      const bucket = byEval.get(d.evaluationId) ?? {};
      bucket[d.dimension] = d.score;
      byEval.set(d.evaluationId, bucket);
    }

    /**
     * Per-topic performance, so "I'm weak on graphs" is answerable rather than
     * only "my score is 68". Topics come from the questions configured for each
     * round, so a round's score attributes to every topic it covered — precise
     * enough to rank subject areas, not precise enough to score one question.
     */
    const [allQuestionEvals, bank] = rows.length
      ? await Promise.all([
          this.db.select({
            evaluationId: questionEvaluations.evaluationId,
            score: questionEvaluations.score,
          }).from(questionEvaluations),
          this.db.select({ id: dsaQuestions.id, topics: dsaQuestions.topics }).from(dsaQuestions),
        ])
      : [[], []];

    const topicsById = new Map(bank.map((q) => [q.id, (q.topics as string[]) ?? []]));
    const byTopic = new Map<string, number[]>();
    for (const r of rows) {
      const cfg = r.config as { questionIds?: string[] };
      const topics = [...new Set((cfg.questionIds ?? []).flatMap((id) => topicsById.get(id) ?? []))];
      if (topics.length === 0) continue;
      for (const qe of allQuestionEvals.filter((q) => q.evaluationId === r.evaluationId)) {
        for (const t of topics) byTopic.set(t, [...(byTopic.get(t) ?? []), qe.score]);
      }
    }

    const topics = [...byTopic.entries()]
      .map(([topic, xs]) => ({
        topic,
        questions: xs.length,
        average: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)),
      }))
      // Two questions is the minimum at which an average means anything.
      .filter((t) => t.questions >= 2)
      .sort((a, b) => a.average - b.average);

    return {
      currentRubric: RUBRIC_VERSION,
      topics,
      sessions: rows.map((r) => ({
        ...r,
        startedAt: r.startedAt.toISOString(),
        delivery: byEval.get(r.evaluationId) ?? {},
      })),
    };
  }
}
