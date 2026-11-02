import { MODE_LABELS } from '@orvia/shared';
import { Link } from 'react-router-dom';
import type { SessionSummary } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { diffColor, scoreColor } from '../lib/colors';
import { RunAgainButton } from './RunAgainButton';
import { ErrorNote } from './ui/ErrorNote';

const DIFF_LABEL: Record<string, string> = { easy: 'Easy', medium: 'Med', hard: 'Hard' };

export function HistoryPage() {
  const { data: rows, error, loading, reload } = useApi<SessionSummary[]>('/api/sessions');

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">History</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Every round you have run, and what it covered.
        </p>
      </header>

      {error && <ErrorNote message={`History did not load: ${error}`} onRetry={reload} />}
      {loading && !rows && <p className="text-sm text-fg-muted">Loading…</p>}
      {rows?.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-5 text-sm text-fg-subtle">
          No interviews yet.
        </p>
      )}

      <div className="space-y-1.5">
        {rows?.map((s) => (
          /* The link and the Again button are siblings: a button inside a link
             is invalid HTML, and its click would also follow the link. */
          <div key={s.id}
               className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-md border border-border bg-surface px-3 py-3
                          transition-colors hover:bg-surface-hover sm:flex-nowrap sm:px-4">
            {/* Full width below `sm`, so the chips wrap underneath rather than
                leaving the problem title about a hundred pixels to truncate into. */}
            <Link to={`/session/${s.id}`} className="block min-w-0 basis-full sm:flex-1 sm:basis-auto">
              {(s.kind === 'drill' || s.loop) && (
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                  {s.kind === 'drill'
                    ? `Drill${s.drill ? ` · ${s.drill.label}` : ''}`
                    : `Onsite loop · round ${s.loop!.stage + 1}`}
                </p>
              )}
              {s.questions.length > 0 ? (
                <p className="truncate text-sm font-medium text-fg">
                  {s.questions.map((q) => q.title).join(' · ')}
                </p>
              ) : (
                <p className="text-sm font-medium text-fg">
                  {MODE_LABELS[s.mode] ?? s.mode}
                </p>
              )}

              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-subtle">
                {s.questions.length > 0 && (
                  <>
                    <span>{MODE_LABELS[s.mode] ?? s.mode}</span>
                    {s.questions.some((q) => q.difficulty) && (
                      <span className="flex items-center gap-1">
                        {s.questions
                          .filter((q) => q.difficulty)
                          .map((q) => (
                            <span key={q.id} className="font-semibold"
                                  style={{ color: diffColor(q.difficulty) }}>
                              {DIFF_LABEL[q.difficulty!] ?? q.difficulty}
                            </span>
                          ))}
                      </span>
                    )}
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>{new Date(s.startedAt).toLocaleString()}</span>
                {s.durationMs ? <span>· {(s.durationMs / 60000).toFixed(1)} min</span> : null}
              </p>
            </Link>

            <div className="flex shrink-0 items-center gap-2">
              <RunAgainButton sessionId={s.id} compact />
              {s.overallScore !== null ? (
                <span className="rounded px-2 py-0.5 text-xs font-semibold tabular-nums"
                      style={{
                        color: scoreColor(s.overallScore / 100),
                        background: 'var(--orvia-color-surface-alt)',
                      }}>
                  {Math.round(s.overallScore)}
                </span>
              ) : s.evaluationStatus && s.evaluationStatus !== 'failed' ? (
                <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
                  {s.evaluationStatus === 'complete' ? '' : 'scoring…'}
                </span>
              ) : null}

              <span className="rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                    style={{
                      color: s.status === 'completed' ? 'var(--orvia-color-success)' : 'var(--orvia-color-fg-subtle)',
                      background: s.status === 'completed' ? 'var(--orvia-color-success-muted)' : 'var(--orvia-color-surface-alt)',
                    }}>
                {s.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
