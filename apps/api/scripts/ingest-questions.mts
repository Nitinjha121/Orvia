/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUESTION BANK INGEST
 * ─────────────────────────────────────────────────────────────────────────────
 *  Builds the DSA bank from curated lists, of which there are two KINDS:
 *
 *    leetcode-list — someone's public LeetCode favourite list, fetched whole
 *                    (neetcode150, google)
 *    curated       — a list of slugs committed in this repo, resolved one by
 *                    one (the company lists — see data/company-lists.mts for
 *                    why they cannot be fetched)
 *
 *  Both kinds end up in exactly the same place: one row per problem in
 *  `dsa_questions`, plus a link row per list it belongs to. A problem in
 *  NeetCode 150 and the Amazon list is stored ONCE with two links.
 *
 *  For each problem it pulls the statement from LeetCode's public GraphQL API
 *  and rewrites it with gemini-3.6-flash into something an interviewer can
 *  actually SAY: one short spoken paragraph, no markdown, no example tables,
 *  numbers written as words. It also derives a reference solution, the optimal
 *  complexity and the key insights — all of which go to the evaluator only.
 *
 *  Finally it rebuilds the `all` collection, which is every problem in the
 *  bank rather than a curated list of its own. See `rebuildAllCollection`.
 *
 *  Every result is cached to scripts/data/cache/<slug>.json, so re-running is
 *  free and interrupted runs resume. Delete a cache file to regenerate one.
 *
 *  Usage:  pnpm --filter @orvia/api ingest          (all lists)
 *          pnpm --filter @orvia/api ingest google   (one list)
 *          pnpm --filter @orvia/api ingest amazon   (one company list)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { type CodeSnippets } from '@orvia/shared';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, dsaQuestions, questionCollections, collections, type Database } from '@orvia/db';
import { MODELS } from '@orvia/shared';
import { asc, sql as raw } from 'drizzle-orm';
import { COMPANY_LISTS } from './data/company-lists.mts';
import { fetchDetail, gql, keepConstraints, sleep } from './leetcode.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const CACHE = join(DATA, 'cache');

/**
 * Adding a category is one entry here — the collection row, the questions and
 * the links are all created from it. Problems shared with an existing list are
 * stored once and simply gain another link.
 *
 * `source` decides only WHERE the list of problems comes from. Everything
 * after that is identical for both kinds.
 */
type ListSpec = { name: string; label: string; blurb: string } & (
  /** A public LeetCode favourite list, fetched whole by its slug. */
  | { source: 'leetcode-list'; slug: string }
  /** Slugs committed in this repo, resolved individually. */
  | { source: 'curated'; slugs: readonly string[] }
);

const LISTS: readonly ListSpec[] = [
  {
    name: 'neetcode150',
    source: 'leetcode-list',
    slug: 'plakya4j',
    label: 'NeetCode 150',
    blurb: 'The standard interview-prep set, covering every core pattern.',
  },
  {
    name: 'google',
    source: 'leetcode-list',
    slug: '7p55wqm',
    label: 'Top Google Questions',
    blurb: 'Frequently asked at Google. Heavier on hard graph and DP problems.',
  },
  ...COMPANY_LISTS.map((c) => ({ ...c, source: 'curated' as const })),
];

/**
 * Derived collection containing every problem in the bank.
 * Stored as a regular collection row with link rows. `orderIdx` places it
 * last in the rail so curated lists remain the default.
 */
/**
 * Problems that belong in the bank but in no curated list.
 * Added to the table and surfaced via the `all` collection.
 */
const STANDALONE_SLUGS = ['power-of-two'] as const;

const ALL_COLLECTION = {
  id: 'all',
  label: 'All questions',
  blurb: 'Every problem in the bank, from every list. Search or filter to narrow it down.',
  orderIdx: 1000,
};

/** Newest first, stepping down one version at a time. See MODELS.extractorChain. */
const MODELS_TRY = [...MODELS.extractorChain];
/** Kept modest so free-tier RPM limits do not turn every call into a retry. */
const CONCURRENCY = 3;

