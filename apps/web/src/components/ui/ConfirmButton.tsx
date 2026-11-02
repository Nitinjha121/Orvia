import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * A destructive action that asks once, inline, before it runs.
 *
 * The first press swaps the button for the question and two answers; focus
 * lands on Cancel so a second Enter cannot destroy anything, and Escape or
 * Cancel puts focus back on the original button.
 */
export function ConfirmButton({
  label, question, confirmLabel, onConfirm, busy = false, disabled = false, ariaLabel, className = '',
}: {
  label: string;
  /** e.g. "Abandon this loop?" */
  question: string;
  /** e.g. "Yes, abandon" */
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  disabled?: boolean;
  /** For the trigger, when `label` alone does not say what it acts on. */
  ariaLabel?: string;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (wasAsking.current) trigger.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setAsking(false);
    }
  };

  if (!asking) {
    return (
      <button ref={trigger} type="button" onClick={() => setAsking(true)} disabled={disabled || busy}
        aria-label={ariaLabel} className={className}>
        {busy ? '…' : label}
      </button>
    );
  }

  return (
    <span role="group" aria-label={question} onKeyDown={onKeyDown}
      className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs text-fg">{question}</span>
      <button type="button" disabled={busy}
        onClick={async () => {
          try {
            await onConfirm();
          } finally {
            setAsking(false);
          }
        }}
        className="rounded-md border border-danger bg-danger-muted px-2.5 py-1 text-xs font-semibold text-fg
                   transition-colors hover:opacity-90 disabled:opacity-50">
        {busy ? '…' : confirmLabel}
      </button>
      <button ref={cancelRef} type="button" onClick={() => setAsking(false)}
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-muted
                   transition-colors hover:bg-surface-hover hover:text-fg">
        Cancel
      </button>
    </span>
  );
}
