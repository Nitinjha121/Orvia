import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { commitments, evaluations, focusChecks, sessions, type Database } from '@orvia/db';
import {
  FOCUS_RESULTS, MAX_OPEN_COMMITMENTS, commitmentProgress,
  type CommitmentView, type FocusItem, type FocusResult,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import { latestEvaluations } from '../question-bank/latest-evaluations';

export const createCommitmentSchema = z.object({
  text: z.string().trim().min(5).max(400),
  /** The round whose report suggested it. Optional: a commitment can be your own words. */
  sourceSessionId: z.string().uuid().optional(),
});

/**
 * Fixes the candidate carries between rounds.
 *
 * Choosing one is the only thing stored; where it stands is derived every read
 * from the focus checks of the rounds that carried it, taking only each round's
 * latest COMPLETE report — so a re-run can move it, and a failed re-run cannot
 * blank it (the same rule the rotation follows for question outcomes).
 */
@Injectable()
export class CommitmentsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(userId: string): Promise<CommitmentView[]> {
    const rows = await this.db
      .select()
      .from(commitments)
      .where(eq(commitments.userId, userId))
      .orderBy(desc(commitments.createdAt));
    if (!rows.length) return [];

    const history = await this.historyFor(userId, rows.map((r) => r.id));
    return rows.map((r) => {
      const h = history.get(r.id) ?? [];
      const progress = commitmentProgress(h.map((x) => x.result));
      return {
        id: r.id,
        text: r.text,
        sourceSessionId: r.sourceSessionId,
        createdAt: r.createdAt.toISOString(),
        status: r.droppedAt ? 'dropped' : progress.status,
        progress,
        history: h,
      };
    });
  }

  /** What a new round carries: every commitment that is neither dropped nor met. */
  async focusFor(userId: string): Promise<FocusItem[]> {
    const open = (await this.list(userId)).filter((c) => c.status === 'open');
    // Oldest first, so the list on screen does not reshuffle as new ones arrive.
    return open
      .reverse()
      .slice(0, MAX_OPEN_COMMITMENTS)
      .map((c) => ({ key: c.id, text: c.text, source: 'commitment' as const }));
  }

  async create(userId: string, body: unknown): Promise<CommitmentView> {
    const input = createCommitmentSchema.parse(body);
    if (input.sourceSessionId) {
      const [owned] = await this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, input.sourceSessionId), eq(sessions.userId, userId)));
      if (!owned) throw new NotFoundException(`no session ${input.sourceSessionId}`);
    }

    const current = await this.list(userId);
    const open = current.filter((c) => c.status === 'open');
    // Committing twice to the same words is a double click, not a second goal.
    const same = open.find((c) => c.text.trim().toLowerCase() === input.text.toLowerCase());
    if (same) return same;
    if (open.length >= MAX_OPEN_COMMITMENTS) {
      throw new ConflictException(
        `You already have ${MAX_OPEN_COMMITMENTS} open commitments. Drop one on the Plan page first — ` +
          'more than three at once is a list, not a focus.',
      );
    }

    const [row] = await this.db
      .insert(commitments)
      .values({ userId, text: input.text, sourceSessionId: input.sourceSessionId ?? null })
      .returning();
    return {
      id: row!.id,
      text: row!.text,
      sourceSessionId: row!.sourceSessionId,
      createdAt: row!.createdAt.toISOString(),
      status: 'open',
      progress: commitmentProgress([]),
      history: [],
    };
  }

  async drop(userId: string, id: string): Promise<{ id: string }> {
    const [row] = await this.db
      .update(commitments)
      .set({ droppedAt: new Date() })
      .where(and(eq(commitments.id, id), eq(commitments.userId, userId), isNull(commitments.droppedAt)))
      .returning({ id: commitments.id });
    if (!row) throw new NotFoundException(`no open commitment ${id}`);
    return row;
  }

  /**
   * Every verdict on these commitments, oldest round first, one per round.
   *
   * Scoped through `sessions.user_id` as well as by key: a key is only a uuid,
   * and the check rows carry no owner of their own.
   */
  async historyFor(
    userId: string,
    ids: string[],
  ): Promise<Map<string, { sessionId: string; startedAt: string; result: FocusResult }[]>> {
    const out = new Map<string, { sessionId: string; startedAt: string; result: FocusResult }[]>();
    if (!ids.length) return out;

    const rows = await this.db
      .select({
        key: focusChecks.key,
        result: focusChecks.result,
        evaluationId: focusChecks.evaluationId,
        sessionId: evaluations.sessionId,
        startedAt: sessions.startedAt,
      })
      .from(focusChecks)
      .innerJoin(evaluations, eq(evaluations.id, focusChecks.evaluationId))
      .innerJoin(sessions, eq(sessions.id, evaluations.sessionId))
      .where(and(eq(sessions.userId, userId), inArray(focusChecks.key, ids)))
      .orderBy(asc(sessions.startedAt));

    // Against EVERY evaluation of those rounds, not only the ones with checks:
    // a newer complete report that judged nothing still speaks for its round.
    const latest = await latestEvaluations(this.db, [...new Set(rows.map((r) => r.sessionId))]);
    const speaking = new Set([...latest.values()].map((e) => e.id));

    for (const r of rows) {
      if (!speaking.has(r.evaluationId)) continue;
      if (!(FOCUS_RESULTS as readonly string[]).includes(r.result)) continue;
      const list = out.get(r.key) ?? [];
      list.push({ sessionId: r.sessionId, startedAt: r.startedAt.toISOString(), result: r.result as FocusResult });
      out.set(r.key, list);
    }
    return out;
  }
}
