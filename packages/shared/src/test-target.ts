/**
 * Whether a database or data-directory name is a TEST target: "test" as its own
 * word or suffix (`orvia_test`, `data-test`), never merely a substring —
 * "contest" or "attestations" is not one. The one rule for the API's
 * `/api/health` report, its boot warning and the suites' guard, so the three
 * cannot disagree about which database a suite may write to.
 */
export function isTestDatabaseName(name: string): boolean {
  return /(^|[_-])test([_-]|$)/.test(name);
}
