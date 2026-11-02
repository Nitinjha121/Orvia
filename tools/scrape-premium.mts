/**
 * Scrapes problem statements and starter code for paid-only problems from public mirror sites,
 * validating scraped titles against LeetCode definitions to prevent mismatched descriptions.
 */
import { chromium, type Page } from 'playwright';
// Relative rather than `@orvia/shared`: tools/ is not a workspace package and
// has no dependency on it, which is how the e2e suites next door import too.
import {
  CODE_LANGUAGES,
  LINTCODE_LANG_SLUG,
  type CodeLanguage,
  type CodeSnippets,
} from '../packages/shared/src/languages.js';
import { titlesAgree } from './title-match.mts';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'apps', 'api', 'scripts', 'data', 'premium-statements.json');

/**
 * Manual slug mappings for problems renamed on NeetCode, verified by title during scrape.
 * Unmapped problems fallback to LintCode.
 */
const NEETCODE_SLUGS: Record<string, string> = {
  'alien-dictionary': 'foreign-dictionary',
  'encode-and-decode-strings': 'string-encode-and-decode',
  'graph-valid-tree': 'valid-tree',
  'meeting-rooms': 'meeting-schedule',
  'meeting-rooms-ii': 'meeting-schedule-ii',
  'number-of-connected-components-in-an-undirected-graph': 'count-connected-components',
  // NOT walls-and-gates. NeetCode hosts it as `islands-and-treasure` and does
  // not just rename it — it re-frames the problem, so gates become treasure
  // and walls become water. The title check refused it, correctly: a candidate
  // who knows the problem as "Walls and Gates" should hear that. LintCode
  // serves it under its own name.
};

/** LintCode uses LeetCode's own slug for these classics, so it needs no map. */
const lintcodeUrl = (slug: string) => `https://www.lintcode.com/problem/${slug}/`;

type Entry = {
  /**
   * Spoken problem prompt. Optional because prompts and starter code can be
   * scraped independently.
   */
  prompt?: string;
  /** Which site it came from, so a mixed-provenance bank stays auditable. */
  source?: 'neetcode' | 'lintcode';
  sourceUrl?: string;
  /** The title the PAGE showed, which is what was checked against LeetCode's. */
  scrapedTitle?: string;
  scrapedAt?: string;
  /**
   * Runnable starter code, and the page it runs on. Always LintCode — see
   * `scrapeLintcodeStarters`.
   */
  practice?: Practice;
};

/**
 * Starter code snippets and executable problem links from LintCode,
 * providing language signatures and execution environments for paid-only problems.
 */
type Practice = {
  source: 'lintcode';
  /** The page to paste into. Shown in the editor as "Run on LintCode". */
  url: string;
  /** LintCode's numeric id, which is what its API is keyed by. */
  problemId: number;
  /** The title LINTCODE showed, checked against LeetCode's before storing. */
  title: string;
  /** Keyed by OUR language id, so nothing downstream knows LintCode's names. */
  codeSnippets: CodeSnippets;
  scrapedAt: string;
};

/* ── LeetCode: the titles to verify against ────────────────────────────────── */

async function leetcodeTitles(slugs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const slug of slugs) {
    const res = await fetch('https://leetcode.com/graphql/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        query: `query($s:String!){question(titleSlug:$s){title isPaidOnly}}`,
        variables: { s: slug },
      }),
    });
    const json = (await res.json()) as { data?: { question?: { title: string } | null } };
    const title = json.data?.question?.title;
    if (title) out[slug] = title;
  }
  return out;
}

/* ── text cleanup ──────────────────────────────────────────────────────────── */

/**
 * Pattern matching markers (examples, constraints, follow-ups) where spoken prompt text
 * should be truncated so only problem descriptions are read aloud.
 */
const CUT = /\b(Examples?\s*\d*\s*:?|Constraints?\s*:|Follow[- ]?up\s*:|Challenge\s*:|Note\s*:\s*You|Input\s*:|Output\s*:)/i;

