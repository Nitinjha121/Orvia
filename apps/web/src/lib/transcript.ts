import type { Speaker } from '@orvia/shared';

export type TranscriptEntry = {
  id: string;
  speaker: Speaker;
  text: string;
  final: boolean;
  /** ms since the conversation started. */
  atMs: number;
};

/**
 * Folds one transcript fragment into the list. Pure, and shared by the
 * interview and the coach so the two transcripts cannot drift apart.
 *
 * An interim replaces the previous interim from the same speaker — appending
 * would render the sentence growing one copy at a time — and consecutive final
 * fragments from one speaker are one utterance.
 */
export function appendFragment(prev: TranscriptEntry[], e: Omit<TranscriptEntry, 'id'>): TranscriptEntry[] {
  const last = prev[prev.length - 1];
  if (last && last.speaker === e.speaker && !last.final) {
    return [...prev.slice(0, -1), { ...last, text: e.text, final: e.final, atMs: e.atMs }];
  }
  if (last && last.speaker === e.speaker && last.final && e.final) {
    return [...prev.slice(0, -1), { ...last, text: `${last.text} ${e.text}`.trim() }];
  }
  return [...prev, { ...e, id: `${e.speaker}-${prev.length}-${e.atMs}` }];
}