type LcQuestion = {
  questionFrontendId: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  paidOnly: boolean;
  topicTags: { name: string }[];
};

/**
 * Where a problem's spoken statement came from. Recorded per problem because
 * the bank is genuinely mixed, and "is this prompt trustworthy" has three
 * different answers:
 *
 *   leetcode  — LeetCode's own statement, cut for reading aloud. The default.
 *   neetcode  — that site's own wording of the same problem, scraped by
 *   lintcode    `pnpm scrape:premium`. A real statement, just not LeetCode's.
 *   model     — reconstructed from the title and tags because the problem is
 *               paid-only and neither site publishes it. Plausible, unverified.
 *   fallback  — the generic "state the problem in your own words" filler. Not
 *               a question; only ever the result of running out of quota.
 */
type PromptSource = 'leetcode' | 'neetcode' | 'lintcode' | 'model' | 'fallback';

type Generated = {
  prompt: string;
  referenceSolution: string;
  /**
   * Starter skeletons keyed by our editor language id.
   *
   * LeetCode's own for the 229 free problems. For a paid-only one LeetCode
   * publishes NOTHING — its GraphQL returns `codeSnippets: null` beside the
   * null `content` — so those come from LintCode via `pnpm scrape:premium`,
   * and are LintCode's signatures rather than LeetCode's. See `practiceUrl`.
   */
  codeSnippets: CodeSnippets;
  /**
   * Practice URL where the candidate can run their solution when it is not LeetCode.
   * Set for paid-only problems whose skeletons come from LintCode.
   */
  practiceUrl?: string;
  optimalComplexity: string;
  keyInsights: string[];
  /**
   * LeetCode's "Constraints:" lines — see `extractConstraints`. `undefined`
   * on a cache entry written before they were kept, which is what makes that
   * entry stale; `null` once fetched and found to have none.
   */
  constraints?: string[] | null;
  fromTitleOnly: boolean;
  promptSource?: PromptSource;
  /** Which model produced this, so a mixed-provenance bank stays auditable. */
  model?: string;
};

/**
 * Statements scraped from NeetCode and LintCode for the paid-only problems —
 * see `tools/scrape-premium.mts`. Committed, so this stays a file read rather
 * than a browser launch, and `seed` remains offline.
 */
type PremiumStatement = {
  /**
   * Optional, because the scraper's two passes land independently: statements
   * need a rendered page, starter code is a plain JSON fetch. An entry can
   * carry either alone, so "we have a statement" is `entry.prompt` — never
   * `entry` itself, which was the shape when this file only knew about
   * statements.
   */
  prompt?: string;
  source?: 'neetcode' | 'lintcode';
  sourceUrl?: string;
  /**
   * LintCode's starter code for the same problem, plus the page it runs on.
   * This is the ONLY source of a skeleton for a paid-only problem — see
   * `Generated.codeSnippets`.
   */
  practice?: { source: 'lintcode'; url: string; problemId: number; codeSnippets: CodeSnippets };
  /** The scraped page's constraint lines. No scraper writes these yet. */
  constraints?: string[];
};
let PREMIUM: Record<string, PremiumStatement> = {};

/**
 * Cache entries predate `promptSource`, so derive it from what they do carry.
 * `model` is set only when a reconstruction actually ran, which is exactly
 * what separates an invented statement from the filler.
 */
const sourceOf = (g: Generated): PromptSource =>
  g.promptSource ?? (!g.fromTitleOnly ? 'leetcode' : g.model ? 'model' : 'fallback');

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    prompt: {
      type: Type.STRING,
      description:
        'The problem stated the way an interviewer says it out loud: 1-3 sentences of plain prose. No markdown, no code, no example input or output, no bullet lists, no constraint tables. Spell symbols as words ("n log n", "big O of n squared"). Include only the constraints that change the approach.',
    },
    referenceSolution: {
      type: Type.STRING,
      description: 'The optimal approach in 1-2 sentences: the named technique plus its core mechanic. No code.',
    },
    optimalComplexity: { type: Type.STRING, description: 'e.g. "O(n) time, O(1) space"' },
    keyInsights: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2-4 things a strong candidate raises unprompted: the key realisation, the trap, the edge case, the trade-off.',
    },
  },
  required: ['prompt', 'referenceSolution', 'optimalComplexity', 'keyInsights'],
};

