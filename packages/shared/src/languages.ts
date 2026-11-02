/**
 * Language mappings between internal language identifiers and LeetCode slugs,
 * shared by problem ingestion and the code editor.
 */

/** Languages the code editor can render. Mirrored by `Language` in the editor. */
export const CODE_LANGUAGES = [
  'python', 'javascript', 'typescript', 'java', 'cpp', 'go', 'rust', 'sql', 'php',
] as const;

/**
 * `markdown` and `text` are scratchpad modes for system design rather than code,
 * so they have no LeetCode counterpart and never carry a snippet.
 */
export const NOTE_LANGUAGES = ['markdown', 'text'] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export type EditorLanguage = CodeLanguage | (typeof NOTE_LANGUAGES)[number];

/**
 * Our language id -> LeetCode `langSlug`.
 *
 * `python` maps to `python3`: LeetCode still serves a legacy `python` (2.x)
 * snippet, and pasting a Python 2 skeleton into a Python 3 submission is a
 * broken starting point.
 */
export const LEETCODE_LANG_SLUG: Record<CodeLanguage, string> = {
  python: 'python3',
  javascript: 'javascript',
  typescript: 'typescript',
  java: 'java',
  cpp: 'cpp',
  go: 'golang',
  rust: 'rust',
  sql: 'mysql',
  php: 'php',
};

/** Reverse lookup, for turning a fetched snippet list into our shape. */
export const CODE_LANGUAGE_BY_SLUG: Record<string, CodeLanguage> = Object.fromEntries(
  Object.entries(LEETCODE_LANG_SLUG).map(([lang, slug]) => [slug, lang as CodeLanguage]),
) as Record<string, CodeLanguage>;

/** Per-question starter code, keyed by our language id. Absent languages fall
 *  back to the editor's own generic stub. */
export type CodeSnippets = Partial<Record<CodeLanguage, string>>;

export function isCodeLanguage(lang: string): lang is CodeLanguage {
  return (CODE_LANGUAGES as readonly string[]).includes(lang);
}

/**
 * Maps internal language ids to LintCode's `language` parameter for starter code
 * snippets where LeetCode starter templates are unavailable.
 * Languages without judge support fallback to generic stubs.
 */
export const LINTCODE_LANG_SLUG: Partial<Record<CodeLanguage, string>> = {
  python: 'python3',
  javascript: 'js',
  typescript: 'typescript',
  java: 'java',
  cpp: 'cpp',
  go: 'go',
  rust: 'rust',
  php: 'php',
};
