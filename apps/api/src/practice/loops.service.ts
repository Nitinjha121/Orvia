import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { loops, sessions, type Database } from '@orvia/db';
import {
  HANDOUT_MIN_MS, LOOP_TEMPLATES, MODE_SHORT_LABELS, createLoopSchema, loopDecision, loopProgress,
  loopStageSchema, type InterviewMode, type LoopStage, type LoopStageRound, type LoopTemplateId,
  type LoopView, type Verdict,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import { latestEvaluations } from '../question-bank/latest-evaluations';

type LoopRow = typeof loops.$inferSelect;

/**
 * Onsite loops: several rounds judged together.
 *
 * A stage is filled by the latest round started FOR it that ran long enough to
 * count (`HANDOUT_MIN_MS`, the rotation's floor), so a stage whose round died
 * in the first minute is simply run again. The decision is derived from the
 * stage rounds' latest complete reports and never stored.
 */
@Injectable()
export class LoopsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(userId: string, body: unknown): Promise<LoopView> {
    const { template } = createLoopSchema.parse(body);
    const stages: LoopStage[] = LOOP_TEMPLATES[template].stages.map((s) => ({ ...s }));
    const [row] = await this.db.insert(loops).values({ userId, template, stages }).returning();
    return (await this.views([row!], userId))[0]!;
  }

  async list(userId: string, limit = 10): Promise<LoopView[]> {
    const rows = await this.db
      .select()
      .from(loops)
      .where(eq(loops.userId, userId))
      .orderBy(desc(loops.startedAt))
      .limit(limit);
    return this.views(rows, userId);
  }

  async get(userId: string, id: string): Promise<LoopView> {
    const [row] = await this.db
      .select()
      .from(loops)
      .where(and(eq(loops.id, id), eq(loops.userId, userId)));
    if (!row) throw new NotFoundException(`no loop ${id}`);
    return (await this.views([row], userId))[0]!;
  }

  async abandon(userId: string, id: string): Promise<LoopView> {
    const [row] = await this.db
      .update(loops)
      .set({ abandonedAt: new Date() })
      .where(and(eq(loops.id, id), eq(loops.userId, userId), isNull(loops.abandonedAt)))
      .returning();
    if (!row) throw new NotFoundException(`no active loop ${id}`);
    return (await this.views([row], userId))[0]!;
  }

  /**
   * The stage a round being started for `loopId` fills — refused unless the
   * loop is this user's, still running, and next asks for exactly this mode.
   * Checked at START so a round can never land in the wrong stage.
   */
  async stageFor(userId: string, loopId: string, mode: InterviewMode): Promise<{ id: string; stage: number; of: number }> {
    const view = await this.get(userId, loopId).catch(() => {
      throw new BadRequestException('That onsite loop is not yours, or no longer exists.');
    });
    if (view.abandonedAt) throw new BadRequestException('That onsite loop was abandoned.');
    if (view.next === null) throw new BadRequestException('Every round of that loop has already been run.');
    const want = view.stages[view.next]!.mode;
    if (want !== mode) {
      throw new BadRequestException(
        `The next round of this loop is ${MODE_SHORT_LABELS[want]}, not ${MODE_SHORT_LABELS[mode]}.`,
      );
    }
    return { id: view.id, stage: view.next, of: view.stages.length };
  }

  private async views(rows: LoopRow[], userId: string): Promise<LoopView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const stageRows = await this.db
      .select({
        sessionId: sessions.id,
        loopId: sessions.loopId,
        stage: sessions.loopStage,
        mode: sessions.mode,
        status: sessions.status,
        durationMs: sessions.durationMs,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), inArray(sessions.loopId, ids), isNotNull(sessions.loopStage)));

    const sessionIds = stageRows.map((s) => s.sessionId);
    const [complete, latest] = await Promise.all([
      latestEvaluations(this.db, sessionIds),
      latestEvaluations(this.db, sessionIds, { completeOnly: false }),
    ]);

    return rows.map((row) => {
      const parsed = loopStageSchema.array().safeParse(row.stages);
      const stages = parsed.success ? parsed.data : [];
      const rounds: LoopStageRound[] = stageRows
        .filter((s) => s.loopId === row.id)
        .map((s) => ({
          sessionId: s.sessionId,
          stage: s.stage!,
          mode: s.mode,
          status: s.status,
          durationMs: s.durationMs,
          startedAt: s.startedAt.toISOString(),
          verdict: (complete.get(s.sessionId)?.overallVerdict as Verdict | null | undefined) ?? null,
          score: complete.get(s.sessionId)?.overallScore ?? null,
          evaluationStatus: latest.get(s.sessionId)?.status ?? null,
        }));
      const { filled, next } = loopProgress(stages, rounds, HANDOUT_MIN_MS);
      const { decision, reasons } = loopDecision(filled.map((f) => f?.verdict ?? null));
      const template = row.template as LoopTemplateId;
      return {
        id: row.id,
        template: row.template,
        label: LOOP_TEMPLATES[template]?.label ?? row.template,
        startedAt: row.startedAt.toISOString(),
        abandonedAt: row.abandonedAt?.toISOString() ?? null,
        stages: stages.map((s, i) => ({ ...s, round: filled[i] ?? null })),
        next,
        decision,
        reasons,
      };
    });
  }
}
