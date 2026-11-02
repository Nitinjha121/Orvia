import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  sessions, turns, evaluations, questionEvaluations, deliveryScores, speechMetrics,
  verbatimTranscripts, contextSnapshots, dsaQuestions, mentorMemories,
  conceptQuestions, behaviouralQuestions, hrScenarios,
  coachConversations, coachMessages,
  type Database,
} from '@orvia/db';
import { DB } from '../db/db.module';
import { latestEvaluations } from '../question-bank/latest-evaluations';
import { readStoredConfig } from '../question-bank/stored-config';

/**
 * On-demand queries for the mentor: transcripts, recordings, code, reports, and memory.
 * Read-only except for memory mutations, with all queries scoped by `userId`.
 */

/** Hard cap on a returned transcript, so one tool call cannot blow the window. */
const MAX_TRANSCRIPT_CHARS = 24_000;
/** How far back the conversation index reaches. */
const MAX_CONVERSATIONS_LISTED = 40;
/** Memories kept per user. Past this, the least reinforced are pruned. */
const MAX_MEMORIES = 60;
/**
 * Word-overlap similarity threshold (0.5) for merging near-duplicate memories
 * without needing an embedding model.
 */
const MEMORY_MERGE_OVERLAP = 0.5;

/**
 * Shared words required before a merge, however high the ratio.
 *
 * The ratio divides by the SHORTER memory, so a four-word note scores 0.5 off
 * two coincidental words and would swallow an unrelated memory. This floor is
 * what makes a low threshold safe.
 */
const MEMORY_MERGE_MIN_SHARED = 3;

