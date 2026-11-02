import { z } from 'zod';

export const guardEventKindSchema = z.enum([
  'premature_advance',
  'false_close',
  'clock_claim',
  'scope_backward',
  'scope_wider',
  'repeat_ask',
  'code_claim',
  'invented_markup',
  'premature_wrapup',
]);

export const guardEventSchema = z.object({
  atMs: z.number().int().nonnegative(),
  kind: guardEventKindSchema,
  said: z.string(),
  corrected: z.boolean(),
});

export type GuardEvent = z.infer<typeof guardEventSchema>;
