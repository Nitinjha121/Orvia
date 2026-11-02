import { and, eq, inArray } from 'drizzle-orm';
import { evaluations, type Database } from '@orvia/db';
import { latestEvaluationBySession } from '@orvia/shared';

/**
 * Selects the latest evaluation for each session across history readers (rotation, feed, mentor).
 * Fetches and reduces by session ID to avoid duplicate rows from re-runs.
 */
export async function latestEvaluations(
  db: Database,
  sessionIds: readonly string[],
  { completeOnly = true }: { completeOnly?: boolean } = {},
): Promise<Map<string, LatestEvaluation>> {
  if (!sessionIds.length) return new Map<string, LatestEvaluation>();
  const rows = await db
    .select({
      id: evaluations.id,
      sessionId: evaluations.sessionId,
      status: evaluations.status,
      createdAt: evaluations.createdAt,
      overallScore: evaluations.overallScore,
      overallVerdict: evaluations.overallVerdict,
      summary: evaluations.summary,
      topFixes: evaluations.topFixes,
      rubricVersion: evaluations.rubricVersion,
    })
    .from(evaluations)
    .where(
      completeOnly
        ? and(inArray(evaluations.sessionId, [...sessionIds]), eq(evaluations.status, 'complete'))
        : inArray(evaluations.sessionId, [...sessionIds]),
    );
  return latestEvaluationBySession(rows, completeOnly);
}

export type LatestEvaluation = {
  id: string;
  sessionId: string;
  status: string;
  createdAt: Date;
  overallScore: number | null;
  overallVerdict: string | null;
  summary: string | null;
  topFixes: unknown;
  rubricVersion: string;
};
