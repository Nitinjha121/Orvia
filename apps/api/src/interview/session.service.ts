import { Injectable, Inject, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, desc, inArray, lt, sql } from 'drizzle-orm';
import {
  sessions,
  turns,
  contextSnapshots,
  dsaQuestions,
  conceptQuestions,
  conceptTopics,
  behaviouralQuestions,
  behaviouralCompetencies,
  hrScenarios,
  profiles,
  type Database,
} from '@orvia/db';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  MAX_DURATION_MINUTES,
  type DrillRecord,
  type FocusItem,
  type GuardEvent,
  type StartSessionInput,
  type Speaker,
} from '@orvia/shared';
import { DB } from '../db/db.module';
import {
  buildInterviewerPrompt,
  type QuestionBankEntry,
  type ConceptQuestionEntry,
  type BehaviouralQuestionEntry,
  type HrScenarioEntry,
} from './prompts/interviewer.prompt';
import { ExtractionService } from '../extraction/extraction.service';
import type { JdBrief } from '../extraction/extraction.schema';
import { RecordingService } from './recording.service';
import type { StoredUpstreamEvent } from '../gemini/upstream-log';

/**
 * One stretch the interviewer spent unresponsive. Stored on the session (see
 * `sessions.interviewerStalls`) because until now the only record of the app's
 * most common failure was a log line nobody kept.
 */
export type StallRecord = {
  /** Where the silence began, in ms from session start. */
  atMs: number;
  /**
   * What it cost the candidate: the window less their own talking inside it
   * (`InterviewGateway.stallCost`). Still running when the round ended if
   * `recovered` is false.
   */
  forMs: number;
  /** Total wall-clock duration of the stall window. */
  wallMs?: number;
  /** Highest rung reached, and what that rung did. */
  rung: number;
  action: string;
  /** Whether the interviewer spoke again afterwards. */
  recovered: boolean;
  /** True when the debt was the round's OPENING rather than a reply. */
  opening: boolean;
  /**
   * True when the server stopped hearing the microphone: what the candidate
   * said inside the window is missing from the transcript, not merely unanswered.
   */
  deaf?: boolean;
};

/**
 * Live, in-memory state for one running interview. Turn boundaries are derived
 * here rather than persisted per-fragment, because the Live API emits
 * transcription in fragments that do not line up with conversational turns.
 */
type LiveState = {
  id: string;
  startedAt: number;
  turnIdx: number;
  /** Accumulated fragments for the speaker currently holding the floor. */
  buffer: { speaker: Speaker; parts: string[]; startMs: number } | null;
  /**
   * Serializes turn inserts so rows land in spoken order without fragments overtaking one another.
   */
  writes: Promise<unknown>;
};

/**
 * Maximum time a session may remain in `live` status before startup sweep marks it aborted.
 * Sized to accommodate maximum session duration plus stall allowances and buffer.
 */
