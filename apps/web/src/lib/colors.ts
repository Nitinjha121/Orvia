import type { Speaker } from '@orvia/shared';

/**
 * Status colouring in three steps, for any score expressed as a fraction of its
 * maximum. Not a smooth ramp: bar length already encodes the score, so a
 * per-value hue would double-encode it. Every caller shows the numeral too, so
 * colour is never the only encoding.
 */
export function scoreColor(fraction: number): string {
  if (fraction >= 0.7) return 'var(--orvia-color-success)';
  if (fraction >= 0.45) return 'var(--orvia-color-warning)';
  return 'var(--orvia-color-danger)';
}

export const DIFF_COLOR: Record<string, string> = {
  easy: 'var(--orvia-color-success)',
  medium: 'var(--orvia-color-warning)',
  hard: 'var(--orvia-color-danger)',
};

export const diffColor = (difficulty: string | null | undefined) =>
  (difficulty && DIFF_COLOR[difficulty]) || 'var(--orvia-color-fg-subtle)';

export const speakerColor = (speaker: Speaker) =>
  speaker === 'ai' ? 'var(--orvia-color-speaker-ai)' : 'var(--orvia-color-speaker-user)';
