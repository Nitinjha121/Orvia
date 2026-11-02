import { z } from 'zod';

/**
 * Lenient schema for reading question assignments from `sessions.config`.
 * Degrades individual fields gracefully to handle legacy or partially malformed configs.
 */
const storedConfigSchema = z.object({
  mode: z.string().optional().catch(undefined),
  questionIds: z.array(z.string()).optional().catch(undefined),
  scenarioId: z.string().optional().catch(undefined),
  problem: z.string().optional().catch(undefined),
  problemId: z.string().optional().catch(undefined),
});

export type StoredConfig = z.infer<typeof storedConfigSchema>;

export function readStoredConfig(raw: unknown): StoredConfig {
  const parsed = storedConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** The bank ids a round's config assigned, in order. `hr` assigns one scenario. */
export function assignedIds(cfg: StoredConfig): string[] {
  if (cfg.mode === 'hr') return cfg.scenarioId ? [cfg.scenarioId] : [];
  return [...new Set(cfg.questionIds ?? [])];
}