/** Truncate inline method signatures or code blocks embedded in scraped text. */
const CODE_CUT = /(\bMachine \d|\bclass \w+\s*[{:]|[{};]|\/\/|<[A-Z]\w*>)/;

/** Strip MathJax mathematical glyph segments to retain only the plain-text fallback representations. */
const MATH_SEGMENT = /[\u{1D400}-\u{1D7FF}][\u{1D400}-\u{1D7FF}\s×·^+=,[\]()-]*/gu;
/**
 * A bare glyph, WITHOUT the global flag, for `unspeakable`'s test.
 * `RegExp.prototype.test` on a /g regex advances `lastIndex` and resumes from
 * there on the next call, so sharing one instance between a replace and a test
 * makes the test depend on which problems were checked before it.
 */
const MATH_GLYPH = /[\u{1D400}-\u{1D7FF}]/u;
/**
 * Zero-width joiners and the combining marks MathJax uses for subscripts.
 *
 * Matching the combining marks INDIVIDUALLY is the point \u2014 they are stripped
 * off the base character they were rendered onto, rather than treated as part
 * of a grapheme \u2014 which is exactly what the lint rule below exists to question.
 */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF\u0300-\u036F]/g;
/** "length n n" — the same token twice, left behind by the double render. */
const DOUBLED_WORD = /\b(\w+)(\s+\1\b)+/gi;
/**
 * Scaffolding with nothing in it — the signature of a botched cleanup.
 *
 * SQUARE brackets only. An empty pair of parentheses is a method name, which
 * these statements do use in prose — "in the method couldPrintMessage(), given
 * a message and a timestamp" — and flagging it threw away a correct statement.
 */
const EMPTY_BRACKETS = /\[\s*[,;\s]*\]/;

/** Text the sites put INSIDE the description container that is not the problem. */
const CHROME = [
  /LintCode\s*[-–]\s*Online Judge.*/gis,
  /Candidate Written Test Screening.*/gis,
  /Get Pro Access.*/gis,
  /^\s*Description\s*/i,
];