const ABANDONED_AFTER_MS = (2 * MAX_DURATION_MINUTES + 30) * 60_000;

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly log = new Logger(SessionService.name);
  private readonly live = new Map<string, LiveState>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly extraction: ExtractionService,
    private readonly recorder: RecordingService,
  ) {}

  /**
   * Closes abandoned live rounds on startup, wrapping orphan PCM audio tracks
   * into playable WAV files and marking the session status as aborted.
   */
  async onModuleInit() {
    const abandoned = await this.db
      .select({ id: sessions.id, startedAt: sessions.startedAt })
      .from(sessions)
      .where(
        and(
          eq(sessions.status, 'live'),
          lt(sessions.startedAt, new Date(Date.now() - ABANDONED_AFTER_MS)),
        ),
      );
    if (!abandoned.length) return;

    for (const s of abandoned) {
      // Salvage must never block the close: a round left as `live` is the bug
      // being fixed, and unwrappable audio is not a reason to reproduce it.
      const rescued = await this.recorder.salvage(s.id).catch((e: Error) => {
        this.log.warn(`session ${s.id}: could not salvage audio: ${e.message}`);
        return { audioPath: undefined, aiAudioPath: undefined, durationMs: 0 };
      });

      await this.db
        .update(sessions)
        .set({
          status: 'aborted',
          endedAt: new Date(s.startedAt.getTime() + rescued.durationMs),
          durationMs: rescued.durationMs,
          endReason: 'abandoned: the API stopped while this round was live',
          audioPath: rescued.audioPath ?? null,
          aiAudioPath: rescued.aiAudioPath ?? null,
        })
        .where(eq(sessions.id, s.id));

      this.log.warn(
        `session ${s.id}: abandoned mid-round, closed as aborted ` +
          `(${(rescued.durationMs / 1000).toFixed(1)}s of audio rescued)`,
      );
    }

    this.log.warn(`closed ${abandoned.length} session(s) abandoned by a restart`);
  }

  async create(
    userId: string,
    input: StartSessionInput,
    model: string,
    extras: {
      /** Set on a drill; resolved by `DrillService`, never taken from the client. */
      drill?: { record: DrillRecord; narrowed: boolean };
      focus?: FocusItem[];
      loop?: { id: string; stage: number };
    } = {},
  ) {
    const { config, options } = input;

    // The pause tolerance is a per-person setting, so it is read from the
    // profile rather than sent by the client — it should not be something the
    // UI can accidentally reset on every new session.
    const [profile] = await this.db
      .select({
        silenceDurationMs: profiles.silenceDurationMs,
        prefixPaddingMs: profiles.prefixPaddingMs,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const silenceDurationMs = profile?.silenceDurationMs ?? 1400;
    const prefixPaddingMs = profile?.prefixPaddingMs ?? 600;

    let questions: QuestionBankEntry[] = [];
    /** Every language's skeleton per question, so "nothing written yet" can be told. */
    const starters: Record<string, string[]> = {};
    if (config.mode === 'dsa') {
      const rows = await this.db
        .select()
        .from(dsaQuestions)
        .where(inArray(dsaQuestions.id, config.questionIds));

      /**
       * Preserves candidate selection order rather than arbitrary query order,
       * ensuring question numbers match between the prompt and the UI tabs.
       */
      const byId = new Map(rows.map((r) => [r.id, r]));
      questions = config.questionIds
        .map((id) => byId.get(id))
        .filter((r): r is (typeof rows)[number] => !!r)
        .map((r) => ({
          id: r.id,
          title: r.title,
          difficulty: r.difficulty,
          prompt: r.prompt,
          constraints: (r.constraints as string[] | null) ?? null,
        }));

      for (const r of rows) {
        const snippets = r.codeSnippets as Record<string, unknown> | null;
        starters[r.id] = Object.values(snippets ?? {}).filter((s): s is string => typeof s === 'string');
      }

      if (questions.length === 0) {
        throw new Error(`no DSA questions matched ids: ${config.questionIds.join(', ')}`);
      }
      if (questions.length < config.questionIds.length) {
        const missing = config.questionIds.filter((id) => !byId.has(id));
        this.log.warn(`session for ${userId}: unknown question ids dropped: ${missing.join(', ')}`);
      }
    }

    /**
     * The banks for the spoken rounds, resolved in the candidate's SELECTION
     * order for exactly the reason DSA's are: the prompt numbers them, so
     * "question two" has to mean the same problem everywhere, and `inArray`
     * makes no ordering promise.
     */
    const conceptQs =
      config.mode === 'concepts' ? await this.loadConceptQuestions(config.questionIds) : [];
    const behaviouralQs =
      config.mode === 'behavioural'
        ? await this.loadBehaviouralQuestions(config.questionIds)
        : [];
    const hrScenario = config.mode === 'hr' ? await this.loadHrScenario(config.scenarioId) : undefined;

    // Parse the pasted text into something the interviewer can aim with. This
    // is on the critical path of starting a round, so it is cached by content
    // and never fatal — a raw-text round still works, it is just less targeted.
    const [brief, roleBrief] = await Promise.all([
      this.buildBrief(config),
      config.mode === 'experience' && config.jobDescription
        ? this.extraction.jobDescription(config.jobDescription).then((b) => b && renderRole(b, 'steer'))
        : undefined,
    ]);

    const systemInstruction = buildInterviewerPrompt({
      config,
      options,
      questions,
      conceptQuestions: conceptQs,
      behaviouralQuestions: behaviouralQs,
      hrScenario,
      brief,
      roleBrief: roleBrief ?? undefined,
      drill: extras.drill
        ? { question: extras.drill.record.question, narrowed: extras.drill.narrowed }
        : undefined,
    });

    const [row] = await this.db
      .insert(sessions)
      .values({
        userId,
        mode: config.mode,
        status: 'live',
        config,
        options,
        model,
        voice: options.voice,
        systemInstruction,
        kind: extras.drill ? 'drill' : 'round',
        drill: extras.drill?.record ?? null,
        focus: extras.focus?.length ? extras.focus : null,
        loopId: extras.loop?.id ?? null,
        loopStage: extras.loop?.stage ?? null,
      })
      .returning({ id: sessions.id, startedAt: sessions.startedAt });

    if (!row) throw new Error('failed to create session row');

    this.live.set(row.id, {
      id: row.id,
      startedAt: Date.now(),
      turnIdx: 0,
      buffer: null,
      writes: Promise.resolve(),
    });

    const spokenCount = questions.length || conceptQs.length || behaviouralQs.length;
    this.log.log(
      `session ${row.id} created (${config.mode}, ${model}` +
        `${spokenCount > 1 ? `, ${spokenCount} questions` : ''})`,
    );
    return {
      id: row.id,
      startedAt: row.startedAt,
      systemInstruction,
      silenceDurationMs,
      prefixPaddingMs,
      /** In the interviewer's order — see the ordering note above. */
      questions,
      starters,
    };
  }

  /**
   * Concept questions in candidate selection order, joined to topic names.
   * Stale IDs missing from the bank are logged and omitted.
   */
  private async loadConceptQuestions(ids: string[]): Promise<ConceptQuestionEntry[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .select({
        id: conceptQuestions.id,
        title: conceptQuestions.title,
        difficulty: conceptQuestions.difficulty,
        prompt: conceptQuestions.prompt,
        probes: conceptQuestions.probes,
        topicLabel: conceptTopics.label,
      })
      .from(conceptQuestions)
      .innerJoin(conceptTopics, eq(conceptTopics.id, conceptQuestions.topic))
      .where(inArray(conceptQuestions.id, ids));

    const byId = new Map(rows.map((r) => [r.id, r]));
    const picked = ids
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => !!r)
      .map((r) => ({
        id: r.id,
        title: r.title,
        difficulty: r.difficulty,
        prompt: r.prompt,
        probes: (r.probes as string[] | null) ?? [],
        topicLabel: r.topicLabel,
      }));

    if (!picked.length) throw new Error(`no concept questions matched ids: ${ids.join(', ')}`);
    if (picked.length < ids.length) {
      this.log.warn(
        `unknown concept question ids dropped: ${ids.filter((i) => !byId.has(i)).join(', ')}`,
      );
    }
    return picked;
  }

  /** Behavioural questions, in the candidate's chosen order. See above. */
  private async loadBehaviouralQuestions(ids: string[]): Promise<BehaviouralQuestionEntry[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .select({
        id: behaviouralQuestions.id,
        title: behaviouralQuestions.title,
        prompt: behaviouralQuestions.prompt,
        probes: behaviouralQuestions.probes,
        competencyLabel: behaviouralCompetencies.label,
      })
      .from(behaviouralQuestions)
      .innerJoin(
        behaviouralCompetencies,
        eq(behaviouralCompetencies.id, behaviouralQuestions.competency),
      )
      .where(inArray(behaviouralQuestions.id, ids));

    const byId = new Map(rows.map((r) => [r.id, r]));
    const picked = ids
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => !!r)
      .map((r) => ({
        id: r.id,
        title: r.title,
        prompt: r.prompt,
        probes: (r.probes as string[] | null) ?? [],
        competencyLabel: r.competencyLabel,
      }));

    if (!picked.length) throw new Error(`no behavioural questions matched ids: ${ids.join(', ')}`);
    if (picked.length < ids.length) {
      this.log.warn(
        `unknown behavioural question ids dropped: ${ids.filter((i) => !byId.has(i)).join(', ')}`,
      );
    }
    return picked;
  }

  /**
   * The HR scenario. Missing is FATAL, unlike a dropped question above: the
   * beats are the entire round, and one without them is a friendly chat about
   * money — which is the failure mode this mode exists to prevent.
   */
  private async loadHrScenario(id: string): Promise<HrScenarioEntry> {
    const [row] = await this.db.select().from(hrScenarios).where(eq(hrScenarios.id, id));
    if (!row) throw new Error(`no HR scenario ${id} — has the bank been seeded?`);
    return {
      id: row.id,
      title: row.title,
      stage: row.stage,
      persona: row.persona,
      beats: row.beats as HrScenarioEntry['beats'],
    };
  }

  /** Renders an extracted brief as prose for the interviewer's prompt. */
  private async buildBrief(config: StartSessionInput['config']): Promise<string | undefined> {
    if (config.mode === 'jd') {
      const b = await this.extraction.jobDescription(config.jobDescription);
      return b ? renderRole(b, 'interview') : undefined;
    }

    /**
     * Behavioural mode uses the experience extractor to identify vague claims
     * for follow-up questions during the interview.
     */
    if (config.mode === 'experience' || config.mode === 'behavioural') {
      if (!config.experience.trim()) return undefined;
      const b = await this.extraction.experience(config.experience);
      if (!b) return undefined;
      return [
        b.headline,
        ``,
        `Projects, with angles that would test whether they actually did the work:`,
        ...b.projects.flatMap((p) => [
          `- ${p.name}: ${p.whatTheyClaim}`,
          ...p.probeAngles.map((a) => `    · ${a}`),
        ]),
        ``,
        b.quantifiedClaims?.length
          ? `Claims with a number attached — ask how each was measured:\n${b.quantifiedClaims.map((c) => `- ${c}`).join('\n')}`
          : '',
        ``,
        b.vagueClaims.length
          ? `CLAIMS WITH NO OWNERSHIP OR NO MEASUREMENT. These are the most valuable things to push on:\n${b.vagueClaims.map((c) => `- ${c}`).join('\n')}`
          : '',
        ``,
        b.strongestArea ? `Strongest area: ${b.strongestArea}` : '',
        b.thinnestArea ? `Thinnest area, worth probing: ${b.thinnestArea}` : '',
      ].filter(Boolean).join('\n');
    }

    return undefined;
  }

  elapsedMs(sessionId: string) {
    const s = this.live.get(sessionId);
    return s ? Date.now() - s.startedAt : 0;
  }

  /**
   * Accumulates a finalised transcript fragment into the active turn buffer.
   *
   * SYNCHRONOUS BY CONTRACT: fragments arrive across rapid WebSocket frames
   * without awaiting upstream callbacks. This function must not yield between
   * reading and appending to `s.buffer` to prevent reordering. Database
   * persistence is chained onto `s.writes`.
   */
  recordFragment(sessionId: string, speaker: Speaker, text: string): void {
    const s = this.live.get(sessionId);
    if (!s || !text.trim()) return;

    if (s.buffer && s.buffer.speaker !== speaker) {
      this.closeBuffer(s);
    }
    if (!s.buffer) {
      s.buffer = { speaker, parts: [], startMs: Date.now() - s.startedAt };
    }
    s.buffer.parts.push(text.trim());
  }

  /**
   * Detaches the current turn and queues its insert. Synchronous up to and
   * including the `turnIdx` assignment, so idx order matches speech order even
   * when two turns close back to back.
   */
  private closeBuffer(s: LiveState): void {
    if (!s.buffer) return;

    const { speaker, parts, startMs } = s.buffer;
    s.buffer = null;

    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;

    const row = {
      sessionId: s.id,
      idx: s.turnIdx++,
      speaker,
      text,
      startMs,
      endMs: Date.now() - s.startedAt,
    };
    s.writes = s.writes.then(() =>
      this.db
        .insert(turns)
        .values(row)
        .catch((e) => this.log.error(`turn ${row.idx} insert failed: ${(e as Error).message}`)),
    );
  }

  /**
   * Closes the open turn and waits for every queued insert to land. Callers
   * that need the rows to be readable (evaluation, interruption marking) must
   * await this.
   */
  async flush(sessionId: string) {
    const s = this.live.get(sessionId);
    if (!s) return;
    this.closeBuffer(s);
    await s.writes;
  }

  /** Marks the interviewer's last turn as cut off by the candidate. */
  async markInterrupted(sessionId: string) {
    const s = this.live.get(sessionId);
    if (s?.buffer?.speaker === 'ai') {
      await this.flush(sessionId);
      const [last] = await this.db
        .select({ id: turns.id })
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(desc(turns.idx))
        .limit(1);
      if (last) await this.db.update(turns).set({ interrupted: true }).where(eq(turns.id, last.id));
    }
  }

  async saveContext(
    sessionId: string,
    kind: string,
    content: string,
    language?: string,
    /** Which question this buffer belongs to, when the round has more than one. */
    questionId?: string,
  ) {
    await this.db.insert(contextSnapshots).values({
      sessionId,
      kind,
      content,
      atMs: this.elapsedMs(sessionId),
    });

    // `finalCode` is the last buffer touched, for readers expecting one string;
    // `questionCode` is the per-question map a multi-question round needs.
    const patch: PgUpdateSetSource<typeof sessions> = {
      finalCode: content,
      ...(language ? { codeLanguage: language } : {}),
    };

    if (questionId) {
      /**
       * Merged in SQL, not read-modify-write: `InterviewGateway.onContext` is an
       * async handler nothing serialises, so two snapshots a few ms apart would
       * both read the map and the second write would drop the first buffer.
       * `||` on jsonb is a shallow merge — one key per question.
       */
      const entry = {
        [questionId]: { code: content, language: language ?? null, atMs: this.elapsedMs(sessionId) },
      };
      patch.questionCode = sql`coalesce(${sessions.questionCode}, '{}'::jsonb) || ${JSON.stringify(entry)}::jsonb`;
    }

    await this.db.update(sessions).set(patch).where(eq(sessions.id, sessionId));
  }

  /**
   * Records which question the round is on.
   *
   * Persisted rather than held only in the gateway's connection state so a
   * reconnect mid-round does not silently reset the editor to question one.
   */
  async setCurrentQuestion(sessionId: string, idx: number) {
    await this.db
      .update(sessions)
      .set({ currentQuestionIdx: idx })
      .where(eq(sessions.id, sessionId));
  }

  async setAiSpeakingMs(sessionId: string, ms: number) {
    await this.db.update(sessions).set({ aiSpeakingMs: ms }).where(eq(sessions.id, sessionId));
  }

  async saveResumptionHandle(sessionId: string, handle: string) {
    await this.db.update(sessions).set({ resumptionHandle: handle }).where(eq(sessions.id, sessionId));
  }

  /**
   * Records what the interviewer's silences cost, for the evaluator and for
   * whoever debugs the next one. See `sessions.interviewerStalls`.
   */
  async saveStalls(sessionId: string, stalls: StallRecord[], deadMs: number) {
    await this.db
      .update(sessions)
      .set({ interviewerStalls: stalls, deadMs })
      .where(eq(sessions.id, sessionId));
  }

  /**
   * Records speech guard interventions for evaluation and post-session diagnostics.
   */
  async saveGuardEvents(sessionId: string, events: GuardEvent[]) {
    await this.db.update(sessions).set({ guardEvents: events }).where(eq(sessions.id, sessionId));
  }

  /** See `sessions.upstreamEvents`. */
  async saveUpstreamEvents(sessionId: string, events: StoredUpstreamEvent[]) {
    await this.db.update(sessions).set({ upstreamEvents: events }).where(eq(sessions.id, sessionId));
  }

  /**
   * Returns transcript history in chronological order for session rebuilds.
   * Flushes any buffered turn before reading from the database.
   */
  async historyFor(sessionId: string): Promise<{ role: 'user' | 'model'; text: string }[]> {
    await this.flush(sessionId);
    const rows = await this.db
      .select({ speaker: turns.speaker, text: turns.text })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(turns.idx);
    return rows
      .filter((r) => r.text.trim().length > 0)
      .map((r) => ({ role: r.speaker === 'ai' ? ('model' as const) : ('user' as const), text: r.text }));
  }

  /** The chain may fall back past the model `create` recorded. */
  async setModel(sessionId: string, model: string): Promise<void> {
    await this.db.update(sessions).set({ model }).where(eq(sessions.id, sessionId));
  }

  async finalize(
    sessionId: string,
    reason: string,
    audioPath: string | undefined,
    status: 'completed' | 'aborted' | 'failed' = 'completed',
    aiAudioPath?: string,
  ) {
    await this.flush(sessionId);
    const s = this.live.get(sessionId);
    const durationMs = s ? Date.now() - s.startedAt : 0;
    const turnCount = s?.turnIdx ?? 0;
    this.live.delete(sessionId);

    // With no in-memory entry this is a second finalize (or one for a round
    // another process ran): its zero duration and absent paths must never
    // overwrite a row that has already been closed.
    await this.db
      .update(sessions)
      .set({
        status,
        endedAt: new Date(),
        durationMs,
        endReason: reason,
        audioPath: audioPath ?? null,
        aiAudioPath: aiAudioPath ?? null,
      })
      .where(s ? eq(sessions.id, sessionId) : and(eq(sessions.id, sessionId), eq(sessions.status, 'live')));

    this.log.log(`session ${sessionId} ${status} after ${(durationMs / 1000).toFixed(1)}s, ${turnCount} turns`);
    return { durationMs, turnCount };
  }

  async getTranscript(sessionId: string) {
    return this.db.select().from(turns).where(eq(turns.sessionId, sessionId)).orderBy(turns.idx);
  }
}

/**
 * An extracted job description as prose. A JD round spends its time on the
 * focus areas; an experience round only uses them to choose which of the
 * candidate's own claims to probe, so it is told what matters most, not how to
 * divide the round.
 */
export function renderRole(b: JdBrief, use: 'interview' | 'steer'): string {
  return [
    `Role: ${b.role} (${b.seniority}${b.domain ? `, ${b.domain}` : ''})`,
    ``,
    `Must have: ${b.mustHave.join('; ')}`,
    b.niceToHave?.length ? `Nice to have: ${b.niceToHave.join('; ')}` : '',
    ``,
    use === 'interview'
      ? `Spend the round on these, roughly in this proportion:`
      : `What the role weights most, highest first:`,
    ...[...b.focusAreas]
      .sort((x, y) => y.weight - x.weight)
      .map((f) => `- ${f.area} (weight ${f.weight}/5) — ${f.why}`),
    ``,
    use === 'interview' ? `Questions a real interviewer for this role would ask:` : '',
    ...(use === 'interview' ? b.likelyProbes.map((q) => `- ${q}`) : []),
  ].filter(Boolean).join('\n');
}