/** Fallback count per list, tracking items generated via fallback when quota is exhausted. */
let quotaHits = 0;

/* ── LeetCode ──────────────────────────────────────────────────────────────── */

async function fetchList(slug: string): Promise<LcQuestion[]> {
  const d = await gql<{ favoriteQuestionList: { questions: LcQuestion[] } }>(
    `query($favoriteSlug: String!, $limit: Int, $skip: Int) {
       favoriteQuestionList(favoriteSlug: $favoriteSlug, limit: $limit, skip: $skip) {
         questions { questionFrontendId title titleSlug difficulty paidOnly topicTags { name } }
       } }`,
    { favoriteSlug: slug, limit: 400, skip: 0 },
  );
  return d.favoriteQuestionList.questions;
}

/**
 * One problem's metadata, by slug — the curated lists' equivalent of
 * `fetchList`. Same public query that already supplies every statement, so a
 * committed slug list costs no more access than a fetched one.
 *
 * Returns null for a slug LeetCode does not recognise, so a renamed or
 * withdrawn problem is reported and skipped rather than aborting the list.
 */
async function fetchMeta(titleSlug: string): Promise<LcQuestion | null> {
  const d = await gql<{
    question: {
      questionFrontendId: string;
      title: string;
      titleSlug: string;
      difficulty: string;
      isPaidOnly: boolean;
      topicTags: { name: string }[];
    } | null;
  }>(
    `query($titleSlug: String!) {
       question(titleSlug: $titleSlug) {
         questionFrontendId title titleSlug difficulty isPaidOnly topicTags { name }
       } }`,
    { titleSlug },
  );
  const q = d.question;
  if (!q) return null;
  // `isPaidOnly` on this query, `paidOnly` on the list query — the same fact
  // under two names upstream, normalised here so nothing downstream cares.
  return {
    questionFrontendId: q.questionFrontendId,
    title: q.title,
    titleSlug: q.titleSlug,
    difficulty: q.difficulty,
    paidOnly: q.isPaidOnly,
    topicTags: q.topicTags,
  };
}

/**
 * The problems in one list, whichever kind of list it is.
 *
 * Paid-only problems are KEPT. They have no readable statement upstream, so
 * `resolve` reconstructs one with the model — see the note there. Dropping
 * them instead would quietly shorten a list, which is the one failure mode
 * committing the slugs was meant to rule out.
 */
async function fetchQuestions(list: ListSpec): Promise<LcQuestion[]> {
  if (list.source === 'leetcode-list') return fetchList(list.slug);

  const slugs = [...list.slugs];
  const found = await pool(slugs, CONCURRENCY, (s) => fetchMeta(s), (s) => s);
  const resolved = found.filter((q): q is LcQuestion => !!q);
  const missing = slugs.length - resolved.length;
  if (missing) console.log(`  ! ${missing} slug(s) no longer resolve on LeetCode — skipped`);
  return resolved;
}

/**
 * Cuts a LeetCode statement down to the part an interviewer would actually say.
 *
 * LeetCode statements are reliably shaped: prose describing the problem, then
 * "Example 1:", then "Constraints:", then "Follow up:". Everything from the
 * first of those markers onward is unreadable aloud, so it is dropped. This is
 * deliberately deterministic — the free API tier allows only 20 requests per
 * day per model, so a bank of 200 questions cannot depend on an LLM to exist.
 */
function toSpokenPrompt(html: string): string {
  let text = stripHtml(html);
  const cut = text.search(/\b(Example\s*\d*\s*:|Constraints\s*:|Follow[- ]?up\s*:|Note\s*:\s*You)/i);
  if (cut > 60) text = text.slice(0, cut);
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
    .slice(0, 1200);
}

