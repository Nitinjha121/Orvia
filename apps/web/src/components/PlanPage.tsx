import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  COMMITMENT_CLOSE_STREAK, DEFAULT_TARGET_MODES, DELIVERY_DIMENSIONS, INTERVIEW_MODES, LOOP_DECISION_LABELS,
  LOOP_TEMPLATES, LOOP_TEMPLATE_IDS, MAX_OPEN_COMMITMENTS, MODE_SHORT_LABELS, READINESS_LABELS,
  daysUntil, personalBests, readiness, weeklyPlan, weeklyRecap,
  type CommitmentView, type InterviewMode, type LoopTemplateId, type LoopView, type PlanRound,
  type PlanSummary, type ReadinessBand,
} from '@orvia/shared';
import { ApiError, api } from '../lib/api';
import { useApi, type ApiState } from '../hooks/useApi';
import { localDayKey } from '../lib/time';
import { scoreColor } from '../lib/colors';
import { useContinueLoop } from '../lib/loop';
import { ErrorNote } from './ui/ErrorNote';
import { ConfirmButton } from './ui/ConfirmButton';
import { FIELD, LABEL } from './ui/styles';
import { ResultChip } from './PracticePanels';
import { ResolveSection } from './ResolveQueue';
import { usePracticeFromFeed } from '../lib/feedPractice';

const BAND_COLOR: Record<ReadinessBand, string> = {
  not_started: 'var(--orvia-color-fg-subtle)',
  building: 'var(--orvia-color-danger)',
  close: 'var(--orvia-color-warning)',
  ready: 'var(--orvia-color-success)',
};

const signed = (n: number | null, digits = 0) =>
  n === null ? '' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/**
 * Interview preparation status and weekly recommendations.
 * Metrics and readiness decisions are computed from completed rounds via `@orvia/shared/plan`.
 */
