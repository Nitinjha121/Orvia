import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  sessions,
  evaluations,
  dsaQuestions,
  systemDesignProblems,
  conceptQuestions,
  behaviouralQuestions,
  hrScenarios,
  type Database,
} from '@orvia/db';
import type { DrillRecord } from '@orvia/shared';
import { DB } from '../db/db.module';
import { resolveDesignProblem } from '../question-bank/design-problem';
import { SessionService } from './session.service';

/** How many rounds the history page shows. */
const HISTORY_LIMIT = 50;

/** What a round was about, as the history list renders it. */
type RoundQuestion = { id: string; title: string; difficulty: string | null };

/** The mode-specific shape of `sessions.config`, as far as history cares. */
type StoredConfig = {
  mode?: string;
  questionIds?: string[];
  problem?: string;
  problemId?: string;
  scenarioId?: string;
};

/**
 * Reads past rounds for history and report displays.
 * All queries are strictly scoped by userId.
 */
@Injectable()
export class SessionHistoryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sessionSvc: SessionService,
  ) {}

  async list(userId: string) {
    const rows = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        status: sessions.status,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
        model: sessions.model,
        config: sessions.config,
        kind: sessions.kind,
        drill: sessions.drill,
        loopId: sessions.loopId,
        loopStage: sessions.loopStage,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.startedAt))
      .limit(HISTORY_LIMIT);

    const latestEval = await this.latestEvaluations(rows.map((r) => r.id));
    const titles = await this.resolveTitles(rows.map((r) => r.config as StoredConfig));

    return rows.map((r) => {
      const ev = latestEval.get(r.id);
      return {
        id: r.id,
        mode: r.mode,
        status: r.status,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        model: r.model,
        questions: titles(r.config as StoredConfig),
        // Only a completed evaluation carries a score worth showing; a pending
        // or failed one shows its status instead of a misleading null score.
        overallScore: ev?.status === 'complete' ? ev.score : null,
        overallVerdict: ev?.status === 'complete' ? ev.verdict : null,
        evaluationStatus: ev?.status ?? null,
        // Listed, but labelled: a drill is five minutes on one moment, and a
        // history that did not say so would read it as a very short round.
        kind: r.kind === 'drill' ? 'drill' : 'round',
        drill: r.kind === 'drill' && r.drill
          ? {
              label: (r.drill as DrillRecord).label,
              sourceSessionId: (r.drill as DrillRecord).sourceSessionId,
            }
          : null,
        loop: r.loopId && r.loopStage !== null ? { id: r.loopId, stage: r.loopStage } : null,
      };
    });
  }

  /**
   * Detail payload for the report page and replay planning.
   * Excludes session handles and internal audio file paths.
   */
  async detail(userId: string, id: string) {
    const [row] = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        status: sessions.status,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        durationMs: sessions.durationMs,
        endReason: sessions.endReason,
        model: sessions.model,
        voice: sessions.voice,
        config: sessions.config,
        options: sessions.options,
      })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
    if (!row) throw new NotFoundException(`no session ${id}`);
    return { ...row, turns: await this.sessionSvc.getTranscript(id) };
  }

  /**
   * Newest evaluation per session.
   *
   * Fetched separately rather than joined. Re-running an evaluation INSERTS a
   * new row rather than replacing the old one, so a join would emit one history
   * entry per attempt and `limit(50)` would count attempts instead of rounds.
   */
  private async latestEvaluations(sessionIds: string[]) {
    const out = new Map<string, { score: number | null; verdict: string | null; status: string }>();
    if (!sessionIds.length) return out;

    const evs = await this.db
      .select({
        sessionId: evaluations.sessionId,
        overallScore: evaluations.overallScore,
        overallVerdict: evaluations.overallVerdict,
        status: evaluations.status,
        createdAt: evaluations.createdAt,
      })
      .from(evaluations)
      .where(inArray(evaluations.sessionId, sessionIds))
      .orderBy(asc(evaluations.createdAt));

    // Ascending, so the last write for a session is the newest.
    for (const e of evs) {
      out.set(e.sessionId, { score: e.overallScore, verdict: e.overallVerdict, status: e.status });
    }
    return out;
  }

  /**
   * Resolves problem and question titles from question banks in a single batch query.
   */
  private async resolveTitles(configs: StoredConfig[]) {
    const idsFor = (mode: string) => [
      ...new Set(configs.flatMap((cfg) => (cfg.mode === mode ? (cfg.questionIds ?? []) : []))),
    ];
    const dsaIds = idsFor('dsa');
    const conceptIds = idsFor('concepts');
    const behaviouralIds = idsFor('behavioural');
    const scenarioIds = [
      ...new Set(
        configs.flatMap((cfg) => (cfg.mode === 'hr' && cfg.scenarioId ? [cfg.scenarioId] : [])),
      ),
    ];

    const [bank, designProblems, conceptBank, behaviouralBank, scenarioBank] = await Promise.all([
      dsaIds.length
        ? this.db
            .select({
              id: dsaQuestions.id,
              title: dsaQuestions.title,
              difficulty: dsaQuestions.difficulty,
            })
            .from(dsaQuestions)
            .where(inArray(dsaQuestions.id, dsaIds))
        : Promise.resolve([]),
      configs.some((cfg) => cfg.mode === 'system_design')
        ? this.db
            .select({
              id: systemDesignProblems.id,
              title: systemDesignProblems.title,
              prompt: systemDesignProblems.prompt,
            })
            .from(systemDesignProblems)
        : Promise.resolve([]),
      conceptIds.length
        ? this.db
            .select({
              id: conceptQuestions.id,
              title: conceptQuestions.title,
              difficulty: conceptQuestions.difficulty,
            })
            .from(conceptQuestions)
            .where(inArray(conceptQuestions.id, conceptIds))
        : Promise.resolve([]),
      behaviouralIds.length
        ? this.db
            .select({ id: behaviouralQuestions.id, title: behaviouralQuestions.title })
            .from(behaviouralQuestions)
            .where(inArray(behaviouralQuestions.id, behaviouralIds))
        : Promise.resolve([]),
      scenarioIds.length
        ? this.db
            .select({ id: hrScenarios.id, title: hrScenarios.title })
            .from(hrScenarios)
            .where(inArray(hrScenarios.id, scenarioIds))
        : Promise.resolve([]),
    ]);

    const byId = new Map(bank.map((q) => [q.id, q]));
    const conceptById = new Map(conceptBank.map((q) => [q.id, q]));
    const behaviouralById = new Map(behaviouralBank.map((q) => [q.id, q]));
    const scenarioById = new Map(scenarioBank.map((q) => [q.id, q]));

    return (cfg: StoredConfig): RoundQuestion[] => {
      // Ordered as the round was configured, not as the database returned them.
      // A slug that has since left the bank still names the round better than
      // nothing does, so it falls back to the slug itself.
      if (cfg.mode === 'dsa') {
        return (cfg.questionIds ?? []).map((id) => ({
          id,
          title: byId.get(id)?.title ?? id,
          difficulty: byId.get(id)?.difficulty ?? null,
        }));
      }
      if (cfg.mode === 'concepts') {
        return (cfg.questionIds ?? []).map((id) => ({
          id,
          title: conceptById.get(id)?.title ?? id,
          difficulty: conceptById.get(id)?.difficulty ?? null,
        }));
      }
      if (cfg.mode === 'behavioural') {
        return (cfg.questionIds ?? []).map((id) => ({
          id,
          title: behaviouralById.get(id)?.title ?? id,
          difficulty: null,
        }));
      }
      if (cfg.mode === 'hr' && cfg.scenarioId) {
        return [
          {
            id: cfg.scenarioId,
            title: scenarioById.get(cfg.scenarioId)?.title ?? cfg.scenarioId,
            difficulty: null,
          },
        ];
      }
      if (cfg.mode === 'system_design' && (cfg.problemId || cfg.problem)) {
        // Same resolution the rotation uses: the id when the round recorded
        // one, and the prompt text for every round that predates the field.
        const match = designProblems.find((p) => p.id === resolveDesignProblem(cfg, designProblems));
        return [
          {
            id: match?.id ?? 'system-design',
            title: match?.title ?? 'System design',
            difficulty: null,
          },
        ];
      }
      return [];
    };
  }
}