/** LeetCode statements are HTML. Strip to plain text before prompting. */
function stripHtml(html: string): string {
  return html
    .replace(/<sup>/g, '^')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── generation ────────────────────────────────────────────────────────────── */

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function generate(q: LcQuestion, content: string | null): Promise<Generated> {
  const fromTitleOnly = !content;
  const body = content
    ? `Here is the original problem statement:\n\n${stripHtml(content).slice(0, 6000)}`
    : `The original statement is not available. You know this problem — reconstruct it faithfully from the title and tags. Do not invent a different problem.`;

  const prompt =
    `You are preparing a coding-interview question bank. An interviewer will READ YOUR PROMPT ALOUD to a candidate over voice.\n\n` +
    `Problem: "${q.title}" (${q.difficulty.toLowerCase()})\n` +
    `Topics: ${q.topicTags.map((t) => t.name).join(', ')}\n\n${body}\n\n` +
    `Rewrite it as a spoken interview question. Strip all examples, images, markdown and constraint lists — keep only what a candidate needs to start thinking. ` +
    `Then give the reference solution, the optimal complexity, and the key insights.`;

  // Walk the chain newest-first. The two failure modes are treated
  // differently on purpose: a 429 is a quota wall that will not clear in
  // seconds, so retrying the same model just burns time — step down instead.
  // A 503 is transient capacity, which usually does clear on a short backoff.
  let lastErr: unknown;
  for (const model of MODELS_TRY) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json', responseSchema: SCHEMA },
        });
        const parsed = JSON.parse(res.text!) as Omit<Generated, 'fromTitleOnly'>;
        return { ...parsed, fromTitleOnly, model };
      } catch (e) {
        lastErr = e;
        const msg = (e as Error).message ?? '';
        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
          quotaHits++;
          break; // next model — a quota wall will not clear in seconds
        }
        if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
          await sleep(1500 * 2 ** attempt);
          continue;
        }
        break; // a real error — try the next model once, then give up
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('generation failed');
}

/**
 * Resolves one question. The spoken prompt always comes from LeetCode's own
 * statement (free, deterministic, works for all 200 immediately). The
 * evaluator-only fields are ENRICHMENT: nice to have, attempted only when
 * `--enrich` is passed, and silently skipped when quota runs out.
 */
