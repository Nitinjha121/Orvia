import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DRILL_MINUTE_CHOICES, FOCUS_RESULT_LABELS, MAX_OPEN_COMMITMENTS, VERDICT_LABELS,
  type CommitmentView, type DrillView, type EvaluationView, type FocusResult, type MomentsView,
} from '@orvia/shared';
import { ApiError, api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useStartDrill } from '../lib/drill';
import { scoreColor } from '../lib/colors';
import { PlayFrom } from './RecordingPlayer';
import { ErrorNote } from './ui/ErrorNote';

const RESULT_STYLE: Record<FocusResult, { color: string; bg: string }> = {
  applied: { color: 'var(--orvia-color-success)', bg: 'var(--orvia-color-success-muted)' },
  partly: { color: 'var(--orvia-color-warning)', bg: 'var(--orvia-color-warning-muted)' },
  not_applied: { color: 'var(--orvia-color-danger)', bg: 'var(--orvia-color-danger-muted)' },
  no_chance: { color: 'var(--orvia-color-fg-subtle)', bg: 'var(--orvia-color-surface-alt)' },
};

export function ResultChip({ result }: { result: FocusResult | null }) {
  const style = result ? RESULT_STYLE[result] : RESULT_STYLE.no_chance;
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: style.color, background: style.bg }}>
      {result ? FOCUS_RESULT_LABELS[result] : 'Not judged'}
    </span>
  );
}

/**
 * The three fixes, each one a button that carries it into the next rounds.
 *
 * A commitment is what turns a report you read once into something the next
 * round checks. Capped at `MAX_OPEN_COMMITMENTS` server-side; the refusal is
 * shown as it comes back rather than second-guessed here.
 */
