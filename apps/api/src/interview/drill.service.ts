import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  sessions, questionEvaluations, deliveryScores, dsaQuestions, conceptQuestions, behaviouralQuestions,
  type Database,
} from '@orvia/db';
import {
  DRILL_MINUTES, DRILL_MINUTE_CHOICES, deriveMoments, startSessionSchema,
  type BankEntry, type DrillRecord, type DrillRef, type FocusItem, type InterviewMode, type Moment,
  type MomentsView, type StartSessionInput, type Verdict,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import { latestEvaluations } from '../question-bank/latest-evaluations';
import { drillAttempts } from '../evaluation/drill-attempts';
import { readRoundConfig } from '../evaluation/round-config';
import { ReplayService } from './replay.service';

/** A drill, resolved server-side and ready for `SessionService.create`. */
export type ResolvedDrill = {
  input: StartSessionInput;
  record: DrillRecord;
  /** True when the round's bank list was cut down to the retried question. */
  narrowed: boolean;
  focus: FocusItem[];
  /** The DSA rows the editor needs for its starter skeleton. */
  questions: unknown[];
};

/**
 * Moments of a finished round, and the drills that retry them.
 * Rebuilds drill setup from the source round and latest complete report.
 */
@Injectable()
export class DrillService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly replay: ReplayService,
  ) {}

  async moments(userId: string, sessionId: string): Promise<MomentsView> {
    const source = await this.source(userId, sessionId);
    if (source.kind === 'drill') {
      return {
        sessionId,
        offersMoments: false,
        reason: 'This is a drill. Retry it again from the comparison above — its moment belongs to the round it came from.',
        moments: [],
      };
    }
    const derived = await this.derive(source);
    if (!derived) {
      return { sessionId, offersMoments: true, reason: 'There is no finished report for this round yet.', moments: [] };
    }
    const attempts = await drillAttempts(this.db, userId, sessionId);
    const moments = derived.moments.map((m) => ({
      ...m,
      attempts: attempts.filter((a) => a.momentId === m.id),
    }));
    return {
      sessionId,
      offersMoments: true,
      reason: moments.length ? null : 'Nothing in this report scored low enough to be worth retrying on its own.',
      moments,
    };
  }

  /**
   * Everything a drill needs, from a reference the browser sent.
   *
   * `minutes` is honoured only when it is one of `DRILL_MINUTE_CHOICES`, so a
   * drill is always short; anything else falls back to the mode's default.
   */
  async resolve(userId: string, ref: DrillRef, minutes?: number): Promise<ResolvedDrill> {
    const source = await this.source(userId, ref.sessionId);
    if (source.kind === 'drill') {
      throw new BadRequestException('A drill cannot be drilled. Retry the moment from the round it came from.');
    }
    const derived = await this.derive(source);
    if (!derived) throw new BadRequestException('That round has no finished report to retry a moment from.');
    const moment = derived.moments.find((m) => m.id === ref.momentId);
    if (!moment) {
      throw new NotFoundException(
        'That moment is no longer in the round\'s report — it may have been re-scored since. Open the report again.',
      );
    }
    if (moment.unavailable || !moment.question) {
      throw new BadRequestException(moment.unavailable ?? 'That moment has no question to put to you again.');
    }

    const plan = await this.replay.plan(userId, ref.sessionId);
    const config = { ...plan.input.config } as StartSessionInput['config'];
    let questions = plan.questions;
    let narrowed = false;
    if (moment.questionId && 'questionIds' in config) {
      if (config.questionIds.includes(moment.questionId)) {
        config.questionIds = [moment.questionId];
        questions = questions.filter((q) => (q as { id?: string }).id === moment.questionId);
        narrowed = true;
      } else if (config.mode === 'dsa') {
        throw new BadRequestException('That problem has since left the question bank, so it cannot be drilled.');
      }
    }

    const choice = (DRILL_MINUTE_CHOICES as readonly number[]).includes(minutes ?? -1)
      ? minutes!
      : DRILL_MINUTES[source.mode];
    const input = startSessionSchema.parse({
      config,
      options: { ...plan.input.options, durationMinutes: choice },
    });

    const record: DrillRecord = {
      sourceSessionId: ref.sessionId,
      sourceEvaluationId: derived.evaluationId,
      momentId: moment.id,
      kind: moment.kind,
      dimension: moment.dimension,
      label: moment.label,
      question: moment.question,
      focus: moment.focus,
      advice: moment.advice,
      before: moment.before,
    };
    return {
      input,
      record,
      narrowed,
      focus: moment.focus.map((text, i) => ({ key: `drill:${i + 1}`, text, source: 'drill' as const })),
      questions,
    };
  }

  /** What the report page needs to start a drill: the resolved setup, minus nothing. */
  async plan(userId: string, sessionId: string, momentId: string, minutes?: number) {
    const d = await this.resolve(userId, { sessionId, momentId }, minutes);
    return {
      input: { ...d.input, drill: { sessionId, momentId } },
      questions: d.questions,
      focus: d.focus,
      drill: d.record,
    };
  }

  private async source(userId: string, sessionId: string) {
    const [row] = await this.db
      .select({ id: sessions.id, mode: sessions.mode, kind: sessions.kind, config: sessions.config })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    if (!row) throw new NotFoundException(`no session ${sessionId}`);
    return row;
  }

  private async derive(source: { id: string; mode: InterviewMode; config: unknown }): Promise<{ evaluationId: string; moments: Moment[] } | null> {
    const ev = (await latestEvaluations(this.db, [source.id])).get(source.id);
    if (!ev) return null;

    const [qs, ds] = await Promise.all([
      this.db.select().from(questionEvaluations)
        .where(eq(questionEvaluations.evaluationId, ev.id)).orderBy(asc(questionEvaluations.idx)),
      this.db.select().from(deliveryScores).where(eq(deliveryScores.evaluationId, ev.id)),
    ]);

    return {
      evaluationId: ev.id,
      moments: deriveMoments({
        mode: source.mode,
        questions: qs.map((q) => ({
          id: q.id,
          question: q.question,
          score: q.score,
          verdict: q.verdict as Verdict,
          whatWasMissing: (q.whatWasMissing as string[] | null) ?? [],
          howToImprove: q.howToImprove,
          startMs: q.startMs,
        })),
        delivery: ds.map((d) => ({
          dimension: d.dimension,
          score: d.score,
          assessment: d.assessment,
          evidenceQuote: d.evidenceQuote,
          evidenceAtMs: d.evidenceAtMs,
        })),
        bank: await this.bankTitles(source.mode, readRoundConfig(source.config).questionIds ?? []),
      }),
    };
  }

  /** The round's bank rows in ROUND order, for matching a report question to one of them. */
  private async bankTitles(mode: InterviewMode, ids: string[]): Promise<BankEntry[]> {
    if (!ids.length) return [];
    const table =
      mode === 'dsa' ? dsaQuestions : mode === 'concepts' ? conceptQuestions : mode === 'behavioural' ? behaviouralQuestions : null;
    if (!table) return [];
    const rows = await this.db
      .select({ id: table.id, title: table.title, statement: table.prompt })
      .from(table)
      .where(inArray(table.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is { id: string; title: string; statement: string } => !!r);
  }
}