async function resolve(q: LcQuestion, enrich: boolean): Promise<Resolved> {
  const cacheFile = join(CACHE, `${q.titleSlug}.json`);
  /** Held past the freshness check so a rebuild can carry its enrichment. */
  let cached: Generated | null = null;
  if (existsSync(cacheFile)) {
    cached = JSON.parse(await readFile(cacheFile, 'utf8')) as Generated;
    const hasSnippets = !!cached.codeSnippets && Object.keys(cached.codeSnippets).length > 0;
    /** LintCode's skeleton for this problem, if `scrape:premium` has one. */
    const scrapedCode = PREMIUM[q.titleSlug]?.practice;

    // Three separate reasons a cache entry is stale, spelled out because the
    // single boolean they replace got two of them wrong.
    //
    // Cache entries written before starter code existed have no
    // Free problems refetch when codeSnippets are missing. Paid-only problems
    // refetch only when scraped snippets are available to avoid unnecessary fetches.
    const wantsSnippets = !hasSnippets && (!q.paidOnly || !!scrapedCode);
    // The prompt is stale when it is the generic filler — which is not a
    // question, it names the topic tags and asks the interviewer to invent the
    // rest — or when it was INVENTED BY THE MODEL and a real statement has
    // since been scraped for it. A published statement always beats a
    // plausible reconstruction, so the arrival of one is a reason to re-resolve.
    const src = sourceOf(cached);
    const wantsStatement = src === 'fallback' || (src === 'model' && !!PREMIUM[q.titleSlug]);
    const wantsEnrichment = enrich && !cached.referenceSolution;
    const wantsConstraints = !q.paidOnly && cached.constraints === undefined;

    if (!wantsSnippets && !wantsStatement && !wantsEnrichment && !wantsConstraints) return { ...cached, q };
  }

  const detail = q.paidOnly
    ? { content: null, codeSnippets: {}, constraints: null }
    : await fetchDetail(q.titleSlug);
  const content = detail.content;
  /**
   * A paid-only problem's statement, in order of how much we trust it:
   * LeetCode's own text, then a published statement of the same problem
   * scraped from NeetCode or LintCode, then the filler — which `generate`
   * below replaces with a reconstruction when there is quota for it.
   *
   * The scraped statement is checked in FIRST because it is real. Spending a
   * model call to invent a statement that NeetCode already publishes would be
   * both worse and slower.
   */
  const premium = PREMIUM[q.titleSlug];
  // Keyed on the PROMPT, not on the entry: an entry carrying only LintCode
  // starter code is not a statement, and treating it as one would clear
  // `fromTitleOnly` on a problem whose wording is still an invention.
  const scraped = content || !premium?.prompt ? undefined : premium;
  const base: Generated = {
    /**
     * LeetCode's own for a free problem; LintCode's for a paid-only one, which
     * is the only skeleton those can have. `detail.codeSnippets` is always
     * empty for a paid-only slug — the fetch is skipped entirely above,
     * because LeetCode returns null for it anyway.
     */
    codeSnippets: Object.keys(detail.codeSnippets).length
      ? detail.codeSnippets
      : (premium?.practice?.codeSnippets ?? {}),
    // Set only alongside a LintCode skeleton, so the link and the signature
    // the candidate is looking at always describe the same judge.
    practiceUrl: Object.keys(detail.codeSnippets).length ? undefined : premium?.practice?.url,
    prompt: content
      ? toSpokenPrompt(content)
      : (scraped?.prompt ??
        `${q.title}. This is a well known ${q.difficulty.toLowerCase()} problem involving ${q.topicTags.map((t) => t.name.toLowerCase()).join(', ')}. State the problem to the candidate in your own words.`),
    referenceSolution: '',
    optimalComplexity: '',
    keyInsights: [],
    constraints: detail.constraints ?? premium?.constraints ?? null,
    /**
     * "The statement was INVENTED" — not merely "it did not come from
     * LeetCode". A scraped statement is a published statement of this exact
     * problem, so it is not title-only, and nothing downstream should treat
     * it with the suspicion an invented one deserves.
     */
    fromTitleOnly: !content && !scraped,
    promptSource: content ? 'leetcode' : scraped ? scraped.source : 'fallback',
  };

  /**
   * Generates a spoken statement when neither LeetCode content nor a scraped
   * statement exists. Results are cached to JSON so subsequent runs are free.
   */
  if (enrich || (!content && !scraped)) {
    try {
      const g = await generate(q, content);
      Object.assign(base, g);
      // `generate` reconstructs the statement only when it had none to work
      // from; with content it is rewriting LeetCode's own words.
      base.promptSource = content ? 'leetcode' : 'model';
    } catch {
      quotaHits++; // out of quota — keep the deterministic prompt and move on
    }
  }

  const out = carryEnrichment(base, cached);
  out.constraints = keepConstraints(out.constraints, cached?.constraints);
  await writeFile(cacheFile, JSON.stringify(out, null, 2));
  return { ...out, q };
}

/**
 * Evaluator fields preserved across re-resolving so non-enriching runs
 * do not clear existing reference solutions and insights.
 */
const NOTE_FIELDS = ['referenceSolution', 'optimalComplexity', 'keyInsights'] as const;

/**
 * Preserves cached enrichment unless this run produced its own.
 * Preserves real scraped statements over cached synthetic ones.
 */
