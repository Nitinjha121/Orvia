import { Injectable, Inject } from '@nestjs/common';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  sessions,
  questionOutcomes,
  dsaQuestions,
  systemDesignProblems,
  type Database,
} from '@orvia/db';
import {
  HANDOUT_MIN_MS,
  attemptsFromRounds,
  type PracticeAttempt,
  type ResolveAttempt,
  type ResolveHistory,
  type QuestionOutcomeKind,
  type SurpriseMode,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import { resolveDesignProblem } from './design-problem';
import { latestEvaluations } from './latest-evaluations';
import { readStoredConfig } from './stored-config';

export type { PracticeAttempt } from '@orvia/shared';

/**
 * Computes question handout history and outcome verdicts for practice rotations
 * across DSA, concepts, and system design modes, derived directly from session records.
 */
@Injectable()
export class PracticeRotationService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The rounds that can have handed a question out, newest first. */
  private handoutRounds(userId: string, mode: SurpriseMode) {
    return this.db
      .select({
        id: sessions.id,
        config: sessions.config,
        startedAt: sessions.startedAt,
        /** How far the interviewer was HEARD to get. See the third note on `attempted`. */
        currentQuestionIdx: sessions.currentQuestionIdx,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.mode, mode),
          /**
           * A drill re-asks a question the round already handed out, after its
           * report was read — its verdict must not decide the rotation.
           */
          eq(sessions.kind, 'round'),
          /**
           * A round counts as a handout on DURATION alone, never on status:
           * `session.stop` finalizes as `completed` however fast it arrives,
           * and a 751ms "completed" round was observed spending a question.
           */
          gte(sessions.durationMs, HANDOUT_MIN_MS),
        ),
      )
      .orderBy(desc(sessions.startedAt));
  }

  /**
   * Builds practice attempts for a mode. Constraints:
   * - Latest round outcome takes precedence.
   * - In-flight or pending evaluations stay retired until a verdict lands.
   * - Unreached questions in multi-question rounds are not counted as handed out.
   */
  async attempted(userId: string, mode: SurpriseMode): Promise<PracticeAttempt[]> {
    const rows = await this.handoutRounds(userId, mode);

    if (!rows.length) return [];

    /** Resolves system design problem IDs by problem ID or prompt text. */
    const designBank =
      mode === 'system_design'
        ? await this.db
            .select({
              id: systemDesignProblems.id,
              title: systemDesignProblems.title,
              prompt: systemDesignProblems.prompt,
            })
            .from(systemDesignProblems)
        : [];

    /**
     * Considers only the latest complete evaluation. Rounds without a complete
     * evaluation receive `verdicts: null` and remain retired.
     */
    const latest = await latestEvaluations(this.db, rows.map((r) => r.id));
    const evalIds = [...latest.values()].map((e) => e.id);
    const outcomeRows = evalIds.length
      ? await this.db
          .select({
            evaluationId: questionOutcomes.evaluationId,
            questionId: questionOutcomes.questionId,
            outcome: questionOutcomes.outcome,
          })
          .from(questionOutcomes)
          .where(inArray(questionOutcomes.evaluationId, evalIds))
      : [];

    const verdictsOf = new Map<string, Map<string, QuestionOutcomeKind>>();
    for (const o of outcomeRows) {
      const m = verdictsOf.get(o.evaluationId) ?? new Map<string, QuestionOutcomeKind>();
      m.set(o.questionId, o.outcome);
      verdictsOf.set(o.evaluationId, m);
    }

    return attemptsFromRounds(
      rows.map((row) => {
        const cfg = readStoredConfig(row.config);
        const evalId = latest.get(row.id)?.id;
        return {
          startedAt: row.startedAt.toISOString(),
          ids:
            mode === 'system_design'
              ? [resolveDesignProblem(cfg, designBank)].filter((id): id is string => !!id)
              : (cfg.questionIds ?? []),
          reachedIdx: row.currentQuestionIdx ?? 0,
          // A complete evaluation with no outcome rows (scored before the table
          // existed) is an empty map: no verdict, same as null for the draw.
          verdicts: evalId ? (verdictsOf.get(evalId) ?? new Map()) : null,
        };
      }),
    );
  }

  /**
   * Verdict history for DSA problems in the re-solve queue.
   * Includes only completed evaluations, omitting failed runs so problems do not stall.
   */
  async resolveHistory(userId: string): Promise<ResolveHistory> {
    const rows = await this.handoutRounds(userId, 'dsa');
    if (!rows.length) return { attempts: [], questions: [] };

    const ids = rows.map((r) => r.id);
    const latest = await latestEvaluations(this.db, ids);
    const newest = await latestEvaluations(this.db, ids, { completeOnly: false });
    const evalIds = [...latest.values()].map((e) => e.id);
    const outcomeRows = evalIds.length
      ? await this.db
          .select({
            evaluationId: questionOutcomes.evaluationId,
            questionId: questionOutcomes.questionId,
            outcome: questionOutcomes.outcome,
            reason: questionOutcomes.reason,
          })
          .from(questionOutcomes)
          .where(inArray(questionOutcomes.evaluationId, evalIds))
      : [];
    const byEval = new Map<string, typeof outcomeRows>();
    for (const o of outcomeRows) byEval.set(o.evaluationId, [...(byEval.get(o.evaluationId) ?? []), o]);

    const attempts: ResolveAttempt[] = [];
    for (const row of rows) {
      const startedAt = row.startedAt.toISOString();
      const done = latest.get(row.id);
      if (done) {
        for (const o of byEval.get(done.id) ?? []) {
          attempts.push({ questionId: o.questionId, sessionId: row.id, startedAt, outcome: o.outcome, reason: o.reason });
        }
        continue;
      }
      const status = newest.get(row.id)?.status;
      if (status !== 'pending' && status !== 'transcribing' && status !== 'evaluating') continue;
      const assigned = [...new Set(readStoredConfig(row.config).questionIds ?? [])];
      assigned.slice(0, (row.currentQuestionIdx ?? 0) + 1).forEach((questionId) =>
        attempts.push({ questionId, sessionId: row.id, startedAt, outcome: null, reason: null }),
      );
    }

    const slugs = [...new Set(attempts.map((a) => a.questionId))];
    const bank = slugs.length
      ? await this.db
          .select({ id: dsaQuestions.id, title: dsaQuestions.title, difficulty: dsaQuestions.difficulty, topics: dsaQuestions.topics })
          .from(dsaQuestions)
          .where(inArray(dsaQuestions.id, slugs))
      : [];
    return {
      attempts,
      questions: bank.map((q) => ({ ...q, topics: Array.isArray(q.topics) ? (q.topics as string[]) : [] })),
    };
  }
}
