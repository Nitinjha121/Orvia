import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MODE_SHORT_LABELS, type LoopView, type SessionEndedPayload, type SessionReadyPayload } from '@orvia/shared';
import type { TranscriptEntry } from '../lib/transcript';
import { useApi } from '../hooks/useApi';
import { useContinueLoop } from '../lib/loop';
import { TranscriptView } from './TranscriptView';
import { ReportSection } from './ReportSection';
import { cutShortCause, endedCutShort } from '../lib/roundEnd';

export function EndScreen({
  summary, transcript, onReset, onRunAgain, practice = {},
}: {
  summary: SessionEndedPayload | null;
  transcript: TranscriptEntry[];
  /** What the round carried, as the server decided at start. */
  practice?: Pick<SessionReadyPayload, 'focus' | 'drill' | 'loop'>;
  onReset: () => void;
  /**
   * Runs the same setup again as a NEW round — same questions in the same
   * order, same voice, same length, same bar. Absent only if this screen was
   * reached without a setup in hand, which cannot happen from a live round.
   */
  onRunAgain?: () => void;
}) {
  const [showTranscript, setShowTranscript] = useState(false);

  const mins = summary ? (summary.durationMs / 60000).toFixed(1) : '0';
  const cutShort = summary !== null && endedCutShort(summary.reason);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-fg">
            {cutShort ? 'Round cut short' : 'Round complete'}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {mins} minutes · {summary?.turnCount ?? 0} turns
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRunAgain && (
            <button onClick={onRunAgain}
              className="rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg
                         transition-opacity hover:opacity-90">
              {practice.drill ? 'Retry this moment again' : 'Run this round again'}
            </button>
          )}
          <button onClick={onReset}
            className="rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg
                       transition-colors hover:bg-surface-hover">
            New interview
          </button>
        </div>
      </header>

      {cutShort && summary && (
        <div role="status" className="rounded-md border border-border bg-warning-muted px-4 py-3">
          <p className="text-sm text-fg">{cutShortCause(summary.reason)}</p>
          <p className="mt-1 text-xs text-fg-muted">
            What was recorded up to that point is kept. A round that ends this way is not scored by itself, but it
            can be scored from that recording — here, or later from its page in History.
          </p>
        </div>
      )}

      {practice.loop && <LoopNext loopId={practice.loop.id} onLeave={onReset} />}

      <ReportSection
        sessionId={summary?.sessionId ?? null}
        // A cut-short round is never queued, so "waiting" here only means the
        // server has not answered yet — during a restart, for as long as it is down.
        waitingTitle={cutShort ? 'Checking whether this round can be scored…' : 'Preparing your report…'}
        waitingHint={cutShort
          ? 'Waiting for the interview server to answer.'
          : 'The evaluator is listening back to the whole recording. This usually takes a minute or two.'}
        missingFallback="No report was generated for this round."
        missingHint={
          cutShort
            ? 'Scoring a cut-short round judges only the part that was recorded.'
            : 'Rounds are only scored if you actually spoke and the session ended cleanly.'
        }
      />

      <div>
        <button onClick={() => setShowTranscript(!showTranscript)}
          className="text-sm font-medium text-brand hover:underline">
          {showTranscript ? 'Hide transcript' : 'Show full transcript'}
        </button>
        {showTranscript && (
          <div className="mt-3 flex h-96 flex-col">
            <TranscriptView entries={transcript} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The loop's next stage, straight after this one — the point of a loop is that
 * the rounds come back to back. Read from the server, which is the only place
 * that knows whether this round ran long enough to fill its stage.
 */
function LoopNext({ loopId, onLeave }: { loopId: string; onLeave: () => void }) {
  const { data: loop } = useApi<LoopView>(`/api/loops/${loopId}`);
  const continueLoop = useContinueLoop();
  if (!loop) return null;
  const next = loop.next === null ? null : loop.stages[loop.next]!;

  return (
    <section className="rounded-lg border border-border bg-brand-muted p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-fg">{loop.label} — onsite loop</h3>
      {next ? (
        <>
          <p className="mt-1 text-sm text-fg-muted">
            Next: round {loop.next! + 1} of {loop.stages.length}, {MODE_SHORT_LABELS[next.mode]} for {next.minutes} minutes.
            Take a short break if you need one — a real loop gives you about five minutes.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button"
              onClick={() => {
                onLeave();
                continueLoop({
                  loopId: loop.id, mode: next.mode, minutes: next.minutes,
                  stage: loop.next!, of: loop.stages.length, label: loop.label,
                });
              }}
              className="rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg hover:opacity-90">
              Set up round {loop.next! + 1}
            </button>
            <Link to={`/loop/${loop.id}`}
              className="rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg hover:bg-surface-hover">
              See the loop
            </Link>
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-fg-muted">
          That was the last round. The loop's decision appears once every report is in —{' '}
          <Link to={`/loop/${loop.id}`} className="font-medium text-brand hover:underline">see the loop</Link>.
        </p>
      )}
    </section>
  );
}
