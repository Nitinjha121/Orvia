import { Injectable, Inject } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  sessions, deliveryScores, speechMetrics, questionEvaluations, dsaQuestions,
  type Database,
} from '@orvia/db';
import type { Verdict } from '@orvia/shared';
import { DB } from '../db/db.module';
import { latestEvaluations } from '../question-bank/latest-evaluations';
import { readStoredConfig } from '../question-bank/stored-config';
import type { MentorSession } from './mentor.prompt';

/**
 * Assembles a user's whole practice history for the mentor, in bulk rather
 * than per round, so the wait before it speaks does not grow with the history.
 */
@Injectable()
export class MentorDataService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async history(userId: string): Promise<MentorSession[]> {
    const rounds = await this.db
      .select({
        sessionId: sessions.id,
        mode: sessions.mode,
        config: sessions.config,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
      })
      .from(sessions)
      // The mentor reads rounds as a TREND; a drill is not a point on it.
      .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'round')))
      .orderBy(asc(sessions.startedAt));

    /**
     * ONE evaluation per round, the latest complete one. Joining every complete
     * evaluation counted a re-evaluated round once per run, so the trend the
     * mentor exists to read gave that round double weight.
     */
    const latest = await latestEvaluations(this.db, rounds.map((r) => r.sessionId));
    const rows = rounds.flatMap((r) => {
      const e = latest.get(r.sessionId);
      return e
        ? [{
            ...r,
            evaluationId: e.id,
            overallScore: e.overallScore,
            overallVerdict: e.overallVerdict,
            summary: e.summary,
            topFixes: e.topFixes,
          }]
        : [];
    });

    if (rows.length === 0) return [];

    const evalIds = new Set(rows.map((r) => r.evaluationId));
    const sessionIds = new Set(rows.map((r) => r.sessionId));

    const [dims, metrics, questions, bank] = await Promise.all([
      this.db.select().from(deliveryScores)
        .where(inArray(deliveryScores.evaluationId, [...evalIds])),
      this.db.select().from(speechMetrics)
        .where(inArray(speechMetrics.sessionId, [...sessionIds])),
      this.db.select().from(questionEvaluations)
        .where(inArray(questionEvaluations.evaluationId, [...evalIds])),
      this.db.select({ id: dsaQuestions.id, topics: dsaQuestions.topics }).from(dsaQuestions),
    ]);

    const topicsById = new Map(bank.map((q) => [q.id, (q.topics as string[]) ?? []]));

    return rows.map((r) => {
      const delivery: Record<string, number> = {};
      for (const d of dims) if (d.evaluationId === r.evaluationId) delivery[d.dimension] = d.score;

      const m = metrics.find((x) => x.sessionId === r.sessionId);
      const cfg = readStoredConfig(r.config);
      const sessionTopics = (cfg.questionIds ?? []).flatMap((id) => topicsById.get(id) ?? []);

      const qs = questions
        .filter((q) => q.evaluationId === r.evaluationId)
        .map((q) => ({
          question: q.question,
          score: q.score,
          // Question-level topics are not stored on the evaluation, so they are
          // attributed from the round's configured questions. Good enough to
          // surface "weak on graphs"; not exact per question.
          topics: sessionTopics,
        }));

      return {
        sessionId: r.sessionId,
        mode: r.mode,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        overallScore: r.overallScore,
        overallVerdict: r.overallVerdict as Verdict | null,
        summary: r.summary,
        topFixes: (r.topFixes as string[] | null) ?? null,
        delivery,
        metrics: m
          ? {
              wordsPerMinute: m.wordsPerMinute,
              fillerRate: m.fillerRate,
              talkRatio: m.talkRatio,
              meanTurnWords: m.meanTurnWords,
              medianResponseLatencyMs: m.medianResponseLatencyMs,
            }
          : null,
        topics: [...new Set(sessionTopics)],
        questionScores: qs,
      } satisfies MentorSession;
    });
  }
}