function toSpoken(raw: string): string {
  let text = raw;
  for (const re of CHROME) text = text.replace(re, ' ');
  text = text.replace(INVISIBLE, '').replace(MATH_SEGMENT, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(DOUBLED_WORD, '$1');

  // Whichever marker comes FIRST wins — a statement can run into its examples
  // and into a code block, and we want the earlier of the two.
  const cuts = [text.search(CUT), text.search(CODE_CUT)].filter((i) => i > 60);
  if (cuts.length) text = text.slice(0, Math.min(...cuts));

  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
    .slice(0, 1200);
}

/**
 * Validates that scraped text contains no unpronounceable markers (leftover code,
 * unresolved glyphs, broken entity markers) before saving.
 */
function unspeakable(text: string): string | null {
  if (MATH_GLYPH.test(text)) return 'maths glyphs survived the cleanup';
  if (/[{};]|\/\//.test(text)) return 'contains code';
  // Brackets with nothing inside them are what a half-removed formula leaves
  // behind. Checked instead of "a run of single letters", which read as an
  // artifact but is also just English: "a m x n 2D grid" tripped it, and
  // refusing a correct statement is the same cost as accepting a bad one.
  if (EMPTY_BRACKETS.test(text)) return 'empty brackets left by a formula';
  return null;
}

/* ── the two sites ─────────────────────────────────────────────────────────── */

type Scraped = { title: string; body: string } | null;

async function render(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    // Both sites paint the shell first and fill the description in after; the
    // networkidle above is necessary but not sufficient.
    await page.waitForTimeout(3_500);
    return true;
  } catch {
    return false;
  }
}

async function scrapeNeetcode(page: Page, ncSlug: string): Promise<Scraped> {
  const url = `https://neetcode.io/problems/${ncSlug}`;
  if (!(await render(page, url))) return null;
  return page.evaluate(() => {
    const tab = document.querySelector('.question-tab, .tab-content-padding');
    const text = (tab as HTMLElement | null)?.innerText ?? '';
    // A problem NeetCode does not host renders a bare "Get Pro Access" shell.
    if (!text || text.length < 120) return null;
    // The container opens "<Title> <Difficulty> Topics Company Tags Hints" and
    // the statement follows. Title is the first line; the statement starts
    // after the last piece of that header.
    const title = text.split('\n')[0]?.trim() ?? '';
    const at = text.search(/\bHints\b/);
    const body = at >= 0 ? text.slice(at + 5) : text;
    return { title, body };
  });
}

async function scrapeLintcode(page: Page, slug: string): Promise<Scraped> {
  const url = lintcodeUrl(slug);
  if (!(await render(page, url))) return null;
  return page.evaluate(() => {
    // Class names carry a per-build hash suffix (`problem-description-content-niBfd`),
    // so match on the stable prefix rather than the whole name.
    const desc = document.querySelector('[class*="problem-description-wrapper"]');
    const body = (desc as HTMLElement | null)?.innerText ?? '';
    if (!body || body.length < 80) return null;
    // The header reads "650 · Find Leaves of Binary Tree Algorithms Medium …".
    const head = (document.querySelector('[class*="east-desc"]') as HTMLElement | null)?.innerText ?? '';
    const m = head.match(/\d+\s*·\s*([^\n]+)/);
    const title = (m?.[1] ?? '').replace(/\s+(Algorithms|Easy|Medium|Hard|Naive)\b.*$/i, '').trim();
    return { title, body };
  });
}

/* ── LintCode: the starter code, and somewhere to run it ───────────────────── */

/**
 * Fetches problem IDs and starter code from LintCode's HTTP API without requiring
 * a headless browser.
 */
const LINTCODE_API = 'https://apiv1.lintcode.com';
const LINTCODE_HEADERS = { accept: 'application/json', 'user-agent': 'Mozilla/5.0' };

type LintcodeReply = { data?: { id?: unknown; title?: unknown; code?: unknown } };

async function lintcodeJson(url: string): Promise<LintcodeReply | null> {
  try {
    const res = await fetch(url, { headers: LINTCODE_HEADERS });
    if (!res.ok) return null;
    return JSON.parse(await res.text()) as LintcodeReply;
  } catch {
    return null;
  }
}

/**
 * Resolves a LeetCode slug to LintCode's numeric ID and title, verifying
 * that data.id is present.
 */
async function resolveLintcode(slug: string): Promise<{ id: number; title: string } | null> {
  const j = await lintcodeJson(`${LINTCODE_API}/v2/api/problems/${slug}/?lang=2`);
  const d = j?.data;
  if (!d || typeof d.id !== 'number' || !d.title) return null;
  return { id: d.id, title: String(d.title) };
}

/**
 * Fetches starter code for all supported languages from LintCode, populating
 * available language snippets.
 */
async function scrapeLintcodeStarters(problemId: number): Promise<CodeSnippets> {
  const out: CodeSnippets = {};
  for (const lang of CODE_LANGUAGES) {
    const slug = LINTCODE_LANG_SLUG[lang];
    if (!slug) continue; // sql — LintCode's judge has no such language
    const j = await lintcodeJson(
      `${LINTCODE_API}/new/api/problems/${problemId}/reset/?scene=1&language=${slug}`,
    );
    const code = j?.data?.code;
    if (typeof code === 'string' && code.trim()) out[lang as CodeLanguage] = code;
    // Polite rather than necessary: this is sixteen problems times eight
    // languages, once, against somebody else's free API.
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

/**
 * Resolves problem metadata, verifies title match against LeetCode, and fetches
 * starter code snippets.
 */
async function scrapeStarters(
  targets: string[],
  want: Record<string, string>,
  existing: Record<string, Entry>,
): Promise<{ got: string[]; missing: string[]; refused: string[] }> {
  const got: string[] = [];
  const missing: string[] = [];
  const refused: string[] = [];

  for (const slug of targets) {
    const expected = want[slug];
    if (!expected) {
      missing.push(slug);
      continue;
    }
    const resolved = await resolveLintcode(slug);
    if (!resolved) {
      console.log(`  – ${slug} — LintCode does not serve this one without a login`);
      missing.push(slug);
      continue;
    }
    if (!titlesAgree(expected, resolved.title)) {
      console.log(
        `  ✗ ${slug} — LintCode ${resolved.id} is "${resolved.title}", expected "${expected}" — REFUSED`,
      );
      refused.push(`${slug} (lintcode ${resolved.id}: "${resolved.title}")`);
      continue;
    }
    const codeSnippets = await scrapeLintcodeStarters(resolved.id);
    const langs = Object.keys(codeSnippets);
    if (!langs.length) {
      console.log(`  ✗ ${slug} — LintCode ${resolved.id} returned no code in any language`);
      missing.push(slug);
      continue;
    }
    existing[slug] = {
      ...existing[slug],
      practice: {
        source: 'lintcode',
        url: lintcodeUrl(slug),
        problemId: resolved.id,
        title: resolved.title,
        codeSnippets,
        scrapedAt: new Date().toISOString(),
      },
    };
    console.log(`  ✓ ${slug} — lintcode ${resolved.id}, ${langs.length} languages (${langs.join(', ')})`);
    got.push(slug);
  }
  return { got, missing, refused };
}

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  /**
   * The two halves are independently skippable because they cost wildly
   * different things: `--code-only` is a handful of JSON fetches and finishes
   * in seconds, `--statements-only` launches Chromium and renders a page per
   * problem. Re-scraping starter code should not mean re-rendering sixteen
   * pages.
   */
  const codeOnly = args.includes('--code-only');
  const statementsOnly = args.includes('--statements-only');
  const only = args.filter((a) => !a.startsWith('--'));

  const existing: Record<string, Entry> = existsSync(OUT)
    ? JSON.parse(await readFile(OUT, 'utf8'))
    : {};

  /**
   * Builds the work list of paid-only problems from the ingest cache by finding
   * entries with empty codeSnippets.
   */
  const cacheDir = join(HERE, '..', 'apps', 'api', 'scripts', 'data', 'cache');
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(cacheDir);
  const paid: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const slug = f.slice(0, -5);
    const c = JSON.parse(await readFile(join(cacheDir, f), 'utf8')) as {
      fromTitleOnly?: boolean;
      codeSnippets?: Record<string, string>;
    };
    if (c.fromTitleOnly || !Object.keys(c.codeSnippets ?? {}).length) paid.push(slug);
  }
  paid.sort();

  const pick = (have: (e: Entry | undefined) => boolean) =>
    (only.length ? only : paid).filter((s) => refresh || !have(existing[s]));

  // A statement and a skeleton are missing independently — an entry can carry
  // one without the other — so each pass computes its own targets.
  const statementTargets = statementsOnly || !codeOnly ? pick((e) => !!e?.prompt) : [];
  const codeTargets = codeOnly || !statementsOnly ? pick((e) => !!e?.practice) : [];

  const withStatement = Object.values(existing).filter((e) => e.prompt).length;
  const withCode = Object.values(existing).filter((e) => e.practice).length;
  console.log(
    `${paid.length} paid-only problems in the cache — ` +
      `${withStatement} already have a statement, ${withCode} have starter code.`,
  );

  if (!statementTargets.length && !codeTargets.length) {
    console.log('Nothing to do. Pass --refresh to re-scrape.');
    return;
  }

  const want = await leetcodeTitles([...new Set([...statementTargets, ...codeTargets])]);

  const got: string[] = [];
  const missing: string[] = [];
  const refused: string[] = [];

  /* ── starter code first: plain fetches, no browser ───────────────────────── */
  if (codeTargets.length) {
    console.log(`\nStarter code from LintCode — ${codeTargets.length} problem(s):\n`);
    const r = await scrapeStarters(codeTargets, want, existing);
    got.push(...r.got.map((s) => `${s} (code)`));
    missing.push(...r.missing);
    refused.push(...r.refused);
  }

  /* ── statements second: this is the half that needs Chromium ─────────────── */
  if (statementTargets.length) {
    console.log(`\nStatements — ${statementTargets.length} problem(s):\n`);
    const browser = await chromium.launch();
    const page = await browser.newPage();

    for (const slug of statementTargets) {
      const expected = want[slug];
      if (!expected) {
        console.log(`  ? ${slug} — LeetCode does not know this slug, skipped`);
        missing.push(slug);
        continue;
      }

      const attempts: { source: 'neetcode' | 'lintcode'; url: string; run: () => Promise<Scraped> }[] = [];
      const nc = NEETCODE_SLUGS[slug];
      if (nc) {
        attempts.push({
          source: 'neetcode',
          url: `https://neetcode.io/problems/${nc}`,
          run: () => scrapeNeetcode(page, nc),
        });
      }
      attempts.push({ source: 'lintcode', url: lintcodeUrl(slug), run: () => scrapeLintcode(page, slug) });

      let stored = false;
      for (const a of attempts) {
        const res = await a.run();
        if (!res) continue;
        if (!titlesAgree(expected, res.title)) {
          console.log(
            `  ✗ ${slug} — ${a.source} showed "${res.title}", expected "${expected}" — REFUSED`,
          );
          refused.push(`${slug} (${a.source}: "${res.title}")`);
          continue;
        }
        const prompt = toSpoken(res.body);
        // A statement too short to be one is a container that rendered a stub.
        if (prompt.length < 80) {
          console.log(`  ✗ ${slug} — ${a.source} gave only ${prompt.length} chars, REFUSED`);
          refused.push(`${slug} (${a.source}: ${prompt.length} chars)`);
          continue;
        }
        const bad = unspeakable(prompt);
        if (bad) {
          console.log(`  ✗ ${slug} — ${a.source}: ${bad}, REFUSED`);
          refused.push(`${slug} (${a.source}: ${bad})`);
          continue;
        }
        // Spread over whatever is already there: the starter-code pass may
        // have written `practice` on this entry moments ago, and a statement
        // landing must not take it away again.
        existing[slug] = {
          ...existing[slug],
          prompt,
          source: a.source,
          sourceUrl: a.url,
          scrapedTitle: res.title,
          scrapedAt: new Date().toISOString(),
        };
        console.log(`  ✓ ${slug} — ${a.source}, ${prompt.length} chars`);
        got.push(`${slug} (statement)`);
        stored = true;
        break;
      }
      if (!stored && !refused.some((r) => r.startsWith(slug))) {
        console.log(`  – ${slug} — not on either site`);
        missing.push(slug);
      }
    }

    await browser.close();
  }

  // Sorted so the committed file is a stable diff rather than scrape order.
  const sorted = Object.fromEntries(Object.entries(existing).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(OUT, JSON.stringify(sorted, null, 2) + '\n');

  console.log(
    `\n${got.length} scraped, ${new Set(missing).size} unavailable, ${refused.length} refused.`,
  );
  // A refused refresh leaves the previous entry in place, which is the right
  // call — a bad scrape must not destroy a good statement — but it is not
  // obvious from the lines above, so say it.
  const kept = [...missing, ...refused.map((r) => r.split(' ')[0]!)].filter((s2) => existing[s2]);
  if (kept.length) console.log(`Kept the previously scraped entry for: ${[...new Set(kept)].join(', ')}`);

  const entries = Object.values(sorted);
  console.log(
    `${entries.length} entries in ${OUT}\n  ` +
      `${entries.filter((e) => e.prompt).length} with a statement, ` +
      `${entries.filter((e) => e.practice).length} with starter code`,
  );

  const noCode = paid.filter((s) => !sorted[s]?.practice);
  if (noCode.length) console.log(`\nStill on the editor's generic stub: ${noCode.join(', ')}`);
  const noPrompt = paid.filter((s) => !sorted[s]?.prompt);
  if (noPrompt.length) console.log(`Still model-reconstructed: ${noPrompt.join(', ')}`);
  if (refused.length) console.log(`\nNeeds a human — wrong page served:\n  ${refused.join('\n  ')}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