export function TopFixes({ fixes, sessionId }: { fixes: string[]; sessionId: string }) {
  const commitments = useApi<CommitmentView[]>('/api/commitments');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (commitments.data ?? []).filter((c) => c.status === 'open');
  const committed = (text: string) => open.some((c) => c.text.trim().toLowerCase() === text.trim().toLowerCase());

  const commit = async (text: string, i: number) => {
    setBusy(i);
    setError(null);
    try {
      await api.post('/api/commitments', { text, sourceSessionId: sessionId });
      commitments.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That fix could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-brand-muted p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Fix these three next time</h3>
        <span className="text-xs text-fg-muted">
          {open.length}/{MAX_OPEN_COMMITMENTS} open commitments ·{' '}
          <Link to="/plan" className="font-medium text-brand hover:underline">Plan</Link>
        </span>
      </div>
      <ol className="mt-3 space-y-2.5">
        {fixes.map((f, i) => (
          <li key={i} className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                             bg-brand text-[11px] font-semibold text-brand-fg">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 text-sm leading-relaxed text-fg">{f}</span>
            {committed(f) ? (
              <span className="shrink-0 rounded px-2 py-1 text-[11px] font-semibold text-success">Working on it</span>
            ) : (
              <button type="button" onClick={() => void commit(f, i)} disabled={busy !== null || !commitments.data}
                title="Carry this into your next rounds; the evaluator will check whether you applied it"
                className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold
                           text-fg transition-colors hover:bg-surface-hover disabled:opacity-50">
                {busy === i ? 'Saving…' : 'Work on this'}
              </button>
            )}
          </li>
        ))}
      </ol>
      {error && <ErrorNote className="mt-3" message={error} />}
    </section>
  );
}

/** Each thing this round carried, and whether the evaluator saw it. */
export function FocusResults({ focus, isDrill }: { focus: EvaluationView['focus']; isDrill: boolean }) {
  if (!focus.length) return null;
  const applied = focus.filter((f) => f.result === 'applied').length;
  const judged = focus.filter((f) => f.result && f.result !== 'no_chance').length;

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">
          {isDrill ? 'Did the fix hold?' : 'What you were working on'}
        </h3>
        {judged > 0 && (
          <span className="text-xs tabular-nums text-fg-muted">{applied} of {judged} applied</span>
        )}
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        Checked separately from the scores: whether each one showed up in what you actually said.
      </p>
      <ul className="mt-3 space-y-2.5">
        {focus.map((f) => (
          <li key={f.key} className="rounded-md border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm text-fg">{f.text}</p>
              <ResultChip result={f.result} />
            </div>
            {f.note && <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{f.note}</p>}
            {f.evidenceQuote && (
              <blockquote className="mt-2 border-l-2 pl-3 text-xs italic leading-relaxed text-fg-subtle"
                          style={{ borderColor: 'var(--orvia-color-border-strong)' }}>
                “{f.evidenceQuote}”
              </blockquote>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const score = (n: number | null, outOf: number) =>
  n === null ? '—' : `${Number.isInteger(n) ? n : n.toFixed(1)}/${outOf}`;

/**
 * Before and after, on the same scale, for a drill.
 *
 * Says plainly what the comparison is worth: you read the report and its model
 * answer before retrying, so this measures whether the FIX held, and that is
 * why drills never touch the progress chart.
 */
export function DrillComparison({ drill }: { drill: DrillView }) {
  const startDrill = useStartDrill();
  const { before, after, attempts } = drill;
  const delta = after.score === null ? null : after.score - before.score;

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        Drill · {drill.kind === 'delivery' ? drill.label : 'one question'}
      </p>
      <h3 className="mt-1 text-sm font-semibold text-fg">{drill.question}</h3>

      <div className="mt-4 flex flex-wrap items-center gap-4 sm:gap-6">
        <div>
          <p className="text-xs text-fg-muted">Before</p>
          <p className="text-2xl font-semibold tabular-nums" style={{ color: scoreColor(before.score / before.outOf) }}>
            {score(before.score, before.outOf)}
          </p>
        </div>
        <span aria-hidden className="text-lg text-fg-subtle">→</span>
        <div>
          <p className="text-xs text-fg-muted">This drill</p>
          <p className="text-2xl font-semibold tabular-nums"
             style={{ color: after.score === null ? 'var(--orvia-color-fg-subtle)' : scoreColor(after.score / after.outOf) }}>
            {score(after.score, after.outOf)}
          </p>
        </div>
        {delta !== null && (
          <span className="rounded px-2 py-0.5 text-xs font-semibold tabular-nums"
                style={{
                  color: delta > 0 ? 'var(--orvia-color-success)' : delta < 0 ? 'var(--orvia-color-danger)' : 'var(--orvia-color-fg-muted)',
                  background: 'var(--orvia-color-surface-alt)',
                }}>
            {delta > 0 ? '+' : ''}{Number.isInteger(delta) ? delta : delta.toFixed(1)}
          </span>
        )}
      </div>

      {attempts.length > 1 && (
        <div className="mt-4">
          <p className="text-xs text-fg-muted">Every attempt at this moment</p>
          <ol className="mt-1.5 flex flex-wrap gap-1.5">
            <li className="rounded bg-surface-alt px-2 py-0.5 text-xs tabular-nums text-fg-muted">
              round {score(before.score, before.outOf)}
            </li>
            {attempts.map((a, i) => (
              <li key={a.sessionId}>
                <Link to={`/session/${a.sessionId}`}
                  className="block rounded bg-surface-alt px-2 py-0.5 text-xs tabular-nums text-fg hover:bg-surface-hover">
                  #{i + 1} {a.after === null ? (a.evaluationStatus === 'complete' ? '—' : 'scoring…') : score(a.after, a.outOf)}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="mt-4 text-xs text-fg-subtle">
        You had read the report before this, so it shows whether the fix held — not how you would do cold.
        That is also why drills stay out of your progress chart.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => startDrill(drill.sourceSessionId, drill.momentId)}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90">
          Retry again
        </button>
        <Link to={`/session/${drill.sourceSessionId}`}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-hover">
          The original round
        </Link>
      </div>
    </section>
  );
}

const LENGTHS = ['default', ...DRILL_MINUTE_CHOICES.map(String)] as const;
/**
 * Limits initial displayed retriable moments to the highest-priority weaknesses.
 */
const SHOWN_MOMENTS = 4;

/**
 * Retriable moments presented as action buttons.
 * Retrying starts a targeted live round on that question with the weaknesses
 * shown on screen and verified afterwards.
 */
export function MomentsPanel({ sessionId }: { sessionId: string }) {
  const { data, error, reload } = useApi<MomentsView>(`/api/sessions/${sessionId}/moments`);
  const startDrill = useStartDrill();
  const [length, setLength] = useState<(typeof LENGTHS)[number]>('default');
  const [all, setAll] = useState(false);

  if (error) return <ErrorNote message={`The moments to retry did not load: ${error}`} onRetry={reload} />;
  if (!data || !data.offersMoments) return null;

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">Practise the moments that cost you</h3>
          <p className="mt-1 text-xs text-fg-muted">
            A short spoken retry of one question, with what to fix on screen. As many times as it takes.
          </p>
        </div>
        {data.moments.length > 0 && (
          <label className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
            Length
            <select value={length} onChange={(e) => setLength(e.target.value as (typeof LENGTHS)[number])}
              className="rounded border border-border bg-surface-alt px-2 py-1 text-xs text-fg">
              {LENGTHS.map((l) => (
                <option key={l} value={l}>{l === 'default' ? 'Suggested' : `${l} min`}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {data.reason && <p className="mt-3 text-sm text-fg-muted">{data.reason}</p>}

      <ul className="mt-3 space-y-2.5">
        {(all ? data.moments : data.moments.slice(0, SHOWN_MOMENTS)).map((m) => {
          const best = m.attempts.reduce<number | null>((a, x) => (x.after !== null && (a === null || x.after > a) ? x.after : a), null);
          return (
            <li key={m.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                    {m.kind === 'question' ? 'Question' : `Delivery · ${m.label}`}
                    {m.before.verdict && ` · ${VERDICT_LABELS[m.before.verdict]}`}
                  </p>
                  <p className="mt-0.5 text-sm text-fg">{m.kind === 'question' ? m.label : (m.question ?? m.label)}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums"
                      style={{ color: scoreColor(m.before.score / m.before.outOf) }}>
                  {score(m.before.score, m.before.outOf)}
                </span>
              </div>

              {m.before.quote && (
                <blockquote className="mt-2 border-l-2 pl-3 text-xs italic leading-relaxed text-fg-subtle"
                            style={{ borderColor: 'var(--orvia-color-border-strong)' }}>
                  “{m.before.quote}”
                </blockquote>
              )}
              <p className="mt-2 text-xs leading-relaxed text-fg-muted">{m.advice}</p>
              {m.focus.length > 0 && m.kind === 'question' && (
                <ul className="mt-2 space-y-1">
                  {m.focus.map((f, i) => (
                    <li key={i} className="flex gap-2 text-xs leading-relaxed text-fg">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-danger" aria-hidden />
                      {f}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={!!m.unavailable}
                  onClick={() => startDrill(sessionId, m.id, length === 'default' ? undefined : Number(length))}
                  title={m.unavailable ?? 'Start a short live retry of this moment'}
                  className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90
                             disabled:cursor-not-allowed disabled:opacity-40">
                  {m.attempts.length ? 'Retry again' : 'Retry this moment'}
                </button>
                <PlayFrom atMs={m.before.atMs} label="Hear the original" />
                {m.attempts.length > 0 && (
                  <span className="text-xs tabular-nums text-fg-muted">
                    Tried {m.attempts.length}×{best !== null ? ` · best ${score(best, m.before.outOf)}` : ''}
                    {' · '}
                    <Link to={`/session/${m.attempts.at(-1)!.sessionId}`} className="text-brand hover:underline">latest</Link>
                  </span>
                )}
              </div>
              {m.unavailable && <p className="mt-2 text-xs text-fg-subtle">{m.unavailable}</p>}
            </li>
          );
        })}
      </ul>
      {data.moments.length > SHOWN_MOMENTS && (
        <button type="button" onClick={() => setAll(!all)}
          className="mt-3 text-xs font-medium text-brand hover:underline">
          {all ? 'Show the weakest only' : `Show all ${data.moments.length}`}
        </button>
      )}
    </section>
  );
}
