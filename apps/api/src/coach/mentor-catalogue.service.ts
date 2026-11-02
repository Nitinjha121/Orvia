import { Injectable, Inject } from '@nestjs/common';
import { and, desc, eq, gte } from 'drizzle-orm';
import {
  sessions, profiles, jobDescriptions, questionCollections, conceptQuestions,
  type Database,
} from '@orvia/db';
import { HANDOUT_MIN_MS, RETIRING_OUTCOMES, type PracticeAttempt } from '@orvia/shared';
import { DB } from '../db/db.module';
import { EvaluationService } from '../evaluation/evaluation.service';
import { QuestionBankService } from '../question-bank/question-bank.service';
import { PracticeRotationService } from '../question-bank/practice-rotation.service';
import { latestEvaluations } from '../question-bank/latest-evaluations';
import { assignedIds, readStoredConfig } from '../question-bank/stored-config';
import { MentorToolsService } from './mentor-tools.service';

/**
 * Read-only catalogue queries for the mentor: question banks, user completion
 * progress, profile details, and unfinished rounds. All user queries are strictly
 * scoped to the authenticated `userId`. Solutions and rubric notes are excluded.
 */

/** Items returned by one `browse_questions` call. Enough to choose from, not a recital. */
const MAX_BROWSE = 40;
/** Spoken prompts run to a paragraph; this is enough to recognise one by. */
const PROMPT_EXCERPT = 180;
/** The profile free-text fields accept 60k characters each. */
const MAX_PROFILE_TEXT = 4_000;
const MAX_JD_EXCERPT = 800;
const MAX_JDS = 10;
/** How far back `list_unfinished_rounds` looks before it stops caring. */
const MAX_ROUNDS_SCANNED = 60;

/** The modes with a browsable bank. Not `jd` or `experience`, which have none. */
export const BROWSABLE_MODES = [
  'dsa', 'concepts', 'system_design', 'behavioural', 'hr',
] as const;
export type BrowsableMode = (typeof BROWSABLE_MODES)[number];

/**
 * Modes supported by the rotation and their outcome granularities.
 * DSA and concepts record per-question outcomes, whereas system design, behavioural,
 * and HR track assignment without individual outcome rows.
 */
const VERDICT_MODES: readonly BrowsableMode[] = ['dsa', 'concepts'];
const ROTATION_MODES = ['dsa', 'concepts', 'system_design'] as const;
type RotationMode = (typeof ROTATION_MODES)[number];
const inRotation = (m: BrowsableMode): m is RotationMode =>
  (ROTATION_MODES as readonly string[]).includes(m);

/**
 * User status on a bank item. Uses `no_verdict` when an evaluation row exists
 * but question outcomes are unrecorded (e.g. legacy rounds or in-flight transcription).
 */
type Status =
  | 'solved' | 'come_back_to' | 'no_verdict' | 'asked' | 'never_asked' | 'assigned_before';

const FILTERS = ['all', 'never_asked', 'come_back_to', 'attempted'] as const;
export type BrowseFilter = (typeof FILTERS)[number];

const excerpt = (s: string | null | undefined, n: number) =>
  !s ? null : s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