export type ResolvedSession = {
  id: string;
  mode: string;
  startedAt: Date;
  durationMs: number | null;
  audioPath: string | null;
  finalCode: string | null;
  codeLanguage: string | null;
  config: unknown;
  label: string;
};

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Significant-word overlap, with the count of shared words for the floor above. */
const similarity = (a: string, b: string): { ratio: number; shared: number } => {
  const wa = new Set(norm(a).split(' ').filter((w) => w.length > 3));
  const wb = new Set(norm(b).split(' ').filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return { ratio: 0, shared: 0 };
  let shared = 0;
  wa.forEach((w) => { if (wb.has(w)) shared++; });
  return { ratio: shared / Math.min(wa.size, wb.size), shared };
};

/**
 * Whether a new memory is a restatement of an existing one. Exported so the
 * calibration above is covered by `verify:guards` rather than only by having
 * been eyeballed once.
 */
export const isNearDuplicate = (a: string, b: string) => {
  const { ratio, shared } = similarity(a, b);
  return ratio >= MEMORY_MERGE_OVERLAP && shared >= MEMORY_MERGE_MIN_SHARED;
};

/**
 * Resolves which memory `forget` should delete (exact ID, text match, or distinct best near-duplicate),
 * or returns candidates for disambiguation.
 */
export function pickMemoryToForget<M extends { id: string; content: string }>(
  memories: readonly M[],
  ref: string,
): { target: M } | { candidates: M[] } {
  const want = ref.trim();
  const exact =
    memories.find((m) => m.id === want) ?? memories.find((m) => norm(m.content) === norm(want));
  if (exact) return { target: exact };

  const near = memories
    .filter((m) => isNearDuplicate(m.content, want))
    .map((m) => ({ m, ...similarity(m.content, want) }))
    .sort((a, b) => b.ratio - a.ratio || b.shared - a.shared);
  const [best, next] = near;
  if (best && (!next || best.ratio > next.ratio || best.shared > next.shared)) {
    return { target: best.m };
  }
  return { candidates: near.map((n) => n.m) };
}

/**
 * Regex for ordinal round references ("latest", "2nd", "2 rounds back").
 * Anchored so titles with numbers are not misclassified as ordinals.
 */
const ORDINAL_REF = /^(?:round\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+rounds?)?(?:\s+(?:ago|back))?$/;

/**
 * Index into newest-first `rows` for a round reference, or -1.
 *
 * Pure so `verify:guards` can drive it; `resolveSession` supplies the rows.
 */
export function matchRoundRef(
  ref: string | undefined,
  rows: readonly { id: string; startedAt: Date }[],
  titleAt: (i: number) => string | undefined,
): number {
  if (!rows.length) return -1;
  const want = (ref ?? 'latest').trim().toLowerCase();
  if (!want || want === 'latest' || want === 'last' || want === 'most recent') return 0;
  if (want === 'first' || want === 'earliest' || want === 'oldest') return rows.length - 1;

  if (want.length >= 6) {
    const byId = rows.findIndex((r) => r.id === want || r.id.startsWith(want));
    if (byId >= 0) return byId;
  }

  const ordinal = ORDINAL_REF.exec(want);
  if (ordinal) {
    const n = Number(ordinal[1]);
    if (n >= 1 && n <= rows.length) return n - 1;
  }

  const byDate = rows.findIndex((r) => r.startedAt.toISOString().slice(0, 10).includes(want));
  if (byDate >= 0) return byDate;

  return rows.findIndex((_, i) => {
    const t = titleAt(i);
    return !!t && (norm(t).includes(norm(want)) || norm(want).includes(norm(t)));
  });
}

@Injectable()
export class MentorToolsService {
  private readonly log = new Logger(MentorToolsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /* ── finding the round being talked about ───────────────────────────────── */

  /**
   * Resolves a round reference ("latest", ordinal, date, or problem title) to a session row.
   * Ordinals count back from the most recent completed round.
   */
  async resolveSession(userId: string, ref: string | undefined): Promise<ResolvedSession | null> {
    const rows = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
        audioPath: sessions.audioPath,
        finalCode: sessions.finalCode,
        codeLanguage: sessions.codeLanguage,
        config: sessions.config,
      })
      .from(sessions)
      // Rounds only, in both places the mentor counts back through history:
      // "two rounds ago" must not land on a five-minute drill.
      .where(and(eq(sessions.userId, userId), eq(sessions.status, 'completed'), eq(sessions.kind, 'round')))
      .orderBy(desc(sessions.startedAt));
    if (!rows.length) return null;

    const titles = await this.titlesFor(rows.map((r) => r.config));
    const decorate = (r: (typeof rows)[number], i: number): ResolvedSession => {
      const title = titles.get(JSON.stringify(r.config)) ?? r.mode;
      const when = r.startedAt.toISOString().slice(0, 10);
      return {
        ...r,
        label: `${title} (${when}, ${i === 0 ? 'most recent' : `${i + 1} rounds back`})`,
      };
    };

    const i = matchRoundRef(ref, rows, (n) => titles.get(JSON.stringify(rows[n]!.config)));
    return i >= 0 ? decorate(rows[i]!, i) : null;
  }

  /**
   * Derives human-readable round titles from session configs.
   * Unresolved IDs fall back to the slug rather than empty text.
   */
  async titlesFor(configs: unknown[]): Promise<Map<string, string>> {
    const parsed = configs.map(readStoredConfig);
    const idsFor = (mode: string) => [
      ...new Set(parsed.flatMap((cfg) => (cfg.mode === mode ? (cfg.questionIds ?? []) : []))),
    ];
    const ids = idsFor('dsa');
    const conceptIds = idsFor('concepts');
    const behaviouralIds = idsFor('behavioural');
    const scenarioIds = [
      ...new Set(parsed.flatMap((cfg) => (cfg.mode === 'hr' && cfg.scenarioId ? [cfg.scenarioId] : []))),
    ];

    const [bank, conceptBank, behaviouralBank, scenarioBank] = await Promise.all([
      ids.length
        ? this.db
            .select({ id: dsaQuestions.id, title: dsaQuestions.title })
            .from(dsaQuestions)
            .where(inArray(dsaQuestions.id, ids))
        : Promise.resolve([]),
      conceptIds.length
        ? this.db
            .select({ id: conceptQuestions.id, title: conceptQuestions.title })
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

    const byId = new Map(bank.map((q) => [q.id, q.title]));
    const conceptById = new Map(conceptBank.map((q) => [q.id, q.title]));
    const behaviouralById = new Map(behaviouralBank.map((q) => [q.id, q.title]));
    const scenarioById = new Map(scenarioBank.map((q) => [q.id, q.title]));

    const out = new Map<string, string>();
    for (const [i, c] of configs.entries()) {
      const cfg = parsed[i]!;
      const key = JSON.stringify(c);
      const join = (lookup: Map<string, string>) =>
        (cfg.questionIds ?? []).map((i) => lookup.get(i) ?? i).join(', ');

      if (cfg.mode === 'dsa') {
        out.set(key, join(byId));
      } else if (cfg.mode === 'concepts') {
        out.set(key, join(conceptById));
      } else if (cfg.mode === 'behavioural') {
        out.set(key, join(behaviouralById));
      } else if (cfg.mode === 'hr' && cfg.scenarioId) {
        out.set(key, scenarioById.get(cfg.scenarioId) ?? cfg.scenarioId);
      } else if (cfg.mode === 'system_design' && cfg.problem) {
        out.set(key, cfg.problem.slice(0, 60));
      }
    }
    return out;
  }

  /** Index of every round, for the model to pick from before fetching detail. */
  async listRounds(userId: string) {
    const rows = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
        config: sessions.config,
        hasAudio: sql<boolean>`${sessions.audioPath} is not null`,
      })
      .from(sessions)
      // Rounds only, in both places the mentor counts back through history:
      // "two rounds ago" must not land on a five-minute drill.
      .where(and(eq(sessions.userId, userId), eq(sessions.status, 'completed'), eq(sessions.kind, 'round')))
      .orderBy(desc(sessions.startedAt));

    const titles = await this.titlesFor(rows.map((r) => r.config));
    // The latest COMPLETE report: a re-run that failed or is still running
    // must not blank the score of a round that has one.
    const latest = await latestEvaluations(this.db, rows.map((r) => r.id));

    return {
      rounds: rows.map((r, i) => ({
        ref: i === 0 ? 'latest' : String(i + 1),
        rounds_back: i,
        date: r.startedAt.toISOString().slice(0, 10),
        mode: r.mode,
        problems: titles.get(JSON.stringify(r.config)) ?? null,
        minutes: r.durationMs ? Math.round(r.durationMs / 60000) : null,
        score: latest.get(r.id)?.overallScore ?? null,
        verdict: latest.get(r.id)?.overallVerdict ?? null,
        recording_available: r.hasAudio,
      })),
      note: 'Pass any "ref" from this list to the other tools, or a problem name or date.',
    };
  }

  /* ── the round in detail ────────────────────────────────────────────────── */

  /**
   * The conversation as it happened.
   * Returns live transcript and verbatim re-transcription (with disfluencies preserved).
   */
  async getTranscript(userId: string, ref: string | undefined) {
    const s = await this.resolveSession(userId, ref);
    if (!s) return { error: `no round matches "${ref ?? 'latest'}". Call list_rounds first.` };

    const [rows, verbatim] = await Promise.all([
      this.db.select().from(turns).where(eq(turns.sessionId, s.id)).orderBy(asc(turns.idx)),
      this.db
        .select({ fullText: verbatimTranscripts.fullText })
        .from(verbatimTranscripts)
        .where(eq(verbatimTranscripts.sessionId, s.id)),
    ]);

    const mmss = (ms: number) =>
      `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

    let text = rows
      .map((t) => `[${mmss(t.startMs)}] ${t.speaker === 'ai' ? 'INTERVIEWER' : 'YOU'}: ${t.text}`)
      .join('\n');
    let truncated = false;
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      text = text.slice(0, MAX_TRANSCRIPT_CHARS);
      truncated = true;
    }

    return {
      round: s.label,
      transcript: text,
      truncated,
      verbatim_transcript: verbatim[0]?.fullText?.slice(0, MAX_TRANSCRIPT_CHARS) ?? null,
      note: truncated
        ? 'Transcript was cut to fit. Say so rather than implying you read all of it.'
        : undefined,
    };
  }

  /**
   * Index of past coach and mentor conversations.
   *
   * Deliberately an index and not the content: a conversation runs to tens of
   * thousands of characters, and the mentor usually only needs to know that a
   * drill was agreed three sessions ago, not to re-read it.
   */
  async listConversations(userId: string) {
    const rows = await this.db
      .select({
        id: coachConversations.id,
        scope: coachConversations.scope,
        startedAt: coachConversations.startedAt,
        durationMs: coachConversations.durationMs,
        messageCount: coachConversations.messageCount,
      })
      .from(coachConversations)
      .where(eq(coachConversations.userId, userId))
      .orderBy(desc(coachConversations.startedAt))
      .limit(MAX_CONVERSATIONS_LISTED);

    return {
      conversations: rows.map((r, i) => ({
        // Counting back from the most recent, matching how rounds are named —
        // the model is never handed a uuid to repeat back, because it gets
        // them wrong.
        ref: String(i + 1),
        date: r.startedAt.toISOString().slice(0, 10),
        kind: r.scope === 'account' ? 'mentor' : 'coach',
        minutes: Math.round(r.durationMs / 60000),
        messages: r.messageCount,
      })),
      note:
        rows.length === 0
          ? 'You have not talked to them before, or this is the first conversation being kept.'
          : 'These are past CONVERSATIONS, not interview rounds. Use get_conversation to read one.',
    };
  }

  /**
   * Fetches a past coach/mentor conversation by ordinal or date.
   * Long transcripts are capped, retaining the end where conclusions are formed.
   */
  async getConversation(userId: string, ref: string | undefined) {
    const rows = await this.db
      .select({
        id: coachConversations.id,
        scope: coachConversations.scope,
        startedAt: coachConversations.startedAt,
        durationMs: coachConversations.durationMs,
      })
      .from(coachConversations)
      .where(eq(coachConversations.userId, userId))
      .orderBy(desc(coachConversations.startedAt))
      .limit(MAX_CONVERSATIONS_LISTED);
    if (!rows.length) return { error: 'there are no saved conversations yet' };

    const want = ref?.trim();
    let picked = rows[0]!;
    if (want && want !== 'latest') {
      const n = Number(want);
      if (Number.isFinite(n) && n >= 1 && n <= rows.length) {
        picked = rows[n - 1]!;
      } else {
        const byDate = rows.find((r) => r.startedAt.toISOString().slice(0, 10).includes(want));
        if (!byDate) {
          return { error: `no conversation matches "${want}". Call list_conversations first.` };
        }
        picked = byDate;
      }
    }

    const messages = await this.db
      .select({ speaker: coachMessages.speaker, text: coachMessages.text })
      .from(coachMessages)
      .where(eq(coachMessages.conversationId, picked.id))
      .orderBy(asc(coachMessages.idx));

    const kind = picked.scope === 'account' ? 'mentor' : 'coach';
    let text = messages
      .map((m) => `${m.speaker === 'ai' ? kind.toUpperCase() : 'YOU'}: ${m.text}`)
      .join('\n');
    let truncated = false;
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      text = text.slice(text.length - MAX_TRANSCRIPT_CHARS);
      truncated = true;
    }

    return {
      date: picked.startedAt.toISOString().slice(0, 10),
      kind,
      minutes: Math.round(picked.durationMs / 60000),
      conversation: text,
      truncated,
      note: truncated
        ? 'Only the LAST part of this conversation fitted. Say so rather than implying you read all of it.'
        : undefined,
    };
  }

  /** The written report: scores, per-dimension evidence, per-question breakdown. */
  async getReport(userId: string, ref: string | undefined) {
    const s = await this.resolveSession(userId, ref);
    if (!s) return { error: `no round matches "${ref ?? 'latest'}". Call list_rounds first.` };

    const [ev] = await this.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.sessionId, s.id), eq(evaluations.status, 'complete')))
      .orderBy(desc(evaluations.createdAt))
      .limit(1);
    if (!ev) return { round: s.label, error: 'this round has no completed report' };

    const [qs, dims, [m]] = await Promise.all([
      this.db.select().from(questionEvaluations)
        .where(eq(questionEvaluations.evaluationId, ev.id)).orderBy(asc(questionEvaluations.idx)),
      this.db.select().from(deliveryScores).where(eq(deliveryScores.evaluationId, ev.id)),
      this.db.select().from(speechMetrics).where(eq(speechMetrics.sessionId, s.id)),
    ]);

    return {
      round: s.label,
      overall_score: ev.overallScore,
      verdict: ev.overallVerdict,
      summary: ev.summary,
      top_fixes: ev.topFixes,
      rubric_version: ev.rubricVersion,
      // Flagged because a transcript-only report's delivery scores are weaker
      // evidence, and the mentor must not present them as if it had listened.
      evaluator_heard_the_audio: ev.audioAnalysed,
      delivery: dims.map((d) => ({
        dimension: d.dimension,
        score: d.score,
        assessment: d.assessment,
        your_words: d.evidenceQuote,
        at_ms: d.evidenceAtMs,
      })),
      questions: qs.map((q) => ({
        question: q.question,
        score: q.score,
        verdict: q.verdict,
        what_you_said: q.myAnswer,
        a_strong_answer: q.idealAnswer,
        good: q.whatWasGood,
        missing: q.whatWasMissing,
        how_to_improve: q.howToImprove,
      })),
      measured_speech: m
        ? {
            words_per_minute: m.wordsPerMinute,
            filler_per_100_words: m.fillerRate,
            filler_breakdown: m.fillerBreakdown,
            talk_ratio: m.talkRatio,
            median_pause_before_answering_ms: m.medianResponseLatencyMs,
            longest_stretch_nobody_spoke_ms: m.longestSilenceMs,
            speaking_seconds: m.totalSpeakingMs != null ? Math.round(m.totalSpeakingMs / 1000) : null,
          }
        : null,
    };
  }

  /** What they actually typed, for a coding round. */
  async getCode(userId: string, ref: string | undefined) {
    const s = await this.resolveSession(userId, ref);
    if (!s) return { error: `no round matches "${ref ?? 'latest'}". Call list_rounds first.` };

    const [ev] = await this.db
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(and(eq(evaluations.sessionId, s.id), eq(evaluations.status, 'complete')))
      .orderBy(desc(evaluations.createdAt))
      .limit(1);

    const model = ev
      ? await this.db
          .select({
            solution: questionEvaluations.modelSolution,
            language: questionEvaluations.modelSolutionLanguage,
          })
          .from(questionEvaluations)
          .where(eq(questionEvaluations.evaluationId, ev.id))
          .orderBy(asc(questionEvaluations.idx))
      : [];

    const snapshots = await this.db
      .select({ atMs: contextSnapshots.atMs })
      .from(contextSnapshots)
      .where(eq(contextSnapshots.sessionId, s.id));

    return {
      round: s.label,
      language: s.codeLanguage,
      your_code: s.finalCode ?? null,
      // How much they typed and when is itself a signal — a single snapshot at
      // the end means they wrote it in one go, twenty means they iterated.
      edits_captured: snapshots.length,
      first_edit_at_ms: snapshots.length ? Math.min(...snapshots.map((x) => x.atMs)) : null,
      model_solutions: model.filter((x) => x.solution).map((x) => ({
        language: x.language,
        code: x.solution,
      })),
    };
  }

  /* ── memory ─────────────────────────────────────────────────────────────── */

  async listMemories(userId: string) {
    return this.db
      .select()
      .from(mentorMemories)
      .where(eq(mentorMemories.userId, userId))
      .orderBy(desc(mentorMemories.timesObserved), desc(mentorMemories.updatedAt));
  }

  /**
   * Persists a mentor memory, merging into near-duplicates and incrementing
   * `timesObserved` rather than storing duplicate observations.
   */
  async remember(
    userId: string,
    content: string,
    kind: string | undefined,
    sourceSessionId?: string | null,
  ) {
    const clean = content.trim();
    if (clean.length < 8) return { error: 'too short to be worth remembering' };
    if (clean.length > 500) return { error: 'too long — keep a memory to a sentence or two' };

    const existing = await this.listMemories(userId);
    const near = existing.find((m) => isNearDuplicate(m.content, clean));

    if (near) {
      const [updated] = await this.db
        .update(mentorMemories)
        .set({
          // The newer phrasing wins: it reflects the most recent evidence.
          content: clean,
          kind: kind ?? near.kind,
          timesObserved: near.timesObserved + 1,
          updatedAt: new Date(),
          ...(sourceSessionId ? { sourceSessionId } : {}),
        })
        .where(eq(mentorMemories.id, near.id))
        .returning();
      this.log.log(`memory reinforced (x${updated?.timesObserved}): ${clean.slice(0, 80)}`);
      return {
        saved: true,
        merged_into_existing: true,
        times_observed: updated?.timesObserved,
        id: near.id,
      };
    }

    const [row] = await this.db
      .insert(mentorMemories)
      .values({
        userId,
        kind: kind ?? 'pattern',
        content: clean,
        sourceSessionId: sourceSessionId ?? null,
      })
      .returning();

    // Prune the least reinforced, oldest first, so the list stays readable.
    if (existing.length + 1 > MAX_MEMORIES) {
      const victims = [...existing]
        .sort(
          (a, b) =>
            a.timesObserved - b.timesObserved ||
            a.updatedAt.getTime() - b.updatedAt.getTime(),
        )
        .slice(0, existing.length + 1 - MAX_MEMORIES);
      if (victims.length) {
        await this.db
          .delete(mentorMemories)
          .where(inArray(mentorMemories.id, victims.map((v) => v.id)));
        this.log.warn(`pruned ${victims.length} least-reinforced memories`);
      }
    }

    this.log.log(`memory saved: ${clean.slice(0, 80)}`);
    return { saved: true, merged_into_existing: false, id: row?.id };
  }

  /** Drops a memory that has stopped being true — see `pickMemoryToForget`. */
  async forget(userId: string, ref: string) {
    const want = ref.trim();
    const picked = pickMemoryToForget(await this.listMemories(userId), want);
    if ('candidates' in picked) {
      return picked.candidates.length
        ? {
            forgotten: false,
            error: 'more than one memory could be the one you mean — nothing was deleted. Pass the id.',
            candidates: picked.candidates.map((m) => ({ id: m.id, content: m.content })),
          }
        : { forgotten: false, error: `no memory matches "${want.slice(0, 60)}". Call list_memories and pass its id.` };
    }

    const target = picked.target;
    await this.db
      .delete(mentorMemories)
      .where(and(eq(mentorMemories.id, target.id), eq(mentorMemories.userId, userId)));
    this.log.log(`memory forgotten: ${target.content.slice(0, 80)}`);
    return { forgotten: true, was: target.content };
  }
}
