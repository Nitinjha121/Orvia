import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  sessions, questionEvaluations, deliveryScores, focusChecks, type Database,
} from '@orvia/db';
import {
  drillQuestionMatch, type DrillAttempt, type DrillRecord, type DrillView, type Verdict,
} from '@orvia/shared';
import { latestEvaluations } from '../question-bank/latest-evaluations';

type ReportRows = {
  questions: { question: string; score: number; verdict: Verdict }[];
  delivery: { dimension: string; score: number; evidenceQuote: string | null }[];
};

/**
 * A drill's score on the SAME scale as the moment it retried: the retried
 * question's score out of ten, or the dimension's score out of five. Null when
 * the drill's report has no row that can honestly be called the retry.
 */
export function drillAfter(rec: DrillRecord, report: ReportRows): DrillView['after'] {
  if (rec.kind === 'question') {
    const q = drillQuestionMatch(rec.question, report.questions);
    return { score: q?.score ?? null, outOf: 10, verdict: q?.verdict ?? null, quote: null };
  }
  const d = report.delivery.find((x) => x.dimension === rec.dimension);
  return { score: d?.score ?? null, outOf: 5, verdict: null, quote: d?.evidenceQuote ?? null };
}

/**
 * Every drill of a round's moments, oldest first, each with its after-score
 * from its latest COMPLETE report — so a failed re-run cannot blank a score —
 * and its status from its latest report of any kind, so a drill still being
 * scored says so rather than reading as unscored.
 */
export async function drillAttempts(
  db: Database,
  userId: string,
  sourceSessionId: string,
): Promise<(DrillAttempt & { momentId: string })[]> {
  const rows = await db
    .select({ id: sessions.id, startedAt: sessions.startedAt, drill: sessions.drill })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.kind, 'drill'),
        sql`${sessions.drill}->>'sourceSessionId' = ${sourceSessionId}`,
      ),
    )
    .orderBy(asc(sessions.startedAt));
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const [complete, latest] = await Promise.all([
    latestEvaluations(db, ids),
    latestEvaluations(db, ids, { completeOnly: false }),
  ]);
  const evalIds = [...complete.values()].map((e) => e.id);
  const [qs, ds, fc] = evalIds.length
    ? await Promise.all([
        db.select({
          evaluationId: questionEvaluations.evaluationId,
          question: questionEvaluations.question,
          score: questionEvaluations.score,
          verdict: questionEvaluations.verdict,
        }).from(questionEvaluations).where(inArray(questionEvaluations.evaluationId, evalIds)),
        db.select({
          evaluationId: deliveryScores.evaluationId,
          dimension: deliveryScores.dimension,
          score: deliveryScores.score,
          evidenceQuote: deliveryScores.evidenceQuote,
        }).from(deliveryScores).where(inArray(deliveryScores.evaluationId, evalIds)),
        db.select({ evaluationId: focusChecks.evaluationId, result: focusChecks.result })
          .from(focusChecks).where(inArray(focusChecks.evaluationId, evalIds)),
      ])
    : [[], [], []];

  return rows.map((r) => {
    const rec = r.drill as DrillRecord;
    const ev = complete.get(r.id);
    const after = ev
      ? drillAfter(rec, {
          questions: qs.filter((q) => q.evaluationId === ev.id),
          delivery: ds.filter((d) => d.evaluationId === ev.id),
        })
      : null;
    const checks = ev ? fc.filter((c) => c.evaluationId === ev.id && c.result !== 'no_chance') : [];
    return {
      momentId: rec.momentId,
      sessionId: r.id,
      startedAt: r.startedAt.toISOString(),
      evaluationStatus: latest.get(r.id)?.status ?? null,
      after: after?.score ?? null,
      outOf: rec.before.outOf,
      applied: checks.filter((c) => c.result === 'applied').length,
      checked: checks.length,
    };
  });
}
