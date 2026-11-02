/**
 * Checks whether a scraped page title matches the expected problem title,
 * stripping site prefixes, numbering, and trailing difficulty tags before comparison.
 */
export function titlesAgree(want: string, got: string): boolean {
  const a = normTitle(want);
  const b = normTitle(got);
  return a !== '' && a === b;
}

function normTitle(s: string): string {
  return s
    .trim()
    .replace(/^lintcode\b[\s:·\-–|]*/i, '')
    .replace(/^\d+\s*[.·:)\-–]\s*/, '')
    .replace(/(\s+(algorithms|easy|medium|hard|naive))+\s*$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
