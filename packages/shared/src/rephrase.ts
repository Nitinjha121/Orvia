/**
 * "Say it better": each substantial thing the candidate said in a round, beside
 * a tighter version of the same content, for reading practice on concision and
 * fluency. It never judges correctness — the report does that — so a rewrite
 * carries the candidate's ideas, right or wrong, and adds none.
 */

/** Shorter paragraphs are acknowledgements ("okay", "from collections import deque"), not explanations. */
export const REPHRASE_MIN_WORDS = 12;

export type RephraseStatus = 'none' | 'writing' | 'complete' | 'failed';

export type RephraseItem = {
  /** Position among the round's rewritable paragraphs. */
  idx: number;
  /** The interviewer line it answered, trimmed. Null for the candidate opening. */
  asked: string | null;
  said: string;
  /** Null when the model judged it already clear, or its rewrite was not shorter. */
  better: string | null;
  /** The habit the rewrite removes, one sentence. */
  why: string | null;
  saidWords: number;
  betterWords: number | null;
};

export type RephraseView = {
  status: RephraseStatus;
  items: RephraseItem[];
  model: string | null;
  error: string | null;
  createdAt: string | null;
};

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
