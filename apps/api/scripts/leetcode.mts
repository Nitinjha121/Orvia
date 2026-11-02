/**
 * LeetCode's public GraphQL, shared by `ingest-questions.mts` and
 * `fetch-constraints.mts`. Its own module because the ingest runs `main()` on
 * import, so nothing — including `verify:questions` — could reuse a function
 * that lived there.
 */
import { CODE_LANGUAGE_BY_SLUG, type CodeSnippets } from '@orvia/shared';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://leetcode.com/graphql/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`leetcode ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: unknown };
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

export type LcDetail = {
  content: string | null;
  codeSnippets: CodeSnippets;
  /** Null when LeetCode's statement has no constraints list, or no statement. */
  constraints: string[] | null;
};

/**
 * One request for the statement, the starter code and the constraints.
 *
 * `codeSnippets` rides along on the query that was already being made for
 * `content`, so per-question starter code costs no extra request and no model
 * quota — it is the same deterministic, offline-seedable path as the prompt.
 */
export async function fetchDetail(titleSlug: string): Promise<LcDetail> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await gql<{
        question: {
          content: string | null;
          codeSnippets: { langSlug: string; code: string }[] | null;
        } | null;
      }>(
        `query($titleSlug: String!) {
           question(titleSlug: $titleSlug) {
             content
             codeSnippets { langSlug code }
           } }`,
        { titleSlug },
      );

      // Keep only the languages the editor can actually offer, re-keyed to our
      // own ids so nothing downstream needs to know LeetCode's naming.
      const codeSnippets: CodeSnippets = {};
      for (const sn of d.question?.codeSnippets ?? []) {
        const lang = CODE_LANGUAGE_BY_SLUG[sn.langSlug];
        if (lang && sn.code?.trim()) codeSnippets[lang] = sn.code;
      }
      const content = d.question?.content ?? null;
      return { content, codeSnippets, constraints: extractConstraints(content) };
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  /**
   * Fails explicitly on network or rate limit errors rather than returning
   * null, preventing transient fetch errors from overwriting valid statements.
   */
  throw lastErr instanceof Error ? lastErr : new Error('leetcode detail unavailable');
}

/**
 * The "Constraints:" list of a LeetCode statement, one line per bullet.
 *
 * Kept because the spoken prompt deliberately drops it, and an interviewer
 * asked about input size with nothing to reference might hallucinate constraints.
 * Lines stay in LeetCode's notation, `10^4` and `start_i`; the interviewer
 * prompt says them as words.
 *
 * Null rather than a guess whenever the block is not the usual `<ul>`.
 */
export function extractConstraints(html: string | null): string[] | null {
  if (!html) return null;
  const at = html.search(/Constraints\s*:/i);
  if (at < 0) return null;
  const list = /<ul[^>]*>([\s\S]*?)<\/ul>/i.exec(html.slice(at));
  if (!list) return null;
  const lines = [...list[1]!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => constraintLine(m[1]!))
    .filter((l) => l.length > 0);
  return lines.length ? lines : null;
}

function constraintLine(li: string): string {
  return li
    .replace(/<sup>\s*([^<]*?)\s*<\/sup>/gi, '^$1')
    .replace(/<sub>\s*([^<]*?)\s*<\/sub>/gi, '_$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&le;/g, '<=').replace(/&ge;/g, '>=')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What a run writes over what the bank already holds: a fetched list wins, and
 * nothing — a failed fetch, a paid-only problem, a cleared cache — replaces a
 * real list with none. The SQL upsert applies the same rule to the table.
 */
export function keepConstraints(
  incoming: string[] | null | undefined,
  existing: string[] | null | undefined,
): string[] | null {
  if (incoming?.length) return incoming;
  return existing?.length ? existing : null;
}