function carryEnrichment(base: Generated, cached: Generated | null): Generated {
  if (!cached?.referenceSolution || base.referenceSolution) return base;
  const merged = { ...base };
  for (const f of NOTE_FIELDS) (merged as Record<string, unknown>)[f] = cached[f];
  merged.model = cached.model;

  /**
   * Carries the prompt with notes unless a real scraped statement
   * replaces an invented one.
   */
  const cachedSource = sourceOf(cached);
  const publishedNow = base.promptSource === 'neetcode' || base.promptSource === 'lintcode';
  const cachedWasInvented = cachedSource === 'model' || cachedSource === 'fallback';
  if (!(publishedNow && cachedWasInvented)) {
    merged.prompt = cached.prompt;
    merged.promptSource = cachedSource;
  }
  return merged;
}

type Resolved = Generated & { q: LcQuestion };

/**
 * Bounded worker pool — LeetCode rate-limits and the API has its own RPM cap.
 *
 * `describe` names the item in the failure line. It is a parameter rather than
 * a hardcoded `.titleSlug` because the pool is now also run over bare slug
 * strings, which have no such field — and a failure line reading "✗ undefined"
 * says nothing about which problem dropped out of the list.
 */
async function pool<T, R>(
  items: T[],
  n: number,
  fn: (t: T, i: number) => Promise<R>,
  describe: (t: T) => string,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i]!, i);
        } catch (e) {
          console.error(`  ✗ ${describe(items[i]!)}: ${(e as Error).message}`);
        }
      }
    }),
  );
  return out.filter(Boolean);
}

/* ── writing questions ─────────────────────────────────────────────────────── */

const toRow = ({ q, ...g }: Resolved) => ({
  id: q.titleSlug,
  leetcodeId: q.questionFrontendId,
  url: `https://leetcode.com/problems/${q.titleSlug}/`,
  title: q.title,
  difficulty: q.difficulty.toLowerCase(),
  topics: q.topicTags.map((t) => t.name),
  prompt: g.prompt,
  codeSnippets: Object.keys(g.codeSnippets ?? {}).length ? g.codeSnippets : null,
  practiceUrl: g.practiceUrl ?? null,
  referenceSolution: g.referenceSolution || null,
  optimalComplexity: g.optimalComplexity || null,
  keyInsights: g.keyInsights,
  fromTitleOnly: g.fromTitleOnly,
  constraints: g.constraints?.length ? g.constraints : null,
});

/**
 * Upserts questions so re-running refreshes text without breaking collection links.
 * Preserves existing evaluator notes, prompts, and snippets when the incoming
 * run does not supply them.
 */
async function upsertQuestions(db: Database, rows: ReturnType<typeof toRow>[]) {
  for (let i = 0; i < rows.length; i += 50) {
    await db
      .insert(dsaQuestions)
      .values(rows.slice(i, i + 50))
      .onConflictDoUpdate({
        target: dsaQuestions.id,
        set: {
          title: raw`excluded.title`,
          difficulty: raw`excluded.difficulty`,
          topics: raw`excluded.topics`,
          prompt: raw`case when nullif(excluded.reference_solution, '') is null
                            and nullif(dsa_questions.reference_solution, '') is not null
                       then dsa_questions.prompt else excluded.prompt end`,
          /** Preserves existing code snippets if incoming snippets are empty or null. */
          codeSnippets: raw`case when coalesce(jsonb_typeof(excluded.code_snippets), 'null') = 'object'
                             then excluded.code_snippets else dsa_questions.code_snippets end`,
          practiceUrl: raw`coalesce(excluded.practice_url, dsa_questions.practice_url)`,
          referenceSolution: raw`coalesce(nullif(excluded.reference_solution, ''), dsa_questions.reference_solution)`,
          optimalComplexity: raw`coalesce(nullif(excluded.optimal_complexity, ''), dsa_questions.optimal_complexity)`,
          keyInsights: raw`case when coalesce(jsonb_array_length(excluded.key_insights), 0) > 0
                           then excluded.key_insights else dsa_questions.key_insights end`,
          fromTitleOnly: raw`excluded.from_title_only`,
          constraints: raw`case when coalesce(jsonb_array_length(excluded.constraints), 0) > 0
                            then excluded.constraints else dsa_questions.constraints end`,
        },
      });
  }
}

