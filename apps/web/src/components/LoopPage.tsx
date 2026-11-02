import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  LOOP_DECISION_LABELS, MODE_SHORT_LABELS, VERDICT_LABELS, type LoopDecision, type LoopStageRound,
  type LoopView,
} from '@orvia/shared';
import { ApiError, api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useContinueLoop } from '../lib/loop';
import { scoreColor } from '../lib/colors';
import { ErrorNote } from './ui/ErrorNote';
import { isUuid } from '../lib/ids';
import { ConfirmButton } from './ui/ConfirmButton';

/**
 * What the decision panel says. The API's `pending` reads "Waiting on reports"
 * whatever the cause, which was shown on an abandoned loop with no rounds at
 * all; an abandoned or unfinished loop is not waiting on any report.
 */
function decisionText(loop: LoopView): { label: string; reasons: string[]; color: string; ruled: boolean } {
  const run = loop.stages.filter((s) => s.round).length;
  const n = loop.stages.length;
  if (loop.abandonedAt && loop.decision === 'pending') {
    return {
      label: 'Abandoned',
      reasons: [`Abandoned after ${run} of ${n} round${n === 1 ? '' : 's'}, so it was never decided.`],
      color: DECISION_COLOR.pending,
      ruled: false,
    };
  }
  if (loop.decision === 'pending' && loop.next !== null) {
    return {
      label: 'In progress',
      reasons: [`${run} of ${n} rounds run. The loop is decided once every round has a finished report.`],
      color: DECISION_COLOR.pending,
      ruled: true,
    };
  }
  return { label: LOOP_DECISION_LABELS[loop.decision], reasons: loop.reasons, color: DECISION_COLOR[loop.decision], ruled: true };
}

/** A stage's round with no verdict yet: whether a report is coming, failed, or will never exist. */
function pendingText(r: LoopStageRound): string {
  if (r.evaluationStatus === 'failed') return 'Report failed — open it to re-run';
  if (r.evaluationStatus === null && r.status !== 'completed') return 'Cut short — no report';
  return 'Report on its way';
}

const DECISION_COLOR: Record<LoopDecision, string> = {
  pending: 'var(--orvia-color-fg-muted)',
  strong_hire: 'var(--orvia-color-success)',
  hire: 'var(--orvia-color-success)',
  lean_no: 'var(--orvia-color-warning)',
  no_hire: 'var(--orvia-color-danger)',
};

/** One onsite loop: its stages, each stage's round, and the combined decision. */
export function LoopPage() {
  const { id = '' } = useParams();
  const { data: loop, error, reload } = useApi<LoopView>(isUuid(id) ? `/api/loops/${id}` : null);
  const continueLoop = useContinueLoop();
  const [actionError, setActionError] = useState<string | null>(null);
  const decision = loop ? decisionText(loop) : null;

  const abandon = async () => {
    setActionError(null);
    try {
      await api.post(`/api/loops/${id}/abandon`);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'The loop could not be abandoned.');
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <Link to="/plan" className="text-sm text-fg-muted hover:text-fg">← Plan</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">{loop?.label ?? 'Onsite loop'}</h1>
        {loop && (
          <p className="mt-1 text-sm text-fg-muted">
            Started {new Date(loop.startedAt).toLocaleString()}
            {loop.abandonedAt ? ' · abandoned' : ''}
          </p>
        )}
      </header>

      {!isUuid(id) && <ErrorNote message="There is no onsite loop at this address. Open it from the Plan page instead." />}
      {error && <ErrorNote message={`This loop could not be loaded: ${error}`} onRetry={reload} />}
      {actionError && <ErrorNote message={actionError} />}

      {loop && decision && (
        <>
          <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
            <p className="text-xs uppercase tracking-wide text-fg-muted">Decision</p>
            <p className="mt-1 text-xl font-semibold" style={{ color: decision.color }}>{decision.label}</p>
            {decision.reasons.map((r, i) => <p key={i} className="mt-1 text-sm text-fg-muted">{r}</p>)}
            {decision.ruled && (
              <p className="mt-3 text-xs text-fg-subtle">
                A fixed rule, not a model's opinion: any fail is a no hire, two borderline rounds lean no, and a
                strong hire needs no doubts and strong passes in at least half the rounds.
              </p>
            )}
          </section>

          <ol className="space-y-2">
            {loop.stages.map((s, i) => {
              const r = s.round;
              const isNext = loop.next === i && !loop.abandonedAt;
              return (
                <li key={i} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-3 sm:px-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">
                      {i + 1}. {MODE_SHORT_LABELS[s.mode]} <span className="text-xs text-fg-subtle">· {s.minutes} min</span>
                    </p>
                    <p className="text-xs text-fg-subtle">
                      {r
                        ? r.verdict
                          ? VERDICT_LABELS[r.verdict]
                          : pendingText(r)
                        : isNext ? 'Up next' : 'Not run yet'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r?.score != null && (
                      <span className="rounded px-2 py-0.5 text-xs font-semibold tabular-nums"
                            style={{ color: scoreColor(r.score / 100), background: 'var(--orvia-color-surface-alt)' }}>
                        {Math.round(r.score)}
                      </span>
                    )}
                    {r && (
                      <Link to={`/session/${r.sessionId}`} className="text-xs font-medium text-brand hover:underline">Report</Link>
                    )}
                    {isNext && (
                      <button type="button"
                        onClick={() => continueLoop({
                          loopId: loop.id, mode: s.mode, minutes: s.minutes, stage: i,
                          of: loop.stages.length, label: loop.label,
                        })}
                        className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90">
                        Set up round {i + 1}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {!loop.abandonedAt && loop.next !== null && (
            <ConfirmButton label="Abandon this loop" question="Abandon this loop? It cannot be resumed."
              confirmLabel="Yes, abandon" onConfirm={abandon}
              className="text-xs font-medium text-fg-muted hover:text-fg" />
          )}
        </>
      )}
    </div>
  );
}
