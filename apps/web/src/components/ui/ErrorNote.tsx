/** A failed request, said on screen, with a way to try again when there is one. */
export function ErrorNote({
  message, onRetry, className = '',
}: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={`rounded-md border border-danger bg-danger-muted px-4 py-3 ${className}`}>
      <p className="text-sm text-fg">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="mt-2 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg
                     transition-colors hover:bg-surface-hover">
          Try again
        </button>
      )}
    </div>
  );
}
