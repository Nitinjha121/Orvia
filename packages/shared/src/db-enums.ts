/**
 * Lifecycle states that exist as Postgres enums, declared once so
 * `packages/db/src/schema.ts` builds its `pgEnum`s from here instead of a
 * hand-copied list. Order is the enum's order in the live databases: a
 * reordered list is a schema change to `drizzle-kit push`.
 */
export const SESSION_STATUSES = ['live', 'completed', 'aborted', 'failed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const EVALUATION_STATUSES = [
  'pending',
  'transcribing',
  'evaluating',
  'complete',
  'failed',
] as const;
