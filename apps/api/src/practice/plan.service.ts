import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import {
  sessions, deliveryScores, speechMetrics, questionOutcomes, dsaQuestions, conceptQuestions,
  commitments, profiles, type Database,
} from '@orvia/db';
import {
  HANDOUT_MIN_MS, INTERVIEW_MODES, RUBRIC_VERSION, type InterviewMode, type PlanSummary, type Verdict,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import { latestEvaluations } from '../question-bank/latest-evaluations';
import { CommitmentsService } from './commitments.service';
import { LoopsService } from './loops.service';

/**
 * The facts behind the Plan page, and none of its conclusions.
 *
 * Readiness, the week, the recap and the records are all folded in the browser
 * by the pure rules in `@orvia/shared/plan`, because "this week" is the
 * READER's week and only the browser knows its calendar. Everything returned
 * here is either measured or the latest complete report's own number.
 */
@Injectable()
export class PlanService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly commitmentsSvc: CommitmentsService,
    private readonly loopsSvc: LoopsService,
  ) {}

  async summary(userId: string): Promise<PlanSummary> {
    const [profile] = await this.db
      .select({
        targetCompany: profiles.targetCompany,
        targetRole: profiles.targetRole,
        targetDate: profiles.targetDate,
        weeklyRounds: profiles.weeklyRounds,
        targetModes: profiles.targetModes,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId));

    const rows = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        kind: sessions.kind,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
      })
      .from(sessions)
      // The handout floor, as the rotation applies it: a round ended inside a
      // minute put nothing to anyone, and counting it made a 0.6s loop test
      // read as this week's behavioural round done.
      .where(and(eq(sessions.userId, userId), eq(sessions.status, 'completed'), gte(sessions.durationMs, HANDOUT_MIN_MS)))
      .orderBy(asc(sessions.startedAt));

    const ids = rows.map((r) => r.id);
    const latest = await latestEvaluations(this.db, ids);
    const evalIds = [...latest.values()].map((e) => e.id);

    const [dims, metrics, solved] = await Promise.all([
      evalIds.length
        ? this.db.select().from(deliveryScores).where(inArray(deliveryScores.evaluationId, evalIds))
        : Promise.resolve([]),
      ids.length
        ? this.db
            .select({ sessionId: speechMetrics.sessionId, fillerRate: speechMetrics.fillerRate, wordCount: speechMetrics.wordCount })
            .from(speechMetrics)
            .where(inArray(speechMetrics.sessionId, ids))
        : Promise.resolve([]),
      evalIds.length
        ? this.db
            .select({ evaluationId: questionOutcomes.evaluationId, questionId: questionOutcomes.questionId })
            .from(questionOutcomes)
            .where(and(inArray(questionOutcomes.evaluationId, evalIds), eq(questionOutcomes.outcome, 'solved')))
        : Promise.resolve([]),
    ]);

    const solvedIds = [...new Set(solved.map((s) => s.questionId))];
    const [dsaBank, conceptBank] = solvedIds.length
      ? await Promise.all([
          this.db.select({ id: dsaQuestions.id, title: dsaQuestions.title, difficulty: dsaQuestions.difficulty })
            .from(dsaQuestions).where(inArray(dsaQuestions.id, solvedIds)),
          this.db.select({ id: conceptQuestions.id, title: conceptQuestions.title, difficulty: conceptQuestions.difficulty })
            .from(conceptQuestions).where(inArray(conceptQuestions.id, solvedIds)),
        ])
      : [[], []];
    const bank = new Map([...dsaBank, ...conceptBank].map((q) => [q.id, q]));

    const rounds: PlanSummary['rounds'] = rows.map((r) => {
      const ev = latest.get(r.id);
      const mine = ev ? dims.filter((d) => d.evaluationId === ev.id) : [];
      const quoted = mine.filter((d) => !!d.evidenceQuote);
      const best = quoted.reduce<(typeof quoted)[number] | null>((a, b) => (!a || b.score > a.score ? b : a), null);
      const m = metrics.find((x) => x.sessionId === r.id);
      return {
        sessionId: r.id,
        mode: r.mode,
        kind: r.kind === 'drill' ? 'drill' : 'round',
        startedAt: r.startedAt.toISOString(),
        durationMs: r.durationMs,
        overallScore: ev?.overallScore ?? null,
        overallVerdict: (ev?.overallVerdict as Verdict | null | undefined) ?? null,
        rubricVersion: ev?.rubricVersion ?? null,
        fillerRate: m?.fillerRate ?? null,
        wordCount: m?.wordCount ?? null,
        delivery: Object.fromEntries(mine.map((d) => [d.dimension, d.score])),
        bestEvidence: best
          ? { dimension: best.dimension, score: best.score, quote: best.evidenceQuote!, atMs: best.evidenceAtMs }
          : null,
        solved: ev
          ? solved
              .filter((s) => s.evaluationId === ev.id)
              .map((s) => ({
                id: s.questionId,
                title: bank.get(s.questionId)?.title ?? s.questionId,
                difficulty: bank.get(s.questionId)?.difficulty ?? null,
              }))
          : [],
      };
    });

    const commitmentIds = (
      await this.db.select({ id: commitments.id }).from(commitments).where(eq(commitments.userId, userId))
    ).map((c) => c.id);
    const history = await this.commitmentsSvc.historyFor(userId, commitmentIds);
    const checks = [...history.values()].flat().map((h) => ({ startedAt: h.startedAt, result: h.result }));

    const targetModes = Array.isArray(profile?.targetModes)
      ? (profile.targetModes as unknown[]).filter((m): m is InterviewMode =>
          (INTERVIEW_MODES as readonly unknown[]).includes(m))
      : [];

    return {
      currentRubric: RUBRIC_VERSION,
      target: {
        targetCompany: profile?.targetCompany ?? null,
        targetRole: profile?.targetRole ?? null,
        targetDate: profile?.targetDate ?? null,
        weeklyRounds: profile?.weeklyRounds ?? 4,
        targetModes,
      },
      rounds,
      checks,
      loops: await this.loopsSvc.list(userId, 5),
    };
  }
}