export function PlanPage() {
  const plan = useApi<PlanSummary>('/api/plan');
  const commitments = useApi<CommitmentView[]>('/api/commitments');
  const practise = usePracticeFromFeed();
  const today = localDayKey();

  const rounds: PlanRound[] = useMemo(
    () => (plan.data?.rounds ?? []).map((r) => ({ ...r, dayKey: localDayKey(new Date(r.startedAt)) })),
    [plan.data],
  );
  const ready = useMemo(() => readiness(rounds), [rounds]);
  const targetModes = useMemo(() => plan.data?.target.targetModes ?? [], [plan.data]);
  const week = useMemo(
    () => weeklyPlan(ready, targetModes, plan.data?.target.weeklyRounds ?? 4, rounds, today),
    [ready, targetModes, plan.data, rounds, today],
  );
  const recap = useMemo(
    () =>
      weeklyRecap(
        rounds,
        (plan.data?.checks ?? []).map((c) => ({ result: c.result, dayKey: localDayKey(new Date(c.startedAt)) })),
        today,
      ),
    [rounds, plan.data, today],
  );
  const bests = useMemo(() => personalBests(rounds, plan.data?.currentRubric ?? ''), [rounds, plan.data]);

  if (plan.error) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Header />
        <ErrorNote message={`Your plan did not load: ${plan.error}`} onRetry={plan.reload} />
      </div>
    );
  }
  if (!plan.data) return <p className="text-sm text-fg-muted">Loading…</p>;

  const shownModes = targetModes.length ? targetModes : [...DEFAULT_TARGET_MODES];
  const otherTried = ready.filter((r) => !shownModes.includes(r.mode) && r.rounds > 0).map((r) => r.mode);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <Header />
      <TargetCard target={plan.data.target} today={today} onSaved={plan.reload} />

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-fg">This week</h2>
        <p className="mt-1 text-xs text-fg-muted">
          {plan.data.target.weeklyRounds} rounds, spread weakest first. No mode gets more than half the week.
        </p>
        <ul className="mt-3 space-y-2">
          {week.map((w) => {
            const done = Math.min(w.done, w.planned);
            return (
              <li key={w.mode} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-sm text-fg">{MODE_SHORT_LABELS[w.mode]}</span>
                <span className="flex gap-1" aria-label={`${w.done} of ${w.planned} done`}>
                  {Array.from({ length: w.planned }, (_, i) => (
                    <span key={i} className="h-2.5 w-6 rounded-full"
                          style={{ background: i < done ? 'var(--orvia-color-success)' : 'var(--orvia-color-surface-alt)' }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{w.why}</span>
                <span className="shrink-0 text-xs tabular-nums text-fg-muted">{w.done}/{w.planned}</span>
              </li>
            );
          })}
        </ul>
        <Link to="/" className="mt-4 inline-block rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90">
          Set up a round
        </Link>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-fg">Readiness</h2>
        <p className="mt-1 text-xs text-fg-muted">
          The average of your last three rounds in each mode. Ready means 70 or more, across at least two rounds.
        </p>
        <ul className="mt-3 space-y-2.5">
          {[...shownModes, ...otherTried].map((mode) => {
            const r = ready.find((x) => x.mode === mode)!;
            return (
              <li key={mode} className="flex items-center gap-2 sm:gap-3">
                <span className="w-28 shrink-0 truncate text-sm text-fg">{MODE_SHORT_LABELS[mode]}</span>
                <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-alt">
                  {r.score !== null && (
                    <div className="absolute inset-y-0 left-0 rounded-full"
                         style={{ width: `${r.score}%`, background: scoreColor(r.score / 100) }} />
                  )}
                </div>
                <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">
                  {r.score ?? '—'}
                </span>
                <span className="w-24 shrink-0 text-right text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: BAND_COLOR[r.band] }}>
                  {READINESS_LABELS[r.band]}
                </span>
              </li>
            );
          })}
        </ul>
        {ready.some((r) => r.mixedRubric) && (
          <p className="mt-3 text-xs text-fg-subtle">
            Some averages mix rounds scored under different rubric versions, so they are rougher than they look.
          </p>
        )}
      </section>

      <Commitments state={commitments} />

      <ResolveSection onResolve={(id) => practise('dsa', id)} />

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-fg">Your week so far</h2>
        <p className="mt-1 text-xs text-fg-muted">Monday to today, against last week. Drills are counted, never scored.</p>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Rounds" value={`${recap.rounds}`} hint={`${recap.lastWeekRounds} last week`} />
          <Stat label="Drills" value={`${recap.drills}`} hint="moments retried" />
          <Stat label="Average score"
                value={recap.meanScore === null ? '—' : `${Math.round(recap.meanScore)}`}
                hint={recap.meanScore !== null && recap.lastWeekMeanScore !== null
                  ? `${signed(recap.meanScore - recap.lastWeekMeanScore)} on last week`
                  : 'no comparison yet'} />
          <Stat label="Filler words"
                value={recap.fillerRate === null ? '—' : `${recap.fillerRate}`}
                hint={recap.fillerRate !== null && recap.lastWeekFillerRate !== null
                  ? `${signed(recap.fillerRate - recap.lastWeekFillerRate, 1)} per 100 words`
                  : 'per 100 words'} />
        </dl>
        <div className="mt-4 space-y-2 border-t border-border pt-3 text-sm text-fg">
          {recap.mostImproved && (
            <p>
              <span className="text-fg-muted">Most improved: </span>
              {recap.mostImproved.label}, up {recap.mostImproved.delta} on your previous four weeks.
            </p>
          )}
          {recap.fixesChecked > 0 && (
            <p>
              <span className="text-fg-muted">Fixes: </span>
              applied {recap.fixesApplied} of the {recap.fixesChecked} times a round checked one.
            </p>
          )}
          {recap.best && (
            <div>
              <p className="text-fg-muted">Your best moment this week — {DELIVERY_DIMENSIONS.find((d) => d.id === recap.best!.dimension)?.label}, {recap.best.score}/5:</p>
              <blockquote className="mt-1 border-l-2 pl-3 text-sm italic text-fg"
                          style={{ borderColor: 'var(--orvia-color-success)' }}>
                “{recap.best.quote}”
              </blockquote>
              <Link to={`/session/${recap.best.sessionId}`} className="mt-1 inline-block text-xs font-medium text-brand hover:underline">
                Hear it in the report ({recap.best.label})
              </Link>
            </div>
          )}
          {!recap.rounds && !recap.drills && <p className="text-fg-subtle">Nothing yet this week.</p>}
        </div>
      </section>

      {bests.length > 0 && (
        <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-fg">Personal bests</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Scores count within the current rubric only; measured numbers count across everything.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {bests.map((b) => (
              <li key={b.id} className="min-w-0 rounded-md border border-border p-3">
                <p className="truncate text-xs text-fg-muted">{b.label}</p>
                <p className="mt-0.5 truncate text-base font-semibold text-fg" title={b.value}>{b.value}</p>
                <p className="text-[11px] text-fg-subtle">
                  {b.dayKey}
                  {b.sessionId && (
                    <> · <Link to={`/session/${b.sessionId}`} className="text-brand hover:underline">the round</Link></>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Loops loops={plan.data.loops} onCreated={plan.reload} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Plan</h1>
      <p className="mt-1 text-sm text-fg-muted">What you are preparing for, and what to do about it this week.</p>
    </header>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-fg">{value}</dd>
      <dd className="truncate text-[11px] text-fg-subtle">{hint}</dd>
    </div>
  );
}

function TargetCard({
  target, today, onSaved,
}: { target: PlanSummary['target']; today: string; onSaved: () => void }) {
  const [company, setCompany] = useState(target.targetCompany ?? '');
  const [role, setRole] = useState(target.targetRole ?? '');
  const [date, setDate] = useState(target.targetDate ?? '');
  const [weekly, setWeekly] = useState(target.weeklyRounds);
  const [modes, setModes] = useState<InterviewMode[]>(target.targetModes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!target.targetDate && !target.targetCompany);

  useEffect(() => {
    setCompany(target.targetCompany ?? '');
    setRole(target.targetRole ?? '');
    setDate(target.targetDate ?? '');
    setWeekly(target.weeklyRounds);
    setModes(target.targetModes);
  }, [target]);

  const left = target.targetDate ? daysUntil(target.targetDate, today) : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/profile', {
        targetCompany: company.trim() || null,
        targetRole: role.trim() || null,
        targetDate: date || null,
        weeklyRounds: weekly,
        targetModes: modes,
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Your target could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const toggleMode = (m: InterviewMode) =>
    setModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Preparing for</p>
          <p className="mt-0.5 text-lg font-semibold text-fg">
            {target.targetCompany || target.targetRole
              ? [target.targetRole, target.targetCompany].filter(Boolean).join(' at ')
              : 'No target set yet'}
          </p>
          {left !== null && (
            <p className="mt-0.5 text-sm tabular-nums"
               style={{ color: left < 0 ? 'var(--orvia-color-fg-subtle)' : left <= 7 ? 'var(--orvia-color-warning)' : 'var(--orvia-color-fg-muted)' }}>
              {left > 1 ? `${left} days to go` : left === 1 ? 'Tomorrow' : left === 0 ? 'Today' : `${-left} days ago`}
              {' '}· {target.targetDate}
            </p>
          )}
        </div>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-hover">
            Edit
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={LABEL} htmlFor="t-company">Company</label>
              <input id="t-company" className={FIELD} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Amazon" />
            </div>
            <div>
              <label className={LABEL} htmlFor="t-role">Role</label>
              <input id="t-role" className={FIELD} value={role} onChange={(e) => setRole(e.target.value)} placeholder="SDE 2" />
            </div>
            <div>
              <label className={LABEL} htmlFor="t-date">Interview date</label>
              <input id="t-date" type="date" className={FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="t-weekly">Rounds a week — {weekly}</label>
            <input id="t-weekly" type="range" min={1} max={14} value={weekly}
                   onChange={(e) => setWeekly(Number(e.target.value))} className="w-full accent-brand" />
          </div>
          <div>
            <span className={LABEL}>What the loop will include</span>
            <div className="flex flex-wrap gap-1.5">
              {INTERVIEW_MODES.map((m) => (
                <button key={m} type="button" onClick={() => toggleMode(m)} aria-pressed={modes.includes(m)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    modes.includes(m) ? 'bg-brand text-brand-fg' : 'bg-surface-alt text-fg-muted hover:text-fg'}`}>
                  {MODE_SHORT_LABELS[m]}
                </button>
              ))}
            </div>
            {!modes.length && (
              <p className="mt-1.5 text-xs text-fg-subtle">
                None picked: the plan uses {DEFAULT_TARGET_MODES.map((m) => MODE_SHORT_LABELS[m]).join(', ')}.
              </p>
            )}
          </div>
          {error && <ErrorNote message={error} />}
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} disabled={saving}
              className="rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {(target.targetDate || target.targetCompany) && (
              <button type="button" onClick={() => setEditing(false)}
                className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-fg hover:bg-surface-hover">
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Commitments({ state }: { state: ApiState<CommitmentView[]> }) {
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const all = state.data ?? [];
  const open = all.filter((c) => c.status === 'open');
  const closed = all.filter((c) => c.status === 'closed').slice(0, 5);

  const drop = async (id: string) => {
    setError(null);
    try {
      await api.del(`/api/commitments/${id}`);
      state.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That commitment could not be dropped.');
    }
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/commitments', { text });
      setText('');
      state.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That commitment could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Working on</h2>
        <span className="text-xs tabular-nums text-fg-muted">{open.length}/{MAX_OPEN_COMMITMENTS} open</span>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        Shown to you in every round and checked by the evaluator after it. Applied in {COMMITMENT_CLOSE_STREAK} rounds
        in a row and it is done. The interviewer is never told.
      </p>
      {state.error && <ErrorNote className="mt-3" message={`Commitments did not load: ${state.error}`} onRetry={state.reload} />}

      <ul className="mt-3 space-y-2.5">
        {open.map((c) => (
          <li key={c.id} className="rounded-md border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm text-fg">{c.text}</p>
              <ConfirmButton label="Drop" question="Drop this commitment?" confirmLabel="Yes, drop"
                onConfirm={() => drop(c.id)} ariaLabel={`Drop: ${c.text.slice(0, 60)}`}
                className="shrink-0 text-xs font-medium text-fg-muted hover:text-fg" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs tabular-nums text-fg-muted">
                {c.progress.streak} of {COMMITMENT_CLOSE_STREAK} in a row
              </span>
              {c.history.slice(-6).map((h) => (
                <Link key={h.sessionId} to={`/session/${h.sessionId}`} title={new Date(h.startedAt).toLocaleString()}>
                  <ResultChip result={h.result} />
                </Link>
              ))}
              {c.sourceSessionId && (
                <Link to={`/session/${c.sourceSessionId}`} className="text-xs text-brand hover:underline">from this round</Link>
              )}
            </div>
          </li>
        ))}
        {!open.length && state.data && (
          <li className="text-sm text-fg-subtle">
            Nothing yet. Press “Work on this” on any report's fixes, or write your own below.
          </li>
        )}
      </ul>

      {open.length < MAX_OPEN_COMMITMENTS && (
        <div className="mt-3 flex gap-2">
          <input className={FIELD} value={text} onChange={(e) => setText(e.target.value)}
                 placeholder="e.g. State the complexity before writing any code" aria-label="A fix to work on" />
          <button type="button" onClick={() => void add()} disabled={busy || text.trim().length < 5}
            className="shrink-0 rounded-md bg-brand px-3 py-2 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-40">
            Add
          </button>
        </div>
      )}
      {error && <ErrorNote className="mt-3" message={error} />}

      {closed.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Done</p>
          <ul className="mt-2 space-y-1">
            {closed.map((c) => (
              <li key={c.id} className="flex gap-2 text-sm text-fg">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                <span className="min-w-0">{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Loops({ loops, onCreated }: { loops: LoopView[]; onCreated: () => void }) {
  const continueLoop = useContinueLoop();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<LoopTemplateId | null>(null);
  const active = loops.filter((l) => !l.abandonedAt && l.next !== null);

  const create = async (template: LoopTemplateId) => {
    setBusy(template);
    setError(null);
    try {
      const loop = await api.post<LoopView>('/api/loops', { template });
      onCreated();
      const first = loop.stages[0]!;
      continueLoop({ loopId: loop.id, mode: first.mode, minutes: first.minutes, stage: 0, of: loop.stages.length, label: loop.label });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The loop could not be started.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-fg">Onsite loops</h2>
      <p className="mt-1 text-xs text-fg-muted">
        Several rounds back to back, judged together by a fixed hiring-committee rule. Stamina is part of the test.
      </p>

      {loops.length > 0 && (
        <ul className="mt-3 space-y-2">
          {loops.map((l) => (
            <li key={l.id}>
              <Link to={`/loop/${l.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 hover:bg-surface-hover">
                <span className="min-w-0 text-sm text-fg">
                  {l.label} <span className="text-xs text-fg-subtle">· {new Date(l.startedAt).toLocaleDateString()}</span>
                </span>
                <span className="text-xs text-fg-muted">
                  {l.abandonedAt
                    ? 'Abandoned'
                    : l.next !== null
                      ? `Round ${l.next + 1} of ${l.stages.length} next`
                      : LOOP_DECISION_LABELS[l.decision]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {LOOP_TEMPLATE_IDS.map((id) => {
          const t = LOOP_TEMPLATES[id];
          return (
            <div key={id} className="flex flex-col rounded-md border border-border p-3">
              <p className="text-sm font-semibold text-fg">{t.label}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{t.blurb}</p>
              <p className="mt-2 text-[11px] text-fg-subtle">
                {t.stages.map((s) => `${MODE_SHORT_LABELS[s.mode]} ${s.minutes}m`).join(' → ')}
              </p>
              <button type="button" onClick={() => void create(id)} disabled={busy !== null}
                className="mt-3 self-start rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-hover disabled:opacity-50">
                {busy === id ? 'Starting…' : active.length ? 'Start another' : 'Start this loop'}
              </button>
            </div>
          );
        })}
      </div>
      {error && <ErrorNote className="mt-3" message={error} />}
    </section>
  );
}
