import type { EvaluationReport } from '@orvia/shared';

export type AudioPayload = { data: string; mimeType: string; path: string };

export type EvaluatorResult = {
  report: EvaluationReport;
  provider: string;
  model: string;
  /**
   * Whether the model LISTENED to the recording or only read a transcript.
   * Stored on the report because it changes what the delivery scores are
   * worth, and the report must not imply it heard what it did not.
   */
  audioAnalysed: boolean;
};

/**
 * Thrown when every model rejected the request as malformed (400) while the
 * recording was attached. The same payload fails on every model, so the
 * caller retries once with the prompt rebuilt for a transcript-only read — the
 * prompt tells the model whether it can hear the audio, so it cannot just be
 * resent without it.
 */
export class AudioRejectedError extends Error {
  override readonly name = 'AudioRejectedError';
}

/**
 * Only Gemini implements this — it is the one provider whose model hears the
 * recording. The seam stays because a text-only fallback (Groq and SambaNova
 * were both built and removed once the Live API turned out to be unmetered) is
 * one file against it, and because tests substitute it.
 */
export interface EvaluatorProvider {
  readonly name: string;
  readonly supportsAudio: boolean;
  /**
   * `assignedIds` constrain `assignedQuestions[].questionId`, and `focusKeys`
   * constrain `focusChecks[].key`, in the response schema, so they travel
   * separately from the prompt.
   */
  evaluate(
    prompt: string,
    audio: AudioPayload | null,
    assignedIds?: string[],
    focusKeys?: string[],
  ): Promise<EvaluatorResult>;
}