/**
 * The problems that belong to no curated list — see `STANDALONE_SLUGS`.
 *
 * Writes rows and NO links. `rebuildAllCollection` picks them up from the
 * table immediately afterwards, so "All questions" is where they live.
 */
async function ingestStandalone(db: Database, enrich: boolean) {
  const slugs = [...STANDALONE_SLUGS];
  if (!slugs.length) return;
  console.log(`\n▸ Standalone (in no list, reachable through "${ALL_COLLECTION.label}")`);

  const metas = (await pool(slugs, CONCURRENCY, (sl) => fetchMeta(sl), (sl) => sl)).filter(
    (q): q is LcQuestion => !!q,
  );
  if (metas.length < slugs.length) {
    console.log(`  ! ${slugs.length - metas.length} slug(s) no longer resolve on LeetCode`);
  }
  const resolved = await pool(metas, CONCURRENCY, (q) => resolve(q, enrich), (q) => q.titleSlug);
  if (!resolved.length) return;

  await upsertQuestions(db, resolved.map(toRow));
  console.log(`  ✓ ${resolved.map((r) => `${r.q.questionFrontendId}. ${r.q.title}`).join(', ')}`);
}

/* ── the derived "all" collection ──────────────────────────────────────────── */

/**
 * Rebuilds the `all` collection link rows from the entire `dsa_questions` table,
 * ordered by problem number with unnumbered slugs sorting alphabetically last.
 */
