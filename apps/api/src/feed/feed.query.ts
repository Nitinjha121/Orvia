import { z } from 'zod';

/** `GET /api/feed`. Its own file so `verify:feed` can parse with it offline. */
export const pageQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(5000).default(0),
  limit: z.coerce.number().int().min(1).max(30).default(8),
  /**
   * Fixed by the client for as long as the feed is mounted, so scrolling never
   * reshuffles what is above the thumb, and a new open is a new feed.
   */
  seed: z.coerce.number().int().default(1),
  /** The reader's local date. See the note on `feedInteractionSchema.dayKey`. */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Which pre-generated narration voice to attach, when several are built. */
  voice: z.string().max(40).optional(),
  /**
   * Compose only cards that have narration, for hands-free listening.
   * `stringbool`, not `coerce.boolean`: coercion makes the string "false" true.
   */
  narrated: z.stringbool().optional(),
});

