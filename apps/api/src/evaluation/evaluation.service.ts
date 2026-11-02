import { Injectable, Inject, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { GoogleGenAI } from '@google/genai';
import {
  MODELS, RUBRIC_VERSION, DELIVERY_DIMENSION_IDS, isCodeLanguage,
  QUESTION_OUTCOMES, FOCUS_RESULTS, guardEventSchema, focusItemSchema,
  type QuestionOutcomeKind, type QuestionOutcome,
  type CodeSnippets, type ComplexityAxis, type EvaluationDegraded, type EvaluationView,
  type GuardEvent, type InterviewMode, type NoEvaluation, type SpeechMetrics,
  type FocusCheck, type FocusItem, type FocusResult, type DrillRecord, type DrillView,
  latestEvaluationBySession,
} from '@orvia/shared';
import {
  sessions, turns, contextSnapshots, evaluations, questionEvaluations, questionOutcomes,
  deliveryScores, speechMetrics, dsaQuestions, systemDesignProblems, focusChecks,
  conceptQuestions, behaviouralQuestions, hrScenarios,
  verbatimTranscripts,
  type Database,
} from '@orvia/db';
import { DB } from '../db/db.module';
import { ENV, type Env } from '../config/env';
import { ArchiveService } from '../storage/archive.service';
import { StorageService } from '../storage/storage.service';
import { ModelAvailabilityService } from '../gemini/model-availability.service';
import { GeminiEvaluatorProvider } from './providers/gemini.provider';

import type { EvaluatorProvider, EvaluatorResult, AudioPayload } from './providers/types';
import { computeSpeechMetrics, VERBATIM_MIN_COVERAGE } from './metrics';
import { TranscriptionService } from './transcription.service';
import { analyzeWav } from './audio-analysis';
import { align, locateAsked, locateQuote, type Alignment, type TurnLike } from './alignment';
import type { StallRecord } from '../interview/session.service';
import { buildEvaluatorPrompt, type EvaluationInput } from './rubric.prompt';
import { CodeCheckService, type CodeCheck } from './code-check.service';
import { sanitiseSummary, sanitiseTopFixes } from './interviewer-blame';
import { readRoundConfig, readRoundOptions, OPTION_DEFAULTS, type RoundConfig } from './round-config';
import { drillAfter, drillAttempts } from './drill-attempts';

const run = promisify(execFile);

/**
 * The largest inline payload sent to the evaluator. A 30.5-minute WAV (about
 * 58MB) has been heard at this size; nothing larger has been tried, so it is a
 * measured ceiling rather than the provider's documented one.
 */
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;

/**
 * Audio exceeding MAX_AUDIO_BYTES is re-encoded to 32kbps MP3 to fit within model
 * limits rather than falling back to transcript-only evaluation.
 * Lossy compression is used here only for model audio ingestion; metrics calculations
 * and permanent archive retain lossless audio.
 */
const EVALUATOR_AUDIO_KBPS = 32;

/**
 * Filters turns whose text is the interviewer imitating injected system notes.
 * Evaluator prompts must not ingest these turns as they resemble system instructions.
 */
const SYSTEM_NOTE_LEAK = /\[SYSTEM NOTE/i;

/**
 * How old a non-terminal evaluation must be before a boot reclaims it.
 * A generous threshold ensures active in-flight transcriptions from concurrent
 * processes or slower runs are not erroneously marked failed.
 */
const ORPHAN_AFTER_MS = 60 * 60_000;

type SessionRow = typeof sessions.$inferSelect;
type TurnRow = typeof turns.$inferSelect;
type Writer = Pick<Database, 'insert' | 'update'>;
type BankEntry = { id: string; title: string; difficulty: string; url: string | null };
type VerbatimPass = {
  text: string | null;
  model: string | null;
  segments: { startMs: number; endMs: number; text: string }[];
  /** Why there is no verbatim transcript, for the report. Null when there is one. */
  failure: string | null;
};

/** A stored `sessions.focus` that does not parse is treated as none, never half-read. */
export function readFocus(value: unknown): FocusItem[] {
  const parsed = focusItemSchema.array().safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** A stored `guard_events` value that does not parse is treated as none. */
export function readGuardEvents(value: unknown): GuardEvent[] {
  const parsed = guardEventSchema.array().safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * Interviewer turns flagged by live guards as premature or backward readings
 * are excluded from question start timestamps so only actual begins are counted.
 */
function flaggedReading(events: GuardEvent[]): (t: TurnLike) => boolean {
  const flagged = events.filter((e) => e.kind === 'premature_advance' || e.kind === 'scope_backward');
  return (t) => flagged.some((e) => e.atMs >= t.startMs - 2000 && e.atMs <= (t.endMs ?? t.startMs) + 10_000);
}

/** When each report question was asked, measured from the turns, in the report's order. */
export function measureAskedAt(
  questions: { question: string }[],
  turns: TurnLike[],
  guardEvents: GuardEvent[],
  durationMs: number | null,
): (number | null)[] {
  const skip = flaggedReading(guardEvents);
  const out: (number | null)[] = [];
  let floor = 0;
  for (const q of questions) {
    const at = locateAsked(q.question, turns, floor, skip) ?? locateAsked(q.question, turns, floor);
    const kept = at !== null && (durationMs === null || at <= durationMs) ? at : null;
    out.push(kept);
    if (kept !== null) floor = kept;
  }
  return out;
}

/**
 * Which evaluation the report shows. A failed re-run must not hide a report
 * that completed before it; an in-flight one is shown, because the report
 * screen polls until the shown row is terminal and would otherwise never pick
 * up the re-run it just asked for.
 */
export function pickShownEvaluation<T extends { status: string }>(
  latest: T,
  lastComplete: T | null,
): { shown: T; superseded: T | null } {
  if (latest.status === 'failed' && lastComplete) return { shown: lastComplete, superseded: latest };
  return { shown: latest, superseded: null };
}

/**
 * How an `aborted` round ended, for the evaluator. `client_disconnected` is the
 * gateway's own reason for a dropped or abandoned socket; every other aborted
 * round was closed by the API stopping, gracefully or by the boot sweep.
 */
export function cutShortBy(session: Pick<SessionRow, 'status' | 'endReason'>): 'connection' | 'server' | null {
  if (session.status !== 'aborted') return null;
  return session.endReason === 'client_disconnected' ? 'connection' : 'server';
}

@Injectable()
export class EvaluationService implements OnModuleInit {
  private readonly log = new Logger(EvaluationService.name);
  private readonly ai: GoogleGenAI;
  /** Guards against a double-submit kicking off two evaluations for one session. */
  private readonly running = new Set<string>();
  /**
   * Rounds whose socket THIS process still holds, told by the gateway. A `live`
   * row in here is closing or still running and will settle; one outside it was
   * orphaned by a process that died, and waiting on it would spin for hours.
   * Measured: the browser shows the end screen the moment its socket drops, and
   * its first poll read the row before teardown had finalized it — "still in
   * progress", pending false — so polling stopped and the re-run never appeared.
   */
  private readonly openHere = new Set<string>();

  roundOpened(sessionId: string) {
    this.openHere.add(sessionId);
  }

  roundClosed(sessionId: string) {
    this.openHere.delete(sessionId);
  }
  private readonly provider: EvaluatorProvider;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: Env,
    private readonly availability: ModelAvailabilityService,
    private readonly transcription: TranscriptionService,
    private readonly codeCheck: CodeCheckService,
    private readonly archive: ArchiveService,
    private readonly storage: StorageService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.provider = new GeminiEvaluatorProvider(this.ai, this.availability);
  }

  /**
   * Reclaims evaluations orphaned by server restarts. Rows older than
   * ORPHAN_AFTER_MS still marked in-flight are transitioned to `failed` so
   * the client sees a retry option rather than spinning indefinitely.
   */
  async onModuleInit() {
    const reclaimed = await this.db
      .update(evaluations)
      .set({
        status: 'failed',
        error: 'the API restarted while this evaluation was running — press Try again to re-run it',
      })
      .where(
        and(
          inArray(evaluations.status, ['pending', 'transcribing', 'evaluating']),
          lt(evaluations.createdAt, new Date(Date.now() - ORPHAN_AFTER_MS)),
        ),
      )
      .returning({ sessionId: evaluations.sessionId });

    if (reclaimed.length) {
      this.log.warn(
        `reclaimed ${reclaimed.length} evaluation(s) orphaned by a restart: ` +
          reclaimed.map((r) => r.sessionId).join(', '),
      );
    }

    await this.seedArchiveUsage();
  }

  /**
   * Moves a scored round's recordings to R2 and frees the local WAVs.
   *
   * Deliberately swallows its own errors. Every failure mode here — R2 down,
   * budget reached, ffmpeg missing — leaves the recordings exactly where they
   * were, which is the state the app worked in before archiving existed.
   */
  private async archiveSession(sessionId: string) {
    if (!this.storage.isEnabled()) return;
    try {
      const [session] = await this.db
        .select({
          audioPath: sessions.audioPath,
          aiAudioPath: sessions.aiAudioPath,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      if (!session || session.archivedAt) return;

      // Stamped before the WAVs are deleted, never after: a crash in between
      // must not leave the recordings gone with `archived_at` null.
      await this.archive.archiveSession(sessionId, session, {
        beforeDelete: async (total) => {
          await this.db
            .update(sessions)
            .set({ archivedAt: new Date(), archiveBytes: total })
            .where(eq(sessions.id, sessionId));
        },
      });
    } catch (e) {
      this.log.warn(`session ${sessionId}: archiving failed, recordings kept locally — ${(e as Error).message}`);
    }
  }

  /**
   * Seeds the free-tier budget from what we have already uploaded, rather than
   * listing the bucket — a list of every object on every boot spends Class A
   * operations to learn something the database already knows.
   */
  private async seedArchiveUsage() {
    if (!this.storage.isEnabled()) return;
    const rows = await this.db
      .select({ bytes: sessions.archiveBytes })
      .from(sessions)
      .where(isNotNull(sessions.archivedAt));
    const total = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
    this.storage.setUsedBytes(total);
    const u = this.storage.usage();
    const line =
      `R2 archive: ${(total / 1024 ** 2).toFixed(1)}MB across ${rows.length} rounds ` +
      `(${(u.fraction * 100).toFixed(1)}% of the free tier)`;
    if (u.full) this.log.error(`${line} — AT THE CEILING, new rounds will stay on local disk`);
    else if (u.warn) this.log.warn(`${line} — past half, consider pruning old rounds`);
    else this.log.log(line);
  }

  /** Surfaced on /api/health so it is obvious which fallbacks are actually wired. */
  providerStatus() {
    return [{ name: this.provider.name, hearsAudio: this.provider.supportsAudio }];
  }

  /**
   * Kicks off evaluation asynchronously. Resolves once the new `evaluations`
   * row exists (before background processing finishes) so subsequent client
   * polling immediately detects the in-progress evaluation.
   */
  enqueue(sessionId: string): Promise<'started' | 'already_running'> {
    if (this.running.has(sessionId)) return Promise.resolve('already_running');
    this.running.add(sessionId);
    const started = this.begin(sessionId);
    void started
      .then(({ session, evalId }) => this.run(session, evalId))
      // Archiving is the LAST thing and only on success: it deletes the local
      // WAVs, and a round whose report failed still has to be re-runnable from
      // whatever is on disk. Its own failure must never fail the evaluation —
      // the report is the product, the archive is housekeeping.
      .then(() => this.archiveSession(sessionId))
      .catch((e) => this.log.error(`evaluation ${sessionId} failed: ${(e as Error).message}`))
      .finally(() => this.running.delete(sessionId));
    return started.then(() => 'started' as const);
  }

  /**
   * Determines why a session lacks an evaluation report and whether a manual
   * re-run can be offered (e.g. aborted rounds with sufficient candidate speech
   * or completed rounds whose evaluation was never queued).
   */
  async describeMissing(sessionId: string): Promise<NoEvaluation> {
    if (this.running.has(sessionId)) {
      return { status: 'none', pending: true, reason: null, evaluable: true };
    }

    const [session] = await this.db
      .select({ status: sessions.status, durationMs: sessions.durationMs, audioPath: sessions.audioPath })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) {
      return { status: 'none', pending: false, reason: 'This round no longer exists.', evaluable: false };
    }

    const final = (reason: string, evaluable = false): NoEvaluation => ({
      status: 'none', pending: false, reason, evaluable,
    });

    if (session.status === 'live') {
      if (this.openHere.has(sessionId)) return { status: 'none', pending: true, reason: null, evaluable: false };
      return final('This round is still in progress. The report is written once it ends.');
    }
    if (session.status !== 'completed' && session.status !== 'aborted') {
      return final(
        'This round did not finish — it was cut short before the interview ended, ' +
          'so there was nothing complete to score.',
      );
    }

    // Mirrors the gate in `InterviewGateway.teardown`: a round with fewer than
    // two turns is never enqueued, and saying so beats a spinner. The candidate
    // count is what `run` itself refuses on, so offering a re-run without it
    // would offer a guaranteed failure.
    const [counted] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        candidate: sql<number>`count(*) filter (where ${turns.speaker} = 'user')::int`,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    const enough = (counted?.n ?? 0) >= 2;

    if (session.status === 'aborted') {
      if (!enough || !(counted?.candidate ?? 0) || !session.audioPath) {
        return final(
          'This round did not finish — it was cut short before the interview ended, ' +
            'so there was nothing complete to score.',
        );
      }
      const minutes = ((session.durationMs ?? 0) / 60_000).toFixed(1);
      return final(
        `This round was cut short after ${minutes} minutes, so it never got a report. ` +
          'You can still score what was recorded.',
        true,
      );
    }

    if (!enough) {
      return final('This round ended before there was enough conversation to score.');
    }

    return final('No report was started for this round.', true);
  }

  async getForSession(userId: string, sessionId: string): Promise<EvaluationView | null> {
    const [meta] = await this.db
      .select({
        config: sessions.config,
        mode: sessions.mode,
        voice: sessions.voice,
        options: sessions.options,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
        model: sessions.model,
        finalCode: sessions.finalCode,
        codeLanguage: sessions.codeLanguage,
        questionCode: sessions.questionCode,
        focus: sessions.focus,
        drill: sessions.drill,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    if (!meta) throw new NotFoundException(`no session ${sessionId}`);

    const attempts = await this.db.select().from(evaluations).where(eq(evaluations.sessionId, sessionId));
    const latest = latestEvaluationBySession(attempts, false).get(sessionId);
    if (!latest) return null;
    const lastComplete = latestEvaluationBySession(attempts, true).get(sessionId) ?? null;
    const { shown: ev, superseded } = pickShownEvaluation(latest, lastComplete);

    const [qs, ds, [sm], outcomes, checks] = await Promise.all([
      this.db.select().from(questionEvaluations)
        .where(eq(questionEvaluations.evaluationId, ev.id)).orderBy(asc(questionEvaluations.idx)),
      this.db.select().from(deliveryScores).where(eq(deliveryScores.evaluationId, ev.id)),
      this.db.select().from(speechMetrics).where(eq(speechMetrics.sessionId, sessionId)),
      this.db.select().from(questionOutcomes)
        .where(eq(questionOutcomes.evaluationId, ev.id)).orderBy(asc(questionOutcomes.idx)),
      this.db.select().from(focusChecks).where(eq(focusChecks.evaluationId, ev.id)),
    ]);

    const checkByKey = new Map(checks.map((c) => [c.key, c]));
    const focus = readFocus(meta.focus).map((f) => {
      const c = checkByKey.get(f.key);
      const result = c && (FOCUS_RESULTS as readonly string[]).includes(c.result) ? (c.result as FocusResult) : null;
      return { ...f, result, evidenceQuote: c?.evidenceQuote ?? null, note: c?.note ?? null };
    });

    const record = meta.drill as DrillRecord | null;
    let drill: DrillView | null = null;
    if (record) {
      const all = await drillAttempts(this.db, userId, record.sourceSessionId);
      drill = {
        ...record,
        // Only a finished report has an "after"; a pending one shows none yet.
        after:
          ev.status === 'complete'
            ? drillAfter(record, { questions: qs, delivery: ds })
            : { score: null, outOf: record.before.outOf, verdict: null, quote: null },
        attempts: all.filter((a) => a.momentId === record.momentId),
      };
    }

    const opts = readRoundOptions(meta.options);
    // Titles come from the BANK, never the evaluator, so a hallucinated title
    // cannot reach the report card. A slug missing from the bank falls back to
    // the slug rather than dropping the row, because the verdict is still true.
    const bank = await this.bankEntries(meta.mode, readRoundConfig(meta.config).questionIds ?? []);

    return {
      id: ev.id,
      sessionId,
      status: ev.status,
      session: {
        mode: meta.mode,
        voice: meta.voice,
        interviewerModel: meta.model,
        plannedMinutes: opts.durationMinutes,
        actualMs: meta.durationMs,
        difficulty: opts.difficulty,
        persona: opts.persona,
        style: opts.style,
        startedAt: meta.startedAt.toISOString(),
        finalCode: meta.finalCode,
        codeLanguage: meta.codeLanguage,
        questionCode:
          (meta.questionCode as Record<string, { code?: string; language?: string | null }> | null) ?? null,
        problems: bank.map(({ id, title, url }) => ({ id, title, url })),
      },
      rubricVersion: ev.rubricVersion,
      model: ev.model,
      provider: ev.provider,
      audioAnalysed: ev.audioAnalysed,
      transcriptSource: ev.transcriptSource,
      degraded: (ev.raw as { degraded?: EvaluationDegraded } | null)?.degraded ?? null,
      overallScore: ev.overallScore,
      overallVerdict: ev.overallVerdict,
      summary: ev.summary,
      topFixes: (ev.topFixes as string[] | null) ?? null,
      error: ev.error,
      createdAt: ev.createdAt.toISOString(),
      completedAt: ev.completedAt?.toISOString() ?? null,
      questions: qs.map((q) => ({
        id: q.id, idx: q.idx,
        question: q.question, myAnswer: q.myAnswer, idealAnswer: q.idealAnswer,
        whatWasGood: q.whatWasGood as string[],
        whatWasMissing: q.whatWasMissing as string[],
        howToImprove: q.howToImprove,
        modelSolution: q.modelSolution,
        modelSolutionLanguage: q.modelSolutionLanguage,
        complexity: (q.complexity as ComplexityAxis[] | null) ?? [],
        score: q.score, verdict: q.verdict, startMs: q.startMs,
      })),
      assignedQuestions: outcomes.map((o) => {
        const q = bank.find((b) => b.id === o.questionId);
        return {
          questionId: o.questionId,
          idx: o.idx,
          title: q?.title ?? o.questionId,
          difficulty: q?.difficulty ?? null,
          url: q?.url ?? null,
          outcome: o.outcome,
          reason: o.reason,
          evidenceQuote: o.evidenceQuote,
        };
      }),
      delivery: ds.map((d) => ({
        dimension: d.dimension, score: d.score, assessment: d.assessment,
        evidenceQuote: d.evidenceQuote, evidenceAtMs: d.evidenceAtMs,
      })),
      metrics: sm
        ? {
            totalSpeakingMs: sm.totalSpeakingMs, wordCount: sm.wordCount,
            wordsPerMinute: sm.wordsPerMinute, fillerCount: sm.fillerCount,
            fillerRate: sm.fillerRate, fillerBreakdown: sm.fillerBreakdown as Record<string, number>,
            medianResponseLatencyMs: sm.medianResponseLatencyMs,
            longestSilenceMs: sm.longestSilenceMs, talkRatio: sm.talkRatio,
            meanTurnWords: sm.meanTurnWords,
          }
        : null,
      focus,
      drill,
      latestAttempt: superseded
        ? {
            id: superseded.id,
            status: superseded.status,
            error: superseded.error,
            createdAt: superseded.createdAt.toISOString(),
          }
        : null,
    };
  }

  /* ── the pipeline ───────────────────────────────────────────────────────── */

  private async begin(sessionId: string): Promise<{ session: SessionRow; evalId: string }> {
    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session) throw new Error('session not found');

    const [ev] = await this.db
      .insert(evaluations)
      .values({ sessionId, status: 'evaluating', model: MODELS.evaluator, rubricVersion: RUBRIC_VERSION })
      .returning({ id: evaluations.id });
    return { session, evalId: ev!.id };
  }

  private async run(session: SessionRow, evalId: string) {
    const sessionId = session.id;
    try {
      const allRows = await this.db
        .select()
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(asc(turns.idx));

      const rows = allRows.filter((t) => !SYSTEM_NOTE_LEAK.test(t.text));
      if (rows.length !== allRows.length) {
        this.log.warn(
          `session ${sessionId}: dropped ${allRows.length - rows.length} turn(s) that were ` +
            `the interviewer echoing a system note — not real dialogue`,
        );
      }
      if (!rows.some((t) => t.speaker === 'user')) {
        throw new Error('the candidate did not speak — nothing to evaluate');
      }

      // Archived rounds are restored to a cache before anything reads them, so
      // the whole pipeline below stays unaware that a round can live in R2.
      const micPath = await this.archive.ensureLocal(session.audioPath);
      const aiPath = await this.archive.ensureLocal(session.aiAudioPath);

      const verbatim = await this.verbatimPass(evalId, sessionId, micPath, allRows);
      const { metrics, alignment } = await this.measure(session, rows, micPath, aiPath, verbatim.text);

      const cfg = readRoundConfig(session.config);
      const audio = await this.loadAudio(micPath);
      const assigned = await this.assignedQuestions(session.mode, cfg);
      const guardEvents = readGuardEvents(session.guardEvents);
      const input = await this.buildInput(session, cfg, rows, metrics, verbatim.text, assigned, guardEvents);
      const focus = input.focus ?? [];

      const result = await this.callEvaluator(
        input,
        audio.payload,
        assigned.map((q) => q.id),
        focus.map((f) => f.key),
      );
      const degraded: EvaluationDegraded = {
        audio: result.audioAnalysed
          ? null
          : (audio.reason ??
            'the evaluator rejected the request with the recording attached, so it was re-run on the transcript'),
        verbatim: verbatim.failure,
      };
      await this.persist(evalId, session, result, {
        metrics,
        alignment,
        turns: rows,
        verbatimModel: verbatim.model,
        verbatimSegments: verbatim.segments,
        assigned,
        guardEvents,
        codeChecks: input.codeChecks ?? [],
        degraded,
        focus,
      });

      this.log.log(
        `evaluation ${evalId} complete via ${result.provider}/${result.model}` +
          `${result.audioAnalysed ? ' (heard audio)' : ' (transcript only)'}: ` +
          `${result.report.overallScore}/100 (${result.report.overallVerdict}), ` +
          `${result.report.questions.length} questions`,
      );
    } catch (err) {
      const message = (err as Error).message;
      await this.db
        .update(evaluations)
        .set({ status: 'failed', error: message })
        .where(eq(evaluations.id, evalId));
      throw err;
    }
  }

  /**
   * Re-transcribes the candidate with the dedicated model, which hears the
   * recording more accurately than the interviewer's own ASR and is unmetered.
   *
   * The coverage floor is applied here as well as in `computeSpeechMetrics`:
   * without it a transcript the metrics rejected as truncated was still handed
   * to the evaluator as the better one to quote from.
   */
  private async verbatimPass(
    evalId: string,
    sessionId: string,
    micPath: string | null,
    allRows: TurnRow[],
  ): Promise<VerbatimPass> {
    const none = (failure: string): VerbatimPass => ({ text: null, model: null, segments: [], failure });
    if (!micPath) return none('no recording of the candidate was found for this round');

    await this.db.update(evaluations).set({ status: 'transcribing' }).where(eq(evaluations.id, evalId));
    const t = await this.transcription.transcribe(
      micPath,
      allRows.filter((r) => r.speaker === 'user').map((r) => ({ startMs: r.startMs, endMs: r.endMs })),
    );
    await this.db.update(evaluations).set({ status: 'evaluating' }).where(eq(evaluations.id, evalId));
    if (!t) return none('the recording could not be read, or nothing in it was transcribed');

    const liveWords = allRows
      .filter((r) => r.speaker === 'user')
      .reduce((a, r) => a + r.text.split(/\s+/).filter(Boolean).length, 0);
    const verbatimWords = t.text.split(/\s+/).filter(Boolean).length;
    const coverage = liveWords > 0 ? verbatimWords / liveWords : 1;

    if (!t.complete) {
      // Neither counted nor stored: a stored fragment reads as the round's
      // authoritative transcript, and a counted one poisons the metrics.
      this.log.warn(
        `session ${sessionId}: verbatim re-transcription incomplete ` +
          `(${verbatimWords} words for ${t.audioSeconds.toFixed(0)}s of audio) ` +
          `— falling back to the live transcript`,
      );
      return none(`the re-transcription stopped part-way: ${t.failure ?? 'a segment failed'}`);
    }
    if (coverage < VERBATIM_MIN_COVERAGE) {
      this.log.error(
        `session ${sessionId}: verbatim pass claimed complete but covers only ` +
          `${(coverage * 100).toFixed(0)}% of the live transcript ` +
          `(${verbatimWords} vs ${liveWords} words) — refusing it`,
      );
      return none(
        `the re-transcription heard only ${(coverage * 100).toFixed(0)}% of the words the live ` +
          `transcript did, so it was not trusted`,
      );
    }

    await this.db
      .insert(verbatimTranscripts)
      .values({ sessionId, model: t.model, fullText: t.text, words: [] })
      .onConflictDoUpdate({
        target: verbatimTranscripts.sessionId,
        set: { model: t.model, fullText: t.text },
      });
    return { text: t.text, model: t.model, segments: t.segments, failure: null };
  }

  /** Metrics are cheap, deterministic, and stored even if the model call later fails. */
  private async measure(
    session: SessionRow,
    rows: TurnRow[],
    micPath: string | null,
    aiPath: string | null,
    verbatim: string | null,
  ): Promise<{ metrics: SpeechMetrics; alignment: Alignment }> {
    const analysis = micPath ? await analyzeWav(micPath) : null;
    if (!analysis) {
      this.log.warn(`session ${session.id}: no candidate waveform — speaking time, pace and talk ratio not measured`);
    }
    const aiAnalysis = aiPath ? await analyzeWav(aiPath) : null;
    if (!aiAnalysis) {
      this.log.warn(`session ${session.id}: no interviewer recording — response latency and dead air not measured`);
    }

    const alignment = align(rows, analysis, aiAnalysis);
    this.log.log(
      `session ${session.id}: aligned ${alignment.candidateStretches.length} candidate ` +
        `speaking stretches against ${rows.filter((t) => t.speaker === 'user').length} turns ` +
        `(${alignment.stretchesMatchTurns ? 'matched' : 'NOT matched — evidence timestamps fall back to turn starts'})`,
    );
    const metrics = computeSpeechMetrics(rows, analysis, session.aiSpeakingMs ?? 0, verbatim, aiAnalysis);
    return { metrics, alignment };
  }

  private async buildInput(
    session: SessionRow,
    cfg: RoundConfig,
    rows: TurnRow[],
    metrics: SpeechMetrics,
    verbatim: string | null,
    assigned: BankEntry[],
    guardEvents: GuardEvent[],
  ): Promise<Omit<EvaluationInput, 'hasAudio'>> {
    const opts = readRoundOptions(session.options);
    // `durationMs` is authoritative; the timestamps are the fallback for a row
    // finalized before that column was written.
    const actualMs =
      session.durationMs ??
      (session.endedAt ? session.endedAt.getTime() - session.startedAt.getTime() : null);
    const ids = cfg.questionIds ?? [];
    const dsa = session.mode === 'dsa' ? await this.dsaRows(ids) : [];

    return {
      mode: session.mode,
      durationMinutes: opts.durationMinutes ?? OPTION_DEFAULTS.durationMinutes,
      actualMinutes: actualMs === null ? null : Math.round(actualMs / 60_000),
      cutShort: cutShortBy(session),
      deadWindows: (session.interviewerStalls as StallRecord[] | null) ?? [],
      guardEvents,
      difficulty: opts.difficulty ?? OPTION_DEFAULTS.difficulty,
      transcript: rows.map((t) => ({ speaker: t.speaker, text: t.text, startMs: t.startMs })),
      metrics,
      referenceMaterial: await REFERENCE[session.mode]({
        db: this.db, cfg, dsa, codeLanguage: session.codeLanguage,
      }),
      writtenContext: await this.writtenContext(session, cfg, assigned),
      verbatimTranscript: verbatim,
      codeLanguage: session.codeLanguage,
      assignedQuestions: assigned,
      // Decided BEFORE the rubric and handed to it as a fact: deterministic
      // code verification prevents incorrect trivial solutions from being
      // marked solved. See `code-check.service.ts`.
      codeChecks: await this.checkWrittenCode(session, dsa),
      focus: readFocus(session.focus),
      isDrill: session.kind === 'drill',
      style: opts.style,
    };
  }

  /**
   * The recording is what separates this from grading a transcript. If it is
   * missing the report still ships, but the delivery half is explicitly
   * degraded rather than silently invented.
   */
  private async loadAudio(
    path: string | null,
  ): Promise<{ payload: AudioPayload | null; reason: string | null }> {
    if (!path) return { payload: null, reason: 'no recording of the candidate was found for this round' };
    let size: number;
    try {
      ({ size } = await stat(path));
    } catch {
      this.log.warn(`recording missing at ${path} — evaluating transcript only`);
      return { payload: null, reason: 'the recording was missing from disk when the report was written' };
    }
    if (size <= MAX_AUDIO_BYTES) {
      return { payload: { data: (await readFile(path)).toString('base64'), mimeType: 'audio/wav', path }, reason: null };
    }

    const mb = (size / 1e6).toFixed(0);
    const mp3 = await this.compressForEvaluator(path);
    if (!mp3) {
      return { payload: null, reason: `the ${mb}MB recording could not be compressed to fit the evaluator` };
    }
    if (mp3.length > MAX_AUDIO_BYTES) {
      return {
        payload: null,
        reason: `the recording is still ${(mp3.length / 1e6).toFixed(0)}MB compressed, past the evaluator's limit`,
      };
    }
    this.log.log(`recording ${path} is ${mb}MB — sending it as ${(mp3.length / 1e6).toFixed(1)}MB of MP3`);
    return { payload: { data: mp3.toString('base64'), mimeType: 'audio/mp3', path }, reason: null };
  }

  /** Mono MP3 at EVALUATOR_AUDIO_KBPS, or null when ffmpeg is missing or fails. */
  private async compressForEvaluator(wav: string): Promise<Buffer | null> {
    const out = join(tmpdir(), `orvia-eval-${randomBytes(6).toString('hex')}.mp3`);
    try {
      await run('ffmpeg', [
        '-v', 'error', '-y', '-i', wav,
        '-ac', '1', '-c:a', 'libmp3lame', '-b:a', `${EVALUATOR_AUDIO_KBPS}k`,
        out,
      ]);
      return await readFile(out);
    } catch (e) {
      this.log.warn(`could not compress ${wav} for the evaluator: ${(e as Error).message}`);
      return null;
    } finally {
      await unlink(out).catch(() => {});
    }
  }

  /** The round's DSA problems, in the round's order — `inArray` promises none. */
  private async dsaRows(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.db.select().from(dsaQuestions).where(inArray(dsaQuestions.id, ids));
    return ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is (typeof rows)[number] => !!r);
  }

  /**
   * Bank entries for a round's ids, in the round's order. Only `dsa` and
   * `concepts` assign from a bank: `jd` and `experience` have none, `hr` and
   * `system_design` assign one scripted thing, so they return nothing.
   */
  private async bankEntries(mode: InterviewMode, ids: string[]): Promise<BankEntry[]> {
    if (!ids.length) return [];
    let rows: BankEntry[];
    if (mode === 'dsa') {
      rows = await this.db
        .select({ id: dsaQuestions.id, title: dsaQuestions.title, difficulty: dsaQuestions.difficulty, url: dsaQuestions.url })
        .from(dsaQuestions)
        .where(inArray(dsaQuestions.id, ids));
    } else if (mode === 'concepts') {
      rows = (
        await this.db
          .select({ id: conceptQuestions.id, title: conceptQuestions.title, difficulty: conceptQuestions.difficulty })
          .from(conceptQuestions)
          .where(inArray(conceptQuestions.id, ids))
      ).map((r) => ({ ...r, url: null }));
    } else {
      return [];
    }
    return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is BankEntry => !!r);
  }

  /**
   * The problems this round ASSIGNED, for the evaluator's closed enum and
   * `persistOutcomes`. Concepts rounds are here for the same reason DSA rounds
   * are: a finite bank, a closed list of ids, and a rotation that needs a
   * verdict per question. An empty list switches the section off.
   */
  private assignedQuestions(mode: InterviewMode, cfg: RoundConfig): Promise<BankEntry[]> {
    return this.bankEntries(mode, cfg.questionIds ?? []);
  }

  /**
   * Runs the code checker over what the candidate wrote, per question. DSA
   * only: the other modes have nothing keyed to a closed list of problems. A
   * problem with no statement is skipped — the statement is what the check is
   * judged against.
   */
  private async checkWrittenCode(
    session: SessionRow,
    dsa: { id: string; title: string; prompt: string }[],
  ): Promise<CodeCheck[]> {
    if (session.mode !== 'dsa' || !dsa.length) return [];
    const code = (session.questionCode ?? {}) as Record<
      string,
      { code?: string; language?: string | null } | undefined
    >;
    if (!Object.keys(code).length) return [];
    return this.codeCheck.check(
      dsa.filter((p) => p.prompt).map(({ id, title, prompt }) => ({ id, title, prompt })),
      code,
    );
  }

  /**
   * Per-question buffers when the round had them. The single latest snapshot
   * is right only for a one-question round: on a three-question round it
   * handed over whichever buffer was open last as "the final code", and two of
   * the three questions were scored against another problem's code.
   */
  private async writtenContext(
    session: SessionRow,
    cfg: RoundConfig,
    assigned: BankEntry[],
  ): Promise<string | null> {
    const map = (session.questionCode ?? null) as Record<
      string,
      { code?: string; language?: string | null }
    > | null;
    const ids = cfg.questionIds ?? [];

    if (map && Object.keys(map).length) {
      const titles = new Map(assigned.map((q) => [q.id, q.title]));
      const ordered = [...new Set([...ids, ...Object.keys(map)])].filter((id) => map[id]?.code);
      if (ordered.length) {
        const budget = Math.max(1500, Math.floor(8000 / ordered.length));
        const blocks = ordered.map((id, i) => {
          const title = titles.get(id) ?? id;
          const lang = map[id]?.language;
          return (
            `Question ${i + 1} — ${title}${lang ? ` (${lang})` : ''}:\n\n` +
            `${(map[id]?.code ?? '').slice(0, budget)}`
          );
        });
        return ordered.length === 1
          ? `Final editor contents:\n\n${blocks[0]!.split('\n\n').slice(1).join('\n\n')}`
          : `Editor contents at the end of the round, per question. Score each ` +
              `question against ITS OWN code below, not against the last thing they ` +
              `typed:\n\n${blocks.join('\n\n---\n\n')}`;
      }
    }

    const [last] = await this.db
      .select()
      .from(contextSnapshots)
      .where(eq(contextSnapshots.sessionId, session.id))
      .orderBy(desc(contextSnapshots.atMs))
      .limit(1);
    return last ? `Final ${last.kind} contents:\n\n${last.content.slice(0, 8000)}` : null;
  }

  /**
   * Records problem outcomes for assigned problems. Missing entries default
   * to `not_reached`, unassigned ids are discarded, and transitions beyond
   * `current_question_idx` require candidate quotes to prevent premature retirement
   * from the practice rotation.
   */
  private async persistOutcomes(
    db: Writer,
    evalId: string,
    session: SessionRow,
    reported: QuestionOutcome[],
    assigned: BankEntry[],
  ) {
    if (!assigned.length) return;

    // Only DSA rounds have a `QuestionTracker`, so a concepts round leaves this
    // at zero and everything past its first question needs a quote to survive.
    const reachedThrough = session.currentQuestionIdx ?? 0;

    const byId = new Map<string, QuestionOutcome>();
    for (const r of reported) {
      if (!assigned.some((a) => a.id === r.questionId)) {
        this.log.warn(
          `evaluation ${evalId}: evaluator returned an outcome for "${r.questionId}", which ` +
            `this round did not assign — dropped`,
        );
        continue;
      }
      if (!QUESTION_OUTCOMES.includes(r.outcome)) continue;
      // First wins: a duplicate is the model repeating itself, not a revision.
      if (!byId.has(r.questionId)) byId.set(r.questionId, r);
    }

    const rows = assigned.map((q, idx) => {
      const r = byId.get(q.id);
      let outcome: QuestionOutcomeKind = r?.outcome ?? 'not_reached';
      let reason =
        r?.reason ??
        'The evaluator returned no verdict for this problem, so it is recorded as not reached.';

      if (outcome !== 'not_reached' && idx > reachedThrough && !r?.evidenceQuote) {
        this.log.warn(
          `evaluation ${evalId}: "${q.id}" came back ${outcome} with no quote, but the round ` +
            `was only heard to reach problem ${reachedThrough + 1} of ${assigned.length} — ` +
            `recording it as not reached, so it stays in the rotation`,
        );
        outcome = 'not_reached';
        reason = `The interviewer was not heard to reach this problem. ${reason}`;
      }

      return {
        evaluationId: evalId,
        questionId: q.id,
        idx,
        outcome,
        reason,
        evidenceQuote: outcome === 'not_reached' ? null : (r?.evidenceQuote ?? null),
      };
    });

    await db
      .insert(questionOutcomes)
      .values(rows)
      .onConflictDoUpdate({
        target: [questionOutcomes.evaluationId, questionOutcomes.questionId],
        set: {
          idx: sql`excluded.idx`,
          outcome: sql`excluded.outcome`,
          reason: sql`excluded.reason`,
          evidenceQuote: sql`excluded.evidence_quote`,
        },
      });

    const solved = rows.filter((r) => r.outcome === 'solved').map((r) => r.questionId);
    this.log.log(
      `evaluation ${evalId}: outcomes ` +
        rows.map((r) => `${r.questionId}=${r.outcome}`).join(', ') +
        (solved.length
          ? ` — ${solved.length} problem(s) retired from the rotation`
          : ' — nothing retired from the rotation'),
    );
  }

  /**
   * One provider call; if every model rejects the request with the recording
   * attached, once more transcript-only. The prompt is rebuilt for that retry
   * because it tells the model whether it can hear the audio.
   */
  private async callEvaluator(
    input: Omit<EvaluationInput, 'hasAudio'>,
    audio: AudioPayload | null,
    assignedIds: string[],
    focusKeys: string[],
  ): Promise<EvaluatorResult> {
    try {
      return await this.provider.evaluate(
        buildEvaluatorPrompt({ ...input, hasAudio: !!audio }), audio, assignedIds, focusKeys,
      );
    } catch (e) {
      if (!audio || (e as Error).name !== 'AudioRejectedError') throw e;
      this.log.warn(
        `the evaluator rejected the request with the recording attached ` +
          `(${(e as Error).message.slice(0, 160)}) — retrying transcript-only`,
      );
      return this.provider.evaluate(
        buildEvaluatorPrompt({ ...input, hasAudio: false }), null, assignedIds, focusKeys,
      );
    }
  }

  /**
   * Records verdicts for judged focus items. Keys absent from the round are dropped,
   * unjudged items get no row, and positive verdicts (`applied`/`partly`) require
   * candidate quotes before counting towards commitment completion.
   */
  private async persistFocusChecks(db: Writer, evalId: string, reported: FocusCheck[], focus: FocusItem[]) {
    if (!focus.length) return;
    const byKey = new Map<string, FocusCheck>();
    for (const r of reported) {
      if (!focus.some((f) => f.key === r.key) || !FOCUS_RESULTS.includes(r.result)) {
        this.log.warn(`evaluation ${evalId}: dropped a focus check for "${r.key}" (${r.result})`);
        continue;
      }
      if ((r.result === 'applied' || r.result === 'partly') && !r.evidenceQuote?.trim()) {
        this.log.warn(`evaluation ${evalId}: "${r.key}" came back ${r.result} with no quote — left unjudged`);
        continue;
      }
      if (!byKey.has(r.key)) byKey.set(r.key, r);
    }
    const rows = focus.flatMap((f) => {
      const r = byKey.get(f.key);
      if (!r) return [];
      return [{
        evaluationId: evalId,
        key: f.key,
        text: f.text,
        source: f.source,
        result: r.result,
        evidenceQuote: r.result === 'no_chance' ? null : r.evidenceQuote,
        note: r.note,
      }];
    });
    if (rows.length < focus.length) {
      this.log.warn(`evaluation ${evalId}: ${focus.length - rows.length} of ${focus.length} focus items came back unjudged`);
    }
    if (rows.length) await db.insert(focusChecks).values(rows);
  }

  /**
   * Writes the report in a single transaction to prevent partial rows
   * if persistence fails part-way through.
   */
  private async persist(
    evalId: string,
    session: SessionRow,
    result: EvaluatorResult,
    ctx: {
      metrics: SpeechMetrics;
      alignment: Alignment;
      /** The round's turns with system-note leaks already removed. */
      turns: TurnRow[];
      /** Set when our own verbatim pass produced the transcript the quotes came from. */
      verbatimModel: string | null;
      /** Coarse timing fallback for quotes the live turns do not contain. */
      verbatimSegments: { startMs: number; endMs: number; text: string }[];
      assigned: BankEntry[];
      guardEvents: GuardEvent[];
      /** Persisted: the only other record of what the checker found was a log line. */
      codeChecks: NonNullable<EvaluationInput['codeChecks']>;
      degraded: EvaluationDegraded;
      focus: FocusItem[];
    },
  ) {
    const { model, provider, audioAnalysed } = result;
    const aiTurns = ctx.turns.filter((t) => t.speaker === 'ai');
    const lastTurnEnd = ctx.turns.reduce((a, t) => Math.max(a, t.endMs ?? t.startMs), 0);
    const durationMs = session.durationMs ?? (lastTurnEnd || null);

    // Every time in the report is MEASURED here; the model is no longer asked
    // for any (see `evaluation.schema.ts`).
    const askedAt = measureAskedAt(result.report.questions, ctx.turns, ctx.guardEvents, durationMs);
    const inRound = (ms: number | null) =>
      ms !== null && ms >= 0 && (durationMs === null || ms <= durationMs) ? ms : null;

    const fixes = sanitiseTopFixes(
      result.report.topFixes,
      result.report.questions.map((q) => q.howToImprove),
    );
    const summary = sanitiseSummary(result.report.summary, {
      deadMs: session.deadMs ?? 0,
      guardEvents: ctx.guardEvents,
    });
    for (const d of [...fixes.dropped, ...summary.dropped]) {
      this.log.warn(`evaluation ${evalId}: dropped a line blaming the candidate for the interviewer — "${d}"`);
    }

    const report = {
      ...result.report,
      summary: summary.summary,
      topFixes: fixes.fixes,
      questions: result.report.questions.map((q, idx) => ({
        ...q,
        startMs: askedAt[idx] ?? null,
        complexity: (q.complexity ?? []).map((c) => ({
          ...c,
          statedAtMs: inRound(locateQuote(c.statedQuote, ctx.turns, ctx.alignment, ctx.verbatimSegments)),
        })),
      })),
    };

    /** Nearest interviewer turn, so the report can jump to that point in the audio. */
    const nearestAiTurn = (ms: number | null | undefined) => {
      if (ms == null || !aiTurns.length) return null;
      return aiTurns.reduce((best, t) =>
        Math.abs(t.startMs - ms) < Math.abs(best.startMs - ms) ? t : best,
      ).id;
    };

    // Where a question's exchange stops: the next question, or the end of the
    // last thing anybody said, so "play this question" always has a bound.
    const questionEndMs = (startMs: number | null | undefined, idx: number) => {
      const next = report.questions[idx + 1]?.startMs;
      if (next != null && startMs != null && next > startMs) return next;
      return lastTurnEnd || null;
    };

    // Unknown dimensions are dropped: the unique index is on (evaluation,
    // dimension), and a hallucinated id would break the chart.
    const seen = new Set<string>();
    const delivery = report.delivery
      .filter((d) => DELIVERY_DIMENSION_IDS.includes(d.dimension))
      .filter((d) => !seen.has(d.dimension) && seen.add(d.dimension));
    if (delivery.length < DELIVERY_DIMENSION_IDS.length) {
      this.log.warn(
        `evaluation ${evalId}: ${DELIVERY_DIMENSION_IDS.length - delivery.length} dimensions missing`,
      );
    }

    await this.db.transaction(async (tx) => {
      // Keyed by session, not evaluation: written only with a report that
      // succeeded, or a failed re-run would pair its numbers with the old report.
      await tx
        .insert(speechMetrics)
        .values({ sessionId: session.id, ...ctx.metrics })
        .onConflictDoUpdate({ target: speechMetrics.sessionId, set: { ...ctx.metrics } });
      if (report.questions.length) {
        await tx.insert(questionEvaluations).values(
          report.questions.map((q, idx) => ({
            evaluationId: evalId,
            idx,
            questionTurnId: nearestAiTurn(q.startMs),
            question: q.question,
            myAnswer: q.myAnswer,
            idealAnswer: q.idealAnswer,
            whatWasGood: q.whatWasGood,
            whatWasMissing: q.whatWasMissing,
            howToImprove: q.howToImprove,
            modelSolution: q.modelSolution ?? null,
            modelSolutionLanguage: q.modelSolutionLanguage ?? session.codeLanguage ?? null,
            // A half-filled complexity table is a claim about what the
            // candidate said, and worse than none.
            complexity: (q.complexity ?? []).filter((c) => !!c.actual && !!c.optimal),
            score: q.score,
            verdict: q.verdict,
            startMs: q.startMs ?? null,
            endMs: questionEndMs(q.startMs, idx),
          })),
        );
      }

      await this.persistOutcomes(tx, evalId, session, report.assignedQuestions ?? [], ctx.assigned);
      await this.persistFocusChecks(tx, evalId, report.focusChecks ?? [], ctx.focus);

      if (delivery.length) {
        await tx.insert(deliveryScores).values(
          delivery.map((d) => ({
            evaluationId: evalId,
            dimension: d.dimension,
            score: d.score,
            assessment: d.assessment,
            evidenceQuote: d.evidenceQuote ?? null,
            /**
             * Measured rather than model-reported. The evaluator lacks exact word
             * timestamps and its reported offsets can deviate significantly; null
             * hides the audio seek button rather than jumping to an inaccurate offset.
             */
            evidenceAtMs: locateQuote(d.evidenceQuote, ctx.turns, ctx.alignment, ctx.verbatimSegments),
          })),
        );
      }

      await tx
        .update(evaluations)
        .set({
          status: 'complete',
          model,
          provider,
          audioAnalysed,
          // Which transcript the quotes and filler counts came from.
          transcriptSource: ctx.verbatimModel,
          overallScore: report.overallScore,
          overallVerdict: report.overallVerdict,
          summary: report.summary,
          topFixes: report.topFixes,
          raw: {
            ...report,
            codeChecks: ctx.codeChecks,
            degraded: ctx.degraded,
            droppedAsInterviewerBlame: [...fixes.dropped, ...summary.dropped],
          },
          completedAt: new Date(),
        })
        .where(eq(evaluations.id, evalId));
    });
  }
}

/* ── reference material, per mode ─────────────────────────────────────────── */

type ReferenceCtx = {
  db: Database;
  cfg: RoundConfig;
  dsa: (typeof dsaQuestions.$inferSelect)[];
  codeLanguage: string | null;
};

/**
 * What the evaluator judges against, which the candidate never saw. A Record
 * so a new mode fails to compile until it says what its reference is.
 */
export const REFERENCE: Record<InterviewMode, (ctx: ReferenceCtx) => Promise<string>> = {
  async dsa({ dsa, codeLanguage }) {
    return dsa
      .map((q) => {
        // The editor opens on LeetCode's skeleton, so the candidate did not
        // type the signature or imports. Without this the evaluator credits or
        // faults them for supplied boilerplate.
        const skeleton =
          codeLanguage && isCodeLanguage(codeLanguage)
            ? (q.codeSnippets as CodeSnippets | null)?.[codeLanguage]
            : undefined;
        return [
          `### ${q.title} (${q.difficulty})`,
          q.referenceSolution ? `Optimal approach: ${q.referenceSolution}` : null,
          q.optimalComplexity ? `Optimal complexity: ${q.optimalComplexity}` : null,
          (q.keyInsights as string[] | null)?.length
            ? `A strong candidate raises: ${(q.keyInsights as string[]).join('; ')}`
            : null,
          skeleton
            ? `The editor was PRE-FILLED with this skeleton. The candidate did NOT ` +
              `write it — judge only what they added to it:\n${skeleton.trim()}`
            : null,
        ].filter(Boolean).join('\n');
      })
      .join('\n\n');
  },

  async system_design({ db, cfg }) {
    // By id when the round recorded one; otherwise by prompt text, which is
    // all a round from before `problemId` carries.
    const rows = cfg.problemId
      ? await db.select().from(systemDesignProblems).where(eq(systemDesignProblems.id, cfg.problemId))
      : await db.select().from(systemDesignProblems);
    const problem = cfg.problem ?? '';
    const match = cfg.problemId
      ? rows[0]
      : rows.find((r) => (problem && problem.includes(r.title)) || r.prompt === problem);
    if (!match?.rubricNotes) return '';
    const notes = match.rubricNotes as Record<string, string[]>;
    return [
      `### ${match.title} (${match.level})`,
      ...Object.entries(notes).map(([phase, items]) => `${phase.replace(/_/g, ' ')}: ${items.join('; ')}`),
    ].join('\n');
  },

  /**
   * Evaluator-only: the interviewer gets the follow-up QUESTIONS and never
   * these, because an interviewer holding the answer leaks it.
   */
  async concepts({ db, cfg }) {
    const ids = cfg.questionIds ?? [];
    if (!ids.length) return '';
    const rows = await db.select().from(conceptQuestions).where(inArray(conceptQuestions.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((q): q is (typeof rows)[number] => !!q)
      .map((q) =>
        [
          `### ${q.title} (${q.difficulty})`,
          `Asked: ${q.prompt}`,
          (q.expectedPoints as string[] | null)?.length
            ? `A strong answer contains: ${(q.expectedPoints as string[]).join('; ')}`
            : null,
          (q.commonMistakes as string[] | null)?.length
            ? `Wrong answers people give confidently: ${(q.commonMistakes as string[]).join('; ')}`
            : null,
        ].filter(Boolean).join('\n'),
      )
      .join('\n\n');
  },

  /**
   * `strongAnswer` is the SHAPE of a good answer, never its content, which is
   * the candidate's own history. The background goes alongside so a story that
   * contradicts it can be noticed.
   */
  async behavioural({ db, cfg }) {
    const ids = cfg.questionIds ?? [];
    const rows = ids.length
      ? await db.select().from(behaviouralQuestions).where(inArray(behaviouralQuestions.id, ids))
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const bank = ids
      .map((id) => byId.get(id))
      .filter((q): q is (typeof rows)[number] => !!q)
      .map((q) =>
        [
          `### ${q.title}`,
          `Asked: ${q.prompt}`,
          (q.strongAnswer as string[] | null)?.length
            ? `A strong answer to this: ${(q.strongAnswer as string[]).join('; ')}`
            : null,
        ].filter(Boolean).join('\n'),
      )
      .join('\n\n');

    const experience = (cfg.experience ?? '').trim();
    return experience
      ? `${bank}\n\n### The candidate's stated background\n\nStories should be consistent with this. A story that contradicts it, or a project that appears here and never in their answers, is worth noting.\n\n${experience.slice(0, 6000)}`
      : bank;
  },

  /**
   * The scenario's notes PLUS the numbers the candidate typed into setup,
   * which the interviewer was never given — the only way to tell whether the
   * figure they held in the room was the one they actually wanted.
   */
  async hr({ db, cfg }) {
    const [scenario] = cfg.scenarioId
      ? await db.select().from(hrScenarios).where(eq(hrScenarios.id, cfg.scenarioId))
      : [];

    const wanted = [
      cfg.targetRole ? `Target role: ${cfg.targetRole}` : null,
      cfg.currentCompensation ? `Currently earning: ${cfg.currentCompensation}` : null,
      cfg.expectedCompensation
        ? `What they told US they want, before the round started: ${cfg.expectedCompensation}`
        : null,
      cfg.noticePeriod ? `Notice period: ${cfg.noticePeriod}` : null,
      cfg.competingOffers ? `Competing offers: ${cfg.competingOffers}` : null,
      cfg.reasonForLeaving ? `Reason for leaving: ${cfg.reasonForLeaving}` : null,
    ].filter(Boolean);

    return [
      scenario ? `### Scenario: ${scenario.title} (${scenario.stage})` : null,
      scenario ? `The interviewer was playing: ${scenario.persona}` : null,
      (scenario?.rubricNotes as string[] | null)?.length
        ? `What to judge here:\n${(scenario!.rubricNotes as string[]).map((n) => `- ${n}`).join('\n')}`
        : null,
      wanted.length
        ? `### What the candidate told the app, which the INTERVIEWER never saw\n` +
          `${wanted.join('\n')}\n` +
          `Compare these against what they actually said in the room.`
        : null,
    ].filter(Boolean).join('\n\n');
  },

  async jd({ cfg }) {
    return `The role being interviewed for:\n\n${(cfg.jobDescription ?? '').slice(0, 4000)}`;
  },

  /**
   * The role, when there was one, goes in under its own heading: a posting
   * reads like a list of claims, and the evaluator must not mark the candidate
   * down for requirements they never said they had and were never asked about.
   */
  async experience({ cfg }) {
    const background = `The candidate's stated background, which their claims should be checked against:\n\n${(cfg.experience ?? '').slice(0, 6000)}`;
    const role = (cfg.jobDescription ?? '').trim();
    return role
      ? `${background}\n\n### The role they were preparing for\n\nNOT part of their background. Judge how convincingly the evidence they gave shows they can do this job, and name the requirements their answers left unevidenced. A requirement they were never asked about is not a fault.\n\n${role.slice(0, 4000)}`
      : background;
  },
};