async function rebuildAllCollection(db: Database) {
  await db
    .insert(collections)
    .values({
      id: ALL_COLLECTION.id,
      label: ALL_COLLECTION.label,
      blurb: ALL_COLLECTION.blurb,
      sourceType: 'derived',
      sourceRef: null,
      orderIdx: ALL_COLLECTION.orderIdx,
    })
    .onConflictDoUpdate({
      target: collections.id,
      set: {
        label: raw`excluded.label`,
        blurb: raw`excluded.blurb`,
        sourceType: raw`excluded.source_type`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  const rows = await db
    .select({ id: dsaQuestions.id, leetcodeId: dsaQuestions.leetcodeId })
    .from(dsaQuestions)
    .orderBy(asc(dsaQuestions.id));

  // `Number(null)` and `Number('')` are both 0, which sorted numberless slugs
  // FIRST; they go last.
  const num = (v: string | null) => {
    if (v === null || !v.trim()) return Number.MAX_SAFE_INTEGER;
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  rows.sort((a, b) => num(a.leetcodeId) - num(b.leetcodeId) || a.id.localeCompare(b.id));

  const links = rows.map((r, i) => ({
    collection: ALL_COLLECTION.id,
    questionId: r.id,
    orderIdx: i,
  }));
  for (let i = 0; i < links.length; i += 200) {
    await db
      .insert(questionCollections)
      .values(links.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [questionCollections.collection, questionCollections.questionId],
        set: { orderIdx: raw`excluded.order_idx` },
      });
  }
  console.log(`\n▸ ${ALL_COLLECTION.label}\n  ✓ ${links.length} linked (rebuilt from the whole bank)`);
}

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main() {
  await mkdir(CACHE, { recursive: true });
  const premiumFile = join(DATA, 'premium-statements.json');
  if (existsSync(premiumFile)) {
    PREMIUM = JSON.parse(await readFile(premiumFile, 'utf8'));
    console.log(`${Object.keys(PREMIUM).length} scraped statements available for paid-only problems.`);
  } else {
    console.log('No premium-statements.json — paid-only statements will be reconstructed by the model.');
    console.log('Run `pnpm scrape:premium` first to use the real ones.\n');
  }
  const args = process.argv.slice(2);
  const enrich = args.includes('--enrich');
  const only = args.find((a) => !a.startsWith('--'));
  if (!enrich) {
    console.log('Building prompts from LeetCode statements (no API quota used), except for');
    console.log('paid-only problems, whose statements have to be reconstructed by the model.');
    console.log('Pass --enrich to also generate reference solutions, which needs API quota.\n');
  }
  const lists = only ? LISTS.filter((l) => l.name === only) : LISTS;
  if (!lists.length) throw new Error(`unknown list "${only}" — use: ${LISTS.map((l) => l.name).join(', ')}`);

  const { db, client } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia');

  for (const list of lists) {
    console.log(`\n▸ ${list.label}`);
    quotaHits = 0;
    await db
      .insert(collections)
      .values({
        id: list.name,
        label: list.label,
        blurb: list.blurb,
        sourceType: list.source,
        // Where the list came from, so it can be refreshed: the favourite slug
        // for a fetched list, the module for a committed one.
        sourceRef: list.source === 'leetcode-list' ? list.slug : 'scripts/data/company-lists.mts',
        orderIdx: LISTS.findIndex((l) => l.name === list.name),
      })
      .onConflictDoUpdate({
        target: collections.id,
        set: {
          label: raw`excluded.label`,
          blurb: raw`excluded.blurb`,
          sourceType: raw`excluded.source_type`,
          sourceRef: raw`excluded.source_ref`,
          orderIdx: raw`excluded.order_idx`,
        },
      });
    const questions = await fetchQuestions(list);
    const cachedBefore = (await readdir(CACHE)).length;
    console.log(`  ${questions.length} problems, ${questions.filter((q) => q.paidOnly).length} paid-only`);

    let done = 0;
    const resolved = await pool(
      questions,
      CONCURRENCY,
      async (q) => {
        const r = await resolve(q, enrich);
        if (++done % 10 === 0) process.stdout.write(`  … ${done}/${questions.length}\n`);
        return r;
      },
      (q) => q.titleSlug,
    );

    const rows = resolved.map(toRow);
    await upsertQuestions(db, rows);

    const links = resolved.map(({ q }, i) => ({
      collection: list.name,
      questionId: q.titleSlug,
      orderIdx: questions.findIndex((x) => x.titleSlug === q.titleSlug) >= 0
        ? questions.findIndex((x) => x.titleSlug === q.titleSlug)
        : i,
    }));
    // Updated on conflict, never ignored: with `onConflictDoNothing` a list
    // reordered upstream kept its first-ingest order for ever.
    if (links.length) {
      await db
        .insert(questionCollections)
        .values(links)
        .onConflictDoUpdate({
          target: [questionCollections.collection, questionCollections.questionId],
          set: { orderIdx: raw`excluded.order_idx` },
        });
    }

    const generated = (await readdir(CACHE)).length - cachedBefore;
    console.log(
      `  ✓ ${rows.length}/${questions.length} stored ` +
        `(${generated} newly generated, ${rows.length - generated} cached, ${quotaHits} quota fallbacks)`,
    );
    const enriched = resolved.filter((r) => r.referenceSolution).length;
    console.log(`  ${enriched}/${rows.length} have evaluator notes (run with --enrich to fill more)`);
    // Paid-only problems, split by whether the reconstruction actually landed.
    // A filler prompt is worth calling out: it is the one thing in the bank
    // that an interviewer cannot read out as a question.
    const titleOnly = resolved.filter((r) => r.fromTitleOnly);
    if (titleOnly.length) {
      const rebuilt = titleOnly.filter((r) => r.model);
      console.log(`  ${rebuilt.length}/${titleOnly.length} paid-only statements reconstructed by the model`);
      const filler = titleOnly.filter((r) => !r.model);
      if (filler.length) {
        console.log(`  ! still on the generic fallback: ${filler.map((r) => r.q.titleSlug).join(', ')}`);
      }
    }
    if (rows.length < questions.length) {
      console.log(`  ! ${questions.length - rows.length} failed — re-run to retry just those.`);
    }
  }

  // Both always, and regardless of which list was asked for: a standalone
  // problem is not part of any list, and `all` is rebuilt from the table.
  await ingestStandalone(db, enrich);
  await rebuildAllCollection(db);

  await client.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
