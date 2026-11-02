/**
 * Whether two complexity strings from the evaluator name the same bound.
 *
 * They are free text — "O(n log n)", "O(nlogn)", "O(log n * n)" — so this
 * normalises case, whitespace, `·`/`*` and the ORDER of multiplied factors.
 * It can only say same or different; which one is slower is not decidable from
 * the text in general, so no caller may claim that.
 */
export function sameComplexity(a: string, b: string): boolean {
  const x = splitComplexity(a);
  const y = splitComplexity(b);
  // "O(S * n) where S is amount" names the same bound as "O(S * n)". A second
  // bound in the rest ("O(M) for addWord and O(26^D) for search") is part of
  // the claim, so then the whole string has to agree.
  if (!HAS_BOUND.test(x.rest) && !HAS_BOUND.test(y.rest)) return normalise(x.head) === normalise(y.head);
  return normalise(unglossed(a)) === normalise(unglossed(b));
}

/** Drops a trailing "where D is ..." — it defines the letters, it is not a bound. */
const unglossed = (s: string) => s.replace(/\s*,?\s*\bwhere\b.*$/is, '');

const HAS_BOUND = /\bO\s*\(/i;

/**
 * The leading bound and whatever the evaluator wrote after it, so the table can
 * set "O(S * n)" as the figure and "where S is amount" as the gloss. A string
 * that does not open with a balanced `O(...)` is all head.
 */
export function splitComplexity(s: string): { head: string; rest: string } {
  const t = s.trim();
  const open = /^O\s*\(/i.exec(t);
  if (!open) return { head: t, rest: '' };
  let depth = 0;
  for (let i = open[0].length - 1; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')' && --depth === 0) {
      return { head: t.slice(0, i + 1), rest: t.slice(i + 1).replace(/^[\s,;:\-–—]+/, '') };
    }
  }
  return { head: t, rest: '' };
}

function normalise(s: string): string {
  const inner = s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^o\s*\((.*)\)$/, '$1');
  return inner
    .split('+')
    .map((term) =>
      term
        .replace(/[·×]/g, '*')
        .replace(/log/g, ' log ')
        .trim()
        .split(/\s*\*\s*|\s+(?![^(]*\))/)
        .map((f) => f.replace(/\s+/g, '').replace(/^\((\w+)\)$/, '$1'))
        .filter(Boolean)
        .sort()
        .join('*'))
    .sort()
    .join('+');
}
