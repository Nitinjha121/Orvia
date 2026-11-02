/**
 * Placeholder marker inserted when a model turn completes audio generation
 * without delivering an output transcription, preserving dialogue structure
 * for subsequent evaluation and reporting.
 */

/** What the evaluator and the report card match on. Keep the two in step. */
export const UNTRANSCRIBED_TURN_MARKER = 'interviewer spoke — transcript unavailable';

export function untranscribedTurnText(durationMs: number): string {
  return `[${UNTRANSCRIBED_TURN_MARKER}: about ${(durationMs / 1000).toFixed(1)} seconds of speech the transcription service did not return]`;
}