@Injectable()
export class MentorCatalogueService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bank: QuestionBankService,
    private readonly rotation: PracticeRotationService,
    /** For round labels, so an unfinished round is named the way the others are. */
    private readonly rounds: MentorToolsService,
    private readonly evaluation: EvaluationService,
  ) {}

  /* ── what this account has spent ────────────────────────────────────────── */

  /**
   * id → how the latest round to hand it out went, from `PracticeRotationService`.
   *
   * Lifetime, not this cycle: the cycle marker lives in the browser's local
   * storage and the server has never seen it.
   */
  private async attemptsFor(userId: string, mode: BrowsableMode) {
    if (!inRotation(mode)) return new Map<string, PracticeAttempt>();
    const rows = await this.rotation.attempted(userId, mode);
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * For `behavioural` and `hr`: how many rounds NAMED this item in their config.
   *
   * Weaker than `attemptsFor` and labelled as such wherever it surfaces — a
   * round assigns several and may only reach the first. The duration floor
   * still applies, or a round aborted in its first second would count.
   */
  private async assignedCounts(userId: string, mode: BrowsableMode) {
    const rows = await this.db
      .select({ config: sessions.config, startedAt: sessions.startedAt })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.mode, mode),
          eq(sessions.kind, 'round'),
          gte(sessions.durationMs, HANDOUT_MIN_MS),
        ),
      )
      .orderBy(desc(sessions.startedAt));

    const out = new Map<string, { count: number; lastAt: string }>();
    for (const r of rows) {
      for (const id of assignedIds(readStoredConfig(r.config))) {
        const prev = out.get(id);
        // Newest first, so the first sighting of an id is its latest round.
        if (prev) prev.count += 1;
        else out.set(id, { count: 1, lastAt: r.startedAt.toISOString().slice(0, 10) });
      }
    }
    return out;
  }

  private statusOf(mode: BrowsableMode, attempt: PracticeAttempt | undefined): Status {
    if (!attempt) return 'never_asked';
    if (!VERDICT_MODES.includes(mode)) return 'asked';
    if (attempt.outcome === null) return 'no_verdict';
    if (RETIRING_OUTCOMES.includes(attempt.outcome)) return 'solved';
    return 'come_back_to';
  }

  /* ── the lists ──────────────────────────────────────────────────────────── */

  /**
   * Every browsable list in every mode, with how far through each this account
   * is. The index the mentor reads before it decides what to suggest — the
   * equivalent of `list_rounds`, for questions not yet asked.
   */
  async lists(userId: string) {
    const [collections, conceptTopics, competencies, hrScenarios, design] = await Promise.all([
      this.bank.collections(),
      this.bank.conceptTopics(),
      this.bank.competencies(),
      this.bank.listHrScenarios(),
      this.bank.listSystemDesign(),
    ]);

    // Membership, ids only without solutions.
    const [dsaMembers, conceptMembers, dsaAttempts, conceptAttempts, designAttempts] =
      await Promise.all([
        this.db
          .select({ collection: questionCollections.collection, id: questionCollections.questionId })
          .from(questionCollections),
        this.db
          .select({ topic: conceptQuestions.topic, id: conceptQuestions.id })
          .from(conceptQuestions),
        this.attemptsFor(userId, 'dsa'),
        this.attemptsFor(userId, 'concepts'),
        this.attemptsFor(userId, 'system_design'),
      ]);

    const tally = (mode: 'dsa' | 'concepts', ids: string[], attempts: Map<string, PracticeAttempt>) => {
      let solved = 0, comeBackTo = 0, noVerdict = 0;
      for (const id of ids) {
        switch (this.statusOf(mode, attempts.get(id))) {
          case 'solved': solved += 1; break;
          case 'come_back_to': comeBackTo += 1; break;
          case 'no_verdict': noVerdict += 1; break;
          default: break;
        }
      }
      return {
        questions: ids.length,
        solved,
        come_back_to: comeBackTo,
        no_verdict: noVerdict,
        never_asked: ids.length - solved - comeBackTo - noVerdict,
      };
    };
    const designAsked = design.filter((p) => designAttempts.has(p.id)).length;

    const byCollection = new Map<string, string[]>();
    for (const m of dsaMembers) byCollection.set(m.collection, [...(byCollection.get(m.collection) ?? []), m.id]);
    const byTopic = new Map<string, string[]>();
    for (const m of conceptMembers) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m.id]);

    return {
      dsa: {
        lists: collections.map((c) => ({
          list: c.id,
          label: c.label,
          about: c.blurb,
          ...tally('dsa', byCollection.get(c.id) ?? [], dsaAttempts),
        })),
      },
      concepts: {
        lists: conceptTopics.map((t) => ({
          list: t.id,
          label: t.label,
          about: t.blurb,
          ...tally('concepts', byTopic.get(t.id) ?? [], conceptAttempts),
        })),
      },
      system_design: {
        // One flat bank rather than lists, so it reports as one.
        questions: design.length,
        asked: designAsked,
        never_asked: design.length - designAsked,
        note: 'System design is scored by phase, not per problem, so nothing here is solved or unsolved — only asked.',
      },
      behavioural: {
        lists: competencies.map((c) => ({
          list: c.id,
          label: c.label,
          about: c.blurb,
          questions: c.count,
        })),
        note: 'Behavioural rounds record no per-question verdict, so there is no solved count here.',
      },
      hr: {
        lists: hrScenarios.map((s) => ({ list: s.id, label: s.title, about: s.blurb, stage: s.stage })),
        note: 'An HR round is one scripted scenario rather than a bank of questions.',
      },
      note:
        'These counts are LIFETIME, not this cycle: the practice rail resets its cycle in the ' +
        'browser and the server never sees that. no_verdict means it was asked but no ' +
        'per-question verdict exists — the report may still be running, or the round may ' +
        'predate them; do not promise a verdict is coming. Pass any "list" value to ' +
        'browse_questions.',
    };
  }

  /* ── the questions themselves ───────────────────────────────────────────── */

  /**
   * Questions in a list annotated with user attempt status.
   * Supports substring search across normalized titles and topics.
   */
  async browse(
    userId: string,
    opts: { mode: BrowsableMode; list?: string; search?: string; only?: BrowseFilter; limit?: number },
  ) {
    const { mode, search } = opts;
    /**
     * The list actually READ, echoed back so the model can see it. Only DSA has
     * a list that means "everything"; `system_design` and `hr` have no sub-lists
     * and ignore one, so echoing the model's own value back would claim a
     * filter that was never applied.
     */
    const hasLists = mode === 'dsa' || mode === 'concepts' || mode === 'behavioural';
    const list = hasLists ? (opts.list ?? (mode === 'dsa' ? 'all' : undefined)) : undefined;
    const ignoredList = !hasLists && opts.list ? opts.list : undefined;
    /**
     * An unrecognised filter widens to everything rather than narrowing to
     * whatever the last branch happens to be. A model that invents "unsolved"
     * for `only` should get the whole list back and notice, not a silently
     * different list it cannot distinguish from the one it asked for.
     */
    const only: BrowseFilter = FILTERS.includes(opts.only as BrowseFilter)
      ? (opts.only as BrowseFilter)
      : 'all';
    const limit = Math.min(Math.max(opts.limit ?? MAX_BROWSE, 1), MAX_BROWSE);

    type Item = { id: string; title: string; prompt: string | null; facets: Record<string, unknown> };
    let items: Item[];

    switch (mode) {
      case 'dsa': {
        /**
         * An omitted list means the WHOLE bank, which is the `all` collection —
         * not `listDsa`'s own default of NeetCode 150. Measured here: `all` is
         * 246 questions to NeetCode's 150, so the default left 96 unsearchable
         * and had the mentor answer "you have never been asked that" about a
         * problem it had simply not looked at. `all` is rebuilt from the whole
         * table at the end of every ingest, so it IS the bank.
         */
        const rows = await this.bank.listDsa(list);
        items = rows.map((q) => ({
          id: q.id,
          title: q.title,
          prompt: q.prompt,
          facets: { difficulty: q.difficulty, topics: q.topics, paid_only: !!q.practiceUrl },
        }));
        break;
      }
      case 'concepts': {
        const rows = await this.bank.listConcepts(list);
        items = rows.map((q) => ({
          id: q.id,
          title: q.title,
          prompt: q.prompt,
          facets: { topic: q.topic, difficulty: q.difficulty },
        }));
        break;
      }
      case 'system_design': {
        const rows = await this.bank.listSystemDesign();
        items = rows.map((p) => ({
          id: p.id, title: p.title, prompt: p.prompt, facets: { level: p.level },
        }));
        break;
      }
      case 'behavioural': {
        const rows = await this.bank.listBehavioural(list);
        items = rows.map((q) => ({
          id: q.id, title: q.title, prompt: q.prompt, facets: { competency: q.competency },
        }));
        break;
      }
      case 'hr': {
        const rows = await this.bank.listHrScenarios();
        items = rows.map((s) => ({
          id: s.id, title: s.title, prompt: s.blurb, facets: { stage: s.stage },
        }));
        break;
      }
    }

    const total = items.length;

    if (search) {
      const want = norm(search);
      items = items.filter((q) => {
        const topics = Array.isArray(q.facets.topics) ? (q.facets.topics as string[]).join(' ') : '';
        return norm(`${q.title} ${topics}`).includes(want);
      });
    }

    const rotation = inRotation(mode);
    const verdicts = VERDICT_MODES.includes(mode);
    const attempts = await this.attemptsFor(userId, mode);
    const assigned = rotation
      ? new Map<string, { count: number; lastAt: string }>()
      : await this.assignedCounts(userId, mode);

    const annotated = items.map((q) => {
      const a = attempts.get(q.id);
      const asn = assigned.get(q.id);
      const status: Status = rotation
        ? this.statusOf(mode, a)
        : asn ? 'assigned_before' : 'never_asked';
      return {
        id: q.id,
        title: q.title,
        ...q.facets,
        about: excerpt(q.prompt, PROMPT_EXCERPT),
        status,
        times_asked: rotation ? (a?.count ?? 0) : (asn?.count ?? 0),
        last_asked: rotation ? (a?.lastAt?.slice(0, 10) ?? null) : (asn?.lastAt ?? null),
      };
    });

    const keep = annotated.filter((q) => {
      if (only === 'all') return true;
      if (only === 'never_asked') return q.status === 'never_asked';
      if (only === 'come_back_to') return q.status === 'come_back_to';
      return q.status !== 'never_asked';
    });

    return {
      mode,
      list: list ?? 'the whole bank',
      filter: only,
      total_in_list: total,
      matching: keep.length,
      showing: Math.min(keep.length, limit),
      questions: keep.slice(0, limit),
      note:
        (keep.length > limit
          ? `Only the first ${limit} of ${keep.length} are shown — narrow it with search or only. `
          : '') +
        (ignoredList ? `${mode} has no sub-lists, so "${ignoredList}" was ignored and the whole bank read. ` : '') +
        (verdicts
          ? 'status is from the LATEST round that asked it: solved retires it, come_back_to means ' +
            'they were asked and did not get there, no_verdict means it was asked but nothing ' +
            'scored it — do not tell them a verdict is on its way.'
          : rotation
            ? 'System design is scored by phase, not per problem, so status only says whether a ' +
              'round was put to them — asked or never_asked — never how it went.'
            : 'This mode records no per-question verdict, so status only says whether a round was ' +
              'ever SET UP with it — not whether the interviewer actually reached it.'),
    };
  }

  /* ── who they are ───────────────────────────────────────────────────────── */

  /**
   * What this account told us about itself: the target role, the experience the
   * `experience` mode probes, the resume, and the saved job descriptions.
   *
   * Never created on read. `GET /api/profile` inserts a default row when one is
   * missing, and the mentor is read-only — so an account that has never opened
   * the profile page gets an empty answer and a note saying so, not a row.
   */
  async profile(userId: string) {
    const [row] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    const jds = await this.db
      .select({
        label: jobDescriptions.label,
        company: jobDescriptions.company,
        content: jobDescriptions.content,
        createdAt: jobDescriptions.createdAt,
      })
      .from(jobDescriptions)
      .where(eq(jobDescriptions.userId, userId))
      .orderBy(desc(jobDescriptions.createdAt))
      .limit(MAX_JDS);

    return {
      filled_in: !!row,
      target_role: row?.targetRole ?? null,
      years_experience: row?.yearsExperience ?? null,
      /** What `experience` rounds probe — projects, ownership, the things they did. */
      their_experience: excerpt(row?.experience, MAX_PROFILE_TEXT),
      resume: excerpt(row?.resume, MAX_PROFILE_TEXT),
      preferred_language: row?.preferredLanguage ?? null,
      session_defaults: row
        ? {
            minutes: row.defaultDurationMinutes,
            difficulty: row.defaultDifficulty,
            persona: row.defaultPersona,
            voice: row.defaultVoice,
            /** How long they may pause before the interviewer takes its turn. */
            pause_tolerance_ms: row.silenceDurationMs,
          }
        : null,
      job_descriptions: jds.map((j) => ({
        label: j.label,
        company: j.company,
        saved_on: j.createdAt.toISOString().slice(0, 10),
        about: excerpt(j.content, MAX_JD_EXCERPT),
      })),
      note: row
        ? 'This is what THEY wrote about themselves, not anything measured. Treat it as their ' +
          'own account of their experience.'
        : 'They have not filled in a profile yet, so there is nothing here to work from.',
    };
  }

  /* ── the rounds that produced nothing ───────────────────────────────────── */

  /**
   * Rounds without a complete report and their status.
   * Delegates missing-reason diagnosis to `EvaluationService.describeMissing`.
   */
  async unfinishedRounds(userId: string) {
    const rows = await this.db
      .select({
        id: sessions.id,
        mode: sessions.mode,
        startedAt: sessions.startedAt,
        durationMs: sessions.durationMs,
        config: sessions.config,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'round')))
      .orderBy(desc(sessions.startedAt))
      .limit(MAX_ROUNDS_SCANNED);
    if (!rows.length) return { rounds: [], note: 'They have not run any rounds yet.' };

    const ids = rows.map((r) => r.id);
    const [complete, latest] = await Promise.all([
      latestEvaluations(this.db, ids),
      latestEvaluations(this.db, ids, { completeOnly: false }),
    ]);
    const open = rows.filter((r) => !complete.has(r.id));
    const titles = await this.rounds.titlesFor(open.map((r) => r.config));

    const unfinished = await Promise.all(
      open.map(async (r) => {
        const evalStatus = latest.get(r.id)?.status;
        let reason: string;
        let can_rerun: boolean;

        if (evalStatus === 'failed') {
          reason = 'The evaluation failed. It can be re-run from the report page.';
          can_rerun = true;
        } else if (evalStatus) {
          reason =
            'The report is still being written — a round is re-transcribed from scratch, which ' +
            'takes several minutes for a long one.';
          can_rerun = false;
        } else {
          const missing = await this.evaluation.describeMissing(r.id);
          reason = missing.pending
            ? 'The report is just starting to be written.'
            : (missing.reason ?? 'No report exists for this round.');
          can_rerun = missing.evaluable && !missing.pending;
        }

        return {
          round: titles.get(JSON.stringify(r.config)) ?? r.mode,
          mode: r.mode,
          date: r.startedAt.toISOString().slice(0, 10),
          minutes: r.durationMs ? Math.round(r.durationMs / 60000) : null,
          reason,
          can_rerun,
        };
      }),
    );

    return {
      rounds: unfinished,
      note: unfinished.length
        ? 'Only offer a re-run where can_rerun is true. The rest have nothing to score or are ' +
          'already working.'
        : 'Every round they have run has a finished report.',
    };
  }
}
