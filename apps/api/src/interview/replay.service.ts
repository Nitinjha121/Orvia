import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  sessions,
  dsaQuestions,
  conceptQuestions,
  behaviouralQuestions,
  hrScenarios,
  type Database,
} from '@orvia/db';
import { startSessionSchema, type DrillRecord } from '@orvia/shared';
import { DB } from '../db/db.module';

/**
 * A repeat is a new session with the original setup (questions, voice, length,
 * bar, persona, and mode fields). Dynamic components such as model selection,
 * rebuilt system instructions, and pause tolerances are resolved afresh.
 */
@Injectable()
export class ReplayService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async plan(userId: string, id: string) {
    const [row] = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        config: sessions.config,
        options: sessions.options,
        kind: sessions.kind,
        drill: sessions.drill,
      })
      .from(sessions)
      // Scoped by user as well as id: an id alone must never be able to start a
      // round built from another account's setup — an HR config carries that
      // account's salary numbers.
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
    if (!row) throw new NotFoundException(`no session ${id}`);

    const cfg: Record<string, unknown> = { ...(row.config as Record<string, unknown>) };
    const storedIds = Array.isArray(cfg.questionIds)
      ? cfg.questionIds.filter((x): x is string => typeof x === 'string')
      : [];

    // IDs no longer in the question bank are dropped and reported back to the client.
    const missingQuestionIds: string[] = [];

    /** The bank rows, so the editor can open on the same starter skeleton. */
    let questions: unknown[] = [];

    if (cfg.mode === 'dsa') {
      const ids = storedIds;
      const rows = ids.length
        ? await this.db
            .select({
              id: dsaQuestions.id,
              title: dsaQuestions.title,
              difficulty: dsaQuestions.difficulty,
              topics: dsaQuestions.topics,
              prompt: dsaQuestions.prompt,
              // Include editor skeletons and practice links for problem setup.
              codeSnippets: dsaQuestions.codeSnippets,
              practiceUrl: dsaQuestions.practiceUrl,
              leetcodeId: dsaQuestions.leetcodeId,
              url: dsaQuestions.url,
            })
            .from(dsaQuestions)
            .where(inArray(dsaQuestions.id, ids))
        : [];
      const byId = new Map(rows.map((q) => [q.id, q]));
      // The candidate's SELECTION order, for the reason `SessionService.create`
      // reorders: the prompt numbers these aloud and the tabs must agree.
      questions = ids.map((qid) => byId.get(qid)).filter((q) => !!q);
      missingQuestionIds.push(...ids.filter((qid) => !byId.has(qid)));
      cfg.questionIds = ids.filter((qid) => byId.has(qid));
    } else if (cfg.mode === 'concepts' || cfg.mode === 'behavioural') {
      const ids = storedIds;
      const rows = !ids.length
        ? []
        : cfg.mode === 'concepts'
          ? await this.db
              .select({ id: conceptQuestions.id })
              .from(conceptQuestions)
              .where(inArray(conceptQuestions.id, ids))
          : await this.db
              .select({ id: behaviouralQuestions.id })
              .from(behaviouralQuestions)
              .where(inArray(behaviouralQuestions.id, ids));
      const alive = new Set(rows.map((q) => q.id));
      missingQuestionIds.push(...ids.filter((qid) => !alive.has(qid)));
      cfg.questionIds = ids.filter((qid) => alive.has(qid));
    } else if (cfg.mode === 'hr') {
      // Fatal rather than dropped: the beats ARE the round, and one without
      // them is a friendly chat about money.
      const [scenario] = await this.db
        .select({ id: hrScenarios.id })
        .from(hrScenarios)
        .where(eq(hrScenarios.id, String(cfg.scenarioId ?? '')));
      if (!scenario) {
        throw new BadRequestException(
          `this round's HR scenario (${String(cfg.scenarioId)}) is no longer in the bank, so it cannot be repeated`,
        );
      }
    }

    // Parsed LAST, after pruning, so a stale config is a readable 400 here and
    // not a dead WebSocket after the microphone was asked for.
    const parsed = startSessionSchema.safeParse({ config: cfg, options: row.options });
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new BadRequestException(
        missingQuestionIds.length && Array.isArray(cfg.questionIds) && cfg.questionIds.length === 0
          ? `none of this round's questions are in the bank any more (${missingQuestionIds.join(', ')})`
          : `this round's setup can no longer be started — ${why}`,
      );
    }

    // Repeating a drill retries the same MOMENT again, not a free-standing
    // one-question round: the server re-resolves the drill from its source at
    // start, so the focus and the "before" stay the moment's own.
    const drill = row.kind === 'drill' ? (row.drill as DrillRecord | null) : null;
    const input = drill
      ? { ...parsed.data, drill: { sessionId: drill.sourceSessionId, momentId: drill.momentId } }
      : parsed.data;

    return { sessionId: row.id, input, questions, missingQuestionIds };
  }
}
