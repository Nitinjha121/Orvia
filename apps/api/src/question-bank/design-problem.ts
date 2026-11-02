/**
 * Resolves the bank problem ID for a system design round from `problemId`
 * or by matching prompt text against known bank problems.
 */
export function resolveDesignProblem(
  cfg: { problem?: string; problemId?: string },
  bank: { id: string; title: string; prompt: string }[],
): string | null {
  if (cfg.problemId) return cfg.problemId;
  if (!cfg.problem) return null;
  const match = bank.find((p) => cfg.problem!.includes(p.title) || p.prompt === cfg.problem);
  return match?.id ?? null;
}
