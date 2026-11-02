export type NormOptions = {
  /**
   * Delete apostrophes rather than split on them: "what's" becomes "whats".
   * Off by default for compatibility with split contraction patterns ("i m", "that s").
   */
  joinContractions?: boolean;
  /** Keep `?`, for patterns that must not run past the end of a question. */
  keepQuestionMarks?: boolean;
};

/**
 * The one normaliser every speech guard matches against: lower case, punctuation
 * to spaces, whitespace collapsed. Curly and straight apostrophes are the same
 * character after it, which is the point — the transcriber emits both.
 */
export function norm(s: string, opts: NormOptions = {}): string {
  let t = s.toLowerCase();
  if (opts.joinContractions) t = t.replace(/['‘’`]/g, '');
  return t
    .replace(opts.keepQuestionMarks ? /[^a-z0-9\s?]/g : /[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
