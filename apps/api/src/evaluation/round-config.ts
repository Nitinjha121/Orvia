import { z } from 'zod';
import { sessionOptionsSchema } from '@orvia/shared';

/**
 * Lenient schema for reading `sessions.config` and `sessions.options` during evaluation.
 * Fields degrade gracefully if absent to maintain compatibility across schema versions.
 */
const str = z.string().optional().catch(undefined);

const roundConfigSchema = z.object({
  // One malformed entry drops that entry, not the list: outcomes hang off it.
  questionIds: z.array(z.unknown()).transform((a) => a.filter((x): x is string => typeof x === 'string')).optional().catch(undefined),
  problem: str,
  problemId: str,
  experience: str,
  jobDescription: str,
  scenarioId: str,
  targetRole: str,
  currentCompensation: str,
  expectedCompensation: str,
  noticePeriod: str,
  competingOffers: str,
  reasonForLeaving: str,
});
export type RoundConfig = z.infer<typeof roundConfigSchema>;

export function readRoundConfig(raw: unknown): RoundConfig {
  const parsed = roundConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const roundOptionsSchema = z.object({
  durationMinutes: z.number().nullable().catch(null),
  difficulty: z.string().nullable().catch(null),
  persona: z.string().nullable().catch(null),
  // Absent on every round recorded before styles existed; `.default` so those
  // parse to null rather than tripping the whole object's fallback below.
  style: z.string().nullable().default(null).catch(null),
});
export type RoundOptions = z.infer<typeof roundOptionsSchema>;

export function readRoundOptions(raw: unknown): RoundOptions {
  const parsed = roundOptionsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { durationMinutes: null, difficulty: null, persona: null, style: null };
}

/**
 * What the evaluator is told when a field is missing: the default
 * `startSessionSchema` applied when the round began, which is what it ran with.
 */
export const OPTION_DEFAULTS = sessionOptionsSchema.parse({});
