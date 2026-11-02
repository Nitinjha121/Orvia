import { useMemo } from 'react';
import { MODE_LABELS, VERDICT_LABELS, type InterviewMode, type Verdict } from '@orvia/shared';
import { useApi } from '../hooks/useApi';
import { ErrorNote } from './ui/ErrorNote';
import { LineChart, type Point } from './charts/LineChart';
import { CoachPanel } from './CoachPanel';
import { MentorMemory } from './MentorMemory';
import { DimensionBars } from './charts/DimensionBars';
import { scoreColor } from '../lib/colors';
import { TopicBars, type TopicRow } from './charts/TopicBars';

/** One row of `GET /api/progress` (`progress.controller.ts`); not declared in shared yet. */
type Row = {
  sessionId: string;
  mode: InterviewMode;
  startedAt: string;
  overallScore: number | null;
  overallVerdict: Verdict | null;
  rubricVersion: string;
  wordsPerMinute: number | null;
  fillerRate: number | null;
  talkRatio: number | null;
  meanTurnWords: number | null;
  medianResponseLatencyMs: number | null;
  delivery: Record<string, number>;
};

type Progress = { currentRubric: string; sessions: Row[]; topics: TopicRow[] };

export function ProgressPage() {
  const { data, error, reload } = useApi<Progress>('/api/progress');

  const rows = useMemo(() => data?.sessions ?? [], [data]);

  const series = useMemo(() => {
    const at = (r: Row) => new Date(r.startedAt).getTime();
    const lbl = (r: Row) =>
      `${new Date(r.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${MODE_LABELS[r.mode] ?? r.mode}`;
    const pick = (f: (r: Row) => number | null): Point[] =>
      rows.filter((r) => f(r) != null).map((r) => ({ x: at(r), y: f(r)!, label: lbl(r) }));

    return {
      score: pick((r) => r.overallScore),
      wpm: pick((r) => r.wordsPerMinute),
      filler: pick((r) => r.fillerRate),
      talk: pick((r) => (r.talkRatio != null ? r.talkRatio * 100 : null)),
      latency: pick((r) => (r.medianResponseLatencyMs != null ? r.medianResponseLatencyMs / 1000 : null)),
    };
  }, [rows]);

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <Header count={0} />
        <ErrorNote message={`Progress did not load: ${error}`} onRetry={reload} />
        <MentorMemory />
      </div>
    );
  }
  if (!data) return <p className="text-sm text-fg-muted">Loading…</p>;

  if (rows.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <Header count={0} />
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg">No scored rounds yet.</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-fg-muted">
            Finish an interview and its report will appear here. Trends need at least two rounds
            before they mean anything.
          </p>
        </div>
        {/* The mentor saves notes from conversations, which can happen before
            any round is scored; those notes are used, so they must be deletable. */}
        <MentorMemory />
      </div>
    );
  }

  const latest = rows[rows.length - 1]!;
  const first = rows[0]!;
  const prev = rows.length > 1 ? rows[rows.length - 2] : undefined;
  const mixedRubrics = new Set(rows.map((r) => r.rubricVersion)).size > 1;

  const best = rows.reduce((a, b) => ((b.overallScore ?? 0) > (a.overallScore ?? 0) ? b : a));
  const change = latest.overallScore != null && first.overallScore != null && rows.length > 1
    ? latest.overallScore - first.overallScore
    : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <Header count={rows.length} />

      {mixedRubrics && (
        <div className="rounded-md border border-border bg-warning-muted px-4 py-3">
          <p className="text-sm text-fg">
            These rounds were scored under different rubric versions, so the trend is only
            roughly comparable.
          </p>
        </div>
      )}

      {/* ── headline figures ─────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Latest score" value={fmtScore(latest.overallScore)} unit="/100"
              hint={latest.overallVerdict ? VERDICT_LABELS[latest.overallVerdict] : ''}
              color={scoreColor((latest.overallScore ?? 0) / 100)} />
        <Tile label="Best" value={fmtScore(best.overallScore)} unit="/100"
              hint={new Date(best.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} />
        <Tile label="Since your first" value={change == null ? '—' : `${change > 0 ? '+' : ''}${Math.round(change)}`}
              unit={change == null ? '' : ' pts'}
              hint={rows.length > 1 ? `over ${rows.length} rounds` : 'need 2 rounds'}
              color={change == null ? undefined : change > 0 ? 'var(--orvia-color-success)' : change < 0 ? 'var(--orvia-color-danger)' : undefined} />
        <Tile label="Rounds" value={String(rows.length)} unit=""
              hint={`${new Set(rows.map((r) => r.mode)).size} modes`} />
      </section>

      {/* The mentor sits above the charts: charts show WHAT changed, it answers
          what to do about it, which is the actual question. */}
      <CoachPanel
        scope="account"
        title="Ask your mentor"
        blurb="A mentor with every round you have done in front of it — scores, delivery, measured
               metrics, and what keeps recurring. Ask where to focus next, whether you are actually
               improving, or what to practise before a real interview. It can also play back your
               recordings and read past conversations when it needs them."
      />

      {/* Directly under the mentor, because it is what the mentor is working
          from — seeing the two apart makes the notes look like trivia. */}
      <MentorMemory />

      {/* ── score over time ──────────────────────────────────────────────── */}
      <Card title="Overall score" subtitle="Content and delivery weighted together, out of 100.">
        <LineChart title="Overall score" points={series.score} yMin={0} yMax={100} height={170}
                   band={{ from: 70, to: 100, label: 'passing range' }} />
      </Card>

      {/* ── delivery ─────────────────────────────────────────────────────── */}
      <Card title="Communication and presence"
            subtitle={prev ? 'Latest round, with movement against the round before it.' : 'Latest round. A second round will show movement.'}>
        <DimensionBars latest={latest.delivery} previous={prev?.delivery} />
      </Card>

      {/* ── subject matter ───────────────────────────────────────────────── */}
      <Card title="By topic"
            subtitle="Average question score per subject, weakest first. This is where to aim your next round.">
        <TopicBars rows={data.topics ?? []} />
      </Card>

      {/* ── measured metrics, one axis each ──────────────────────────────── */}
      <div>
        <div className="mb-3 px-1">
          <h3 className="text-sm font-semibold text-fg">Measured</h3>
          <p className="mt-1 text-xs text-fg-muted">
            Counted from your recording rather than judged, so these stay comparable even when the
            rubric changes. Each has its own scale.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="Speaking pace" subtitle="Words per minute.">
            <LineChart title="Speaking pace" points={series.wpm} unit=" wpm"
                       band={{ from: 110, to: 180, label: 'conversational' }} />
          </Card>
          <Card title="Filler words" subtitle="Per 100 words. Lower is better.">
            <LineChart title="Filler words" points={series.filler} yMin={0} unit="/100w"
                       color="var(--orvia-color-warning)" format={(v) => v.toFixed(1)} />
          </Card>
          <Card title="Share of talking" subtitle="Your speaking time as a percentage.">
            <LineChart title="Share of talking" points={series.talk} yMin={0} yMax={100} unit="%"
                       band={{ from: 55, to: 85, label: 'healthy' }} />
          </Card>
          <Card title="Pause before answering" subtitle="Median, in seconds.">
            <LineChart title="Pause before answering" points={series.latency} yMin={0} unit="s"
                       color="var(--orvia-color-warning)" format={(v) => v.toFixed(1)} />
          </Card>
        </div>
      </div>

      {/* ── table view: nothing is gated behind a chart ──────────────────── */}
      <Card title="All rounds" subtitle="Every scored round, most recent last.">
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {['Date', 'Mode', 'Score', 'Verdict', 'Pace', 'Filler', 'Talk'].map((h) => (
                  <th key={h} className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.sessionId} className="border-b border-border last:border-0">
                  <td className="px-2 py-2 text-fg-muted">
                    {new Date(r.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-2 py-2 text-fg-muted">{MODE_LABELS[r.mode] ?? r.mode}</td>
                  <td className="px-2 py-2 font-semibold tabular-nums text-fg">{fmtScore(r.overallScore)}</td>
                  <td className="px-2 py-2 text-fg-muted">{r.overallVerdict ? VERDICT_LABELS[r.overallVerdict] : '—'}</td>
                  <td className="px-2 py-2 tabular-nums text-fg-muted">{r.wordsPerMinute ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums text-fg-muted">{r.fillerRate ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums text-fg-muted">
                    {r.talkRatio != null ? `${Math.round(r.talkRatio * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const fmtScore = (v: number | null) => (v == null ? '—' : String(Math.round(v)));

function Header({ count }: { count: number }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Progress</h1>
      <p className="mt-1 text-sm text-fg-muted">
        {count === 0
          ? 'Whether you are actually getting better, not just practising more.'
          : `Across ${count} scored round${count === 1 ? '' : 's'}.`}
      </p>
    </header>
  );
}

function Card({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    /*
     * `min-w-0` allows the grid item to shrink below the initial 560px SVG width
     * before ResizeObserver measures the layout, preventing horizontal overflow
     * on mobile viewports.
     */
    <section className="min-w-0 rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {subtitle && <p className="mt-1 mb-3 text-xs text-fg-muted">{subtitle}</p>}
      {children}
    </section>
  );
}

function Tile({
  label, value, unit, hint, color,
}: { label: string; value: string; unit: string; hint?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: color ?? 'var(--orvia-color-fg)' }}>
        {value}<span className="ml-0.5 text-xs font-normal text-fg-subtle">{unit}</span>
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-fg-subtle">{hint}</p>}
    </div>
  );
}
