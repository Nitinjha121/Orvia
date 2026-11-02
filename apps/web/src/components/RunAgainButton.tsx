import { useRunAgain } from '../lib/replay';

/**
 * Starts a new round using a past round's exact configuration.
 * Preserves the previous round's data and creates a distinct session.
 */
export function RunAgainButton({
  sessionId,
  compact = false,
  label = 'Run this round again',
}: {
  sessionId: string;
  /** The small variant, for a history row. */
  compact?: boolean;
  label?: string;
}) {
  const runAgain = useRunAgain();

  return (
    <button
      type="button"
      onClick={() => runAgain(sessionId)}
      title="Start a new round with the same questions, voice and length"
      className={
        compact
          ? 'shrink-0 rounded border border-border px-2 py-0.5 text-[10px] font-semibold uppercase ' +
            'tracking-wide text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg'
          : 'rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg ' +
            'transition-opacity hover:opacity-90'
      }
    >
      {compact ? 'Again' : label}
    </button>
  );
}
