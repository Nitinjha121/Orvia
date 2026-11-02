import { useEvaluation } from '../hooks/useEvaluation';
import { ReportCard } from './ReportCard';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorNote } from './ui/ErrorNote';

/**
 * The report for one round, or why there is none yet — shared by the end
 * screen and the saved-report page so the two cannot disagree about when a
 * re-run is offered. It is offered only when the server says one could help
 * (`evaluable`); an unknown answer offers nothing.
 */
export function ReportSection({
  sessionId, waitingTitle, waitingHint, missingFallback, missingHint,
}: {
  sessionId: string | null;
  waitingTitle: string;
  waitingHint?: string;
  missingFallback: string;
  missingHint?: string;
}) {
  const { report, missing, waiting, error, retrying, retry } = useEvaluation(sessionId);
  const onRetry = () => void retry();

  return (
    <>
      {error && <ErrorNote message={error} />}
      {report?.latestAttempt?.status === 'failed' && (
        <ErrorNote message={`A re-run of this report failed${report.latestAttempt.error ? `: ${report.latestAttempt.error}` : ''}. The report below is the earlier one.`} />
      )}
      {report ? (
        <ErrorBoundary panel="report">
          <ReportCard report={report} onRetry={retrying ? undefined : onRetry} />
        </ErrorBoundary>
      ) : waiting ? (
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
            <p className="text-sm text-fg">{waitingTitle}</p>
          </div>
          {waitingHint && <p className="mt-2 text-xs text-fg-subtle">{waitingHint}</p>}
        </div>
      ) : error && !missing ? null : (
        <div className="rounded-lg border border-border bg-surface-alt p-5">
          <p className="text-sm text-fg">{missing?.reason ?? missingFallback}</p>
          {missingHint && <p className="mt-1.5 text-xs text-fg-muted">{missingHint}</p>}
          {(missing?.evaluable ?? false) && (
            <button onClick={onRetry} disabled={retrying}
              className="mt-4 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
              {retrying ? 'Starting…' : 'Evaluate it now'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
