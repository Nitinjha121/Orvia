import { useState } from 'react';
import {
  DELIVERY_DIMENSIONS, VERDICT_LABELS, MODE_LABELS,
  QUESTION_OUTCOME_LABELS, RETIRING_OUTCOMES,
  type EvaluationView, type Verdict, type DeliveryScore, type SpeechMetrics,
  type ComplexityAxis, type QuestionOutcomeKind,
  type SessionMeta, type InterviewMode,
} from '@orvia/shared';
import { CoachPanel } from './CoachPanel';
import { DrillComparison, FocusResults, MomentsPanel, TopFixes } from './PracticePanels';
import { RecordingProvider, PlayFrom, RecordingBar } from './RecordingPlayer';
import { SayItBetter } from './SayItBetter';
import { diffColor, scoreColor } from '../lib/colors';
import { sameComplexity, splitComplexity } from '../lib/complexity';

const VERDICT_STYLE: Record<Verdict, { color: string; bg: string }> = {
  strong_pass: { color: 'var(--orvia-color-success)', bg: 'var(--orvia-color-success-muted)' },
  pass:        { color: 'var(--orvia-color-success)', bg: 'var(--orvia-color-success-muted)' },
  borderline:  { color: 'var(--orvia-color-warning)', bg: 'var(--orvia-color-warning-muted)' },
  fail:        { color: 'var(--orvia-color-danger)',  bg: 'var(--orvia-color-danger-muted)' },
};

/**
 * Maximum duration a report can remain pending before offering a re-run option.
 * If generation stalls in a non-terminal state, this elapsed time fallback
 * allows retrying without cancelling ongoing background work.
 */
const SLOW_REPORT_MS = 12 * 60_000;

export function ReportCard({ report, onRetry }: { report: EvaluationView; onRetry?: () => void }) {
  if (report.status === 'failed') {
    return (
      <div className="rounded-lg border border-danger bg-danger-muted p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-fg">Evaluation failed</h3>
        <p className="mt-1.5 text-sm text-fg-muted">{report.error}</p>
        {onRetry && (
          <button onClick={onRetry}
            className="mt-4 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90">
            Try again
          </button>
        )}
      </div>
    );
  }

  if (report.status !== 'complete') {
    /**
     * Treats invalid or missing creation timestamps as elapsed so the re-run
     * fallback remains accessible.
     */
    const startedAt = new Date(report.createdAt).getTime();
    const slow = !Number.isFinite(startedAt) || Date.now() - startedAt > SLOW_REPORT_MS;

    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
          <p className="text-sm text-fg">
            {report.status === 'transcribing' ? 'Re-transcribing your audio…' : 'Writing your report…'}
          </p>
        </div>
        <p className="mt-2 text-xs text-fg-subtle">
          The evaluator is listening to the whole recording, so this takes a minute or two.
        </p>
        {slow && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs text-fg-muted">
              This is taking longer than usual. It may still finish on its own — re-running
              starts the transcription again from the beginning.
            </p>
            {onRetry && (
              <button onClick={onRetry}
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-hover">
                Run it again
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <RecordingProvider sessionId={report.sessionId}>
    <div className="space-y-6">
      <Overview report={report} />
      {report.degraded?.verbatim && (
        <div className="rounded-lg border border-border bg-warning-muted p-4">
          <p className="text-sm text-fg">
            <strong className="font-semibold">Quotes come from the live transcript.</strong>{' '}
            The more accurate re-transcription was not used because {report.degraded.verbatim}.
            Filler counts and quoted words may be less exact.
          </p>
          {onRetry && (
            <>
              <p className="mt-1.5 text-xs text-fg-muted">
                If that was a network drop, re-running transcribes the whole recording again
                and writes a new report from it.
              </p>
              <RerunButton onRetry={onRetry} primary />
            </>
          )}
        </div>
      )}
      {report.drill && <DrillComparison drill={report.drill} />}
      <FocusResults focus={report.focus ?? []} isDrill={!!report.drill} />
      {report.assignedQuestions.length > 0 && (
        <SolvedTable rows={report.assignedQuestions} />
      )}
      {report.topFixes?.length ? <TopFixes fixes={report.topFixes} sessionId={report.sessionId} /> : null}
      {!report.drill && <MomentsPanel sessionId={report.sessionId} />}

      {/* The coach sits high: reading feedback changes less than rehearsing it. */}
      <CoachPanel sessionId={report.sessionId} />

      {report.metrics && <MetricsStrip m={report.metrics} />}
      {report.delivery.length > 0 && <Delivery scores={report.delivery} />}
      <SayItBetter sessionId={report.sessionId} />
      <CodeComparison
        yourCode={report.session?.finalCode ?? null}
        codeLanguage={report.session?.codeLanguage ?? null}
        questionCode={report.session?.questionCode ?? null}
        solutions={report.questions.filter((q) => q.modelSolution)}
        problems={report.session?.problems ?? []}
      />
      {report.questions.length > 0 && <Questions questions={report.questions} />}
      {report.session && <SessionDetails s={report.session} />}

      {!report.audioAnalysed && (
        <div className="rounded-lg border border-border bg-warning-muted p-4">
          <p className="text-sm text-fg">
            <strong className="font-semibold">This report did not hear your voice.</strong>{' '}
            {report.degraded?.audio
              ? `It was written from the transcript because ${report.degraded.audio}, so tone, hesitation and vocal confidence could not be assessed.`
              : 'It was written from the transcript, so tone, hesitation and vocal confidence could not be assessed.'}
          </p>
          <p className="mt-1.5 text-xs text-fg-muted">
            The measured numbers above and the question-by-question feedback are unaffected.
            {report.transcriptSource
              ? ` Your audio was re-transcribed with ${report.transcriptSource} for accuracy.`
              : ''}
          </p>
        </div>
      )}

      <p className="text-center text-xs text-fg-subtle">
        Scored by {report.provider}/{report.model} against rubric {report.rubricVersion}
        {report.audioAnalysed ? ', listening to your recording' : ', from the transcript only'}.
        Only scores from the same rubric version are comparable.
      </p>
      {onRetry && !report.degraded?.verbatim && (
        <div className="text-center">
          <RerunButton onRetry={onRetry} />
        </div>
      )}
    </div>
    </RecordingProvider>
  );
}

/**
 * Re-running replaces what is on screen until the new report lands, and a
 * failed re-run falls back to this one (`pickShownEvaluation`), so it asks once
 * before throwing away minutes of upstream work.
 */
function RerunButton({ onRetry, primary }: { onRetry: () => void; primary?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const base = 'mt-3 rounded-md px-3 py-1.5 text-xs font-semibold';
  const style = primary
    ? `${base} bg-brand text-brand-fg hover:opacity-90`
    : `${base} border border-border text-fg hover:bg-surface-hover`;
  if (!confirming) {
    return <button onClick={() => setConfirming(true)} className={style}>Re-run this report</button>;
  }
  return (
    <div className="mt-3 inline-flex flex-wrap items-center justify-center gap-2">
      <span className="text-xs text-fg-muted">
        Re-transcribes the whole recording — several minutes. If it fails, this report stays.
      </span>
      <button onClick={onRetry} className={style.replace('mt-3 ', '')}>Start re-run</button>
      <button onClick={() => setConfirming(false)}
        className="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-hover">Cancel</button>
    </div>
  );
}

/** A null score or verdict is shown as absent, never as a zero or a "borderline". */
function Overview({ report }: { report: EvaluationView }) {
  const score = report.overallScore;
  const verdict = report.overallVerdict;

  return (
    <section className="rounded-lg border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 sm:gap-5">
        <div className="flex items-center gap-4 sm:gap-5">
          <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full border-2"
               style={{ borderColor: score != null ? scoreColor(score / 100) : 'var(--orvia-color-border-strong)' }}>
            <span className="text-2xl font-semibold tabular-nums text-fg">{score != null ? Math.round(score) : '—'}</span>
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">/ 100</span>
          </div>
          <div>
            {verdict && (
              <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: VERDICT_STYLE[verdict].color, background: VERDICT_STYLE[verdict].bg }}>
                {VERDICT_LABELS[verdict]}
              </span>
            )}
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-fg">Report card</h2>
          </div>
        </div>
      </div>

      {report.summary && (
        <p className="mt-5 text-sm leading-relaxed text-fg">{report.summary}</p>
      )}
      <div className="mt-4"><RecordingBar /></div>
    </section>
  );
}

/**
 * The measured numbers, kept visually distinct from the scored dimensions —
 * these are counted, not judged, and that difference matters when deciding
 * how much to trust a given line of the report.
 */
function MetricsStrip({ m }: { m: SpeechMetrics }) {
  const items = [
    { label: 'Pace', value: m.wordsPerMinute != null ? `${m.wordsPerMinute}` : '—', unit: 'wpm',
      hint: m.wordsPerMinute == null ? 'not measured'
        : m.wordsPerMinute < 110 ? 'slow' : m.wordsPerMinute > 180 ? 'fast' : 'normal' },
    { label: 'Filler words', value: `${m.fillerRate}`, unit: 'per 100 words',
      hint: `${m.fillerCount} total` },
    { label: 'You spoke', value: m.talkRatio != null ? `${Math.round(m.talkRatio * 100)}` : '—', unit: '%',
      hint: m.talkRatio == null ? 'not measured'
        : m.talkRatio < 0.5 ? 'too little' : m.talkRatio > 0.85 ? 'dominated' : 'healthy' },
    { label: 'Pause before answering', value: m.medianResponseLatencyMs != null
        ? (m.medianResponseLatencyMs / 1000).toFixed(1) : '—', unit: 's', hint: 'median' },
    { label: 'Answer length', value: `${m.meanTurnWords}`, unit: 'words', hint: 'mean' },
  ];

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-fg">Measured</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Counted from the transcript and timings, not judged. These are the numbers to watch over time.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((it) => (
          <div key={it.label}>
            <p className="text-xs text-fg-muted">{it.label}</p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums text-fg">
              {it.value}<span className="ml-1 text-xs font-normal text-fg-subtle">{it.unit}</span>
            </p>
            <p className="text-[11px] text-fg-subtle">{it.hint}</p>
          </div>
        ))}
      </div>
      {Object.keys(m.fillerBreakdown).length > 0 && (
        <p className="mt-4 border-t border-border pt-3 text-xs text-fg-muted">
          {Object.entries(m.fillerBreakdown)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `“${k}” ×${v}`)
            .join(' · ')}
        </p>
      )}
    </section>
  );
}

function Delivery({ scores }: { scores: DeliveryScore[] }) {
  const byId = new Map(scores.map((s) => [s.dimension, s]));

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-fg">Communication and presence</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Each score is backed by something you actually said. Higher is always better.
      </p>

      <div className="mt-4 space-y-3">
        {DELIVERY_DIMENSIONS.map((dim) => {
          const s = byId.get(dim.id);
          if (!s) return null;
          return (
            <div key={dim.id} className="rounded-md border border-border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-fg">{dim.label}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums"
                      style={{ color: scoreColor(s.score / 5) }}>
                  {s.score}<span className="text-xs font-normal text-fg-subtle">/5</span>
                </span>
              </div>

              <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-alt">
                <div className="h-full rounded-full transition-[width]"
                     style={{ width: `${(s.score / 5) * 100}%`, background: scoreColor(s.score / 5) }} />
              </div>

              <p className="mt-2.5 text-sm leading-relaxed text-fg-muted">{s.assessment}</p>

              {s.evidenceQuote && (
                <div className="mt-2.5 flex items-start gap-2">
                  <blockquote className="min-w-0 flex-1 border-l-2 pl-3 text-xs italic leading-relaxed text-fg-subtle"
                              style={{ borderColor: 'var(--orvia-color-border-strong)' }}>
                    “{s.evidenceQuote}”
                  </blockquote>
                  <PlayFrom atMs={s.evidenceAtMs} label="Hear it" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Everything about how the round was configured, so history is self-describing. */
function SessionDetails({ s }: { s: SessionMeta }) {
  const actualMin = s.actualMs != null ? (s.actualMs / 60000).toFixed(1) : null;
  const rows: [string, string][] = [
    ['Mode', MODE_LABELS[s.mode as InterviewMode] ?? s.mode],
    ['Date', new Date(s.startedAt).toLocaleString()],
    ['Length', s.plannedMinutes != null
      ? `${s.plannedMinutes} min planned${actualMin ? ` · ${actualMin} min used` : ''}`
      : actualMin ? `${actualMin} min` : '—'],
    ['Bar', s.difficulty ?? '—'],
    ['Manner', s.persona ?? '—'],
    ['Interviewer voice', s.voice],
    ['Interviewer model', s.interviewerModel],
    ...(s.codeLanguage ? ([['Language', s.codeLanguage]] as [string, string][]) : []),
  ];

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-fg">Round details</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
            <dt className="text-xs text-fg-muted">{k}</dt>
            <dd className="text-right text-xs font-medium capitalize text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Your code next to a working one.
 *
 * Deliberately a top-level section rather than something inside the per-question
 * accordion: for a coding round this comparison is the single most useful thing
 * on the page, and burying it behind a disclosure triangle means it goes unread.
 */
function CodeComparison({
  yourCode, codeLanguage, questionCode, solutions, problems,
}: {
  yourCode: string | null;
  codeLanguage: string | null;
  /** Per-question buffers. Null for rounds recorded before these were kept. */
  questionCode: Record<string, { code?: string; language?: string | null }> | null;
  problems: { id: string; title: string; url: string | null }[];
  solutions: EvaluationView['questions'];
}) {
  /**
   * Pairs user code with corresponding model solutions by position when counts match.
   * Falls back to the flat layout if counts diverge.
   */
  const perQuestion =
    questionCode && problems.length > 1 && solutions.length === problems.length
      ? problems.map((p, i) => ({
          id: p.id,
          title: p.title,
          url: p.url,
          yours: questionCode[p.id]?.code ?? null,
          yoursLang: questionCode[p.id]?.language ?? codeLanguage,
          solution: solutions[i]!,
        }))
      : null;

  const hasYours = !!yourCode?.trim();
  if (!hasYours && solutions.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">Your code, and a working solution</h3>

        {/* The editor starts from the problem's real skeleton, so what is above
            runs as-is where the problem lives — copy it and open it there. On a
            multi-question round each link sits beside its own problem instead. */}
        {!perQuestion && (
          <div className="flex flex-wrap items-center gap-2">
            {problems.map((p) => <ProblemLink key={p.id} title={p.title} url={p.url} />)}
          </div>
        )}
      </div>
      <p className="mt-1 mb-4 text-xs text-fg-muted">
        {hasYours
          ? 'What you had written when the round ended, beside an implementation that solves it.'
          : 'You did not write any code this round. Here is what a solution looks like.'}
      </p>

      {perQuestion ? (
        <div className="space-y-6">
          {perQuestion.map((q, i) => (
            <div key={q.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h4 className="text-xs font-semibold text-fg">
                  {i + 1}. {q.title}
                </h4>
                <ProblemLink title={q.title} url={q.url} bare />
              </div>
              <ComplexityTable axes={q.solution.complexity ?? []} />
              <div className="grid gap-4 lg:grid-cols-2">
                {q.yours?.trim() ? (
                  <CodeBlock
                    title={`What you wrote${q.yoursLang ? ` (${q.yoursLang})` : ''}`}
                    code={q.yours}
                  />
                ) : (
                  <p className="self-start rounded-md border border-border bg-surface-alt px-3 py-2 text-xs text-fg-muted">
                    You did not write code for this question.
                  </p>
                )}
                <CodeBlock
                  title={`A working solution${
                    q.solution.modelSolutionLanguage ? ` (${q.solution.modelSolutionLanguage})` : ''
                  }`}
                  code={q.solution.modelSolution!}
                  accent
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <ComplexityTable axes={solutions.flatMap((q) => q.complexity ?? [])} />

          <div className="grid gap-4 lg:grid-cols-2">
            {hasYours && (
              <CodeBlock title={`What you wrote${codeLanguage ? ` (${codeLanguage})` : ''}`} code={yourCode!} />
            )}
            {solutions.map((q) => (
              <CodeBlock
                key={q.id}
                title={`A working solution${q.modelSolutionLanguage ? ` (${q.modelSolutionLanguage})` : ''}`}
                code={q.modelSolution!}
                accent
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const AXIS_LABEL: Record<string, string> = {
  time: 'Time',
  space: 'Space',
  output: 'Output size',
};

/** `bare` drops the title from the label, for when it already sits beside one. */
function ProblemLink({ title, url, bare }: { title: string; url: string | null; bare?: boolean }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${title}`}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1
                 text-[11px] font-medium text-fg-muted transition-colors
                 hover:bg-surface-hover hover:text-fg"
    >
      <span>{bare ? 'Open' : `Open ${title}`}</span>
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden fill="none"
           stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 2.5H9.5V7.5" />
        <path d="M9.5 2.5L3 9" />
      </svg>
    </a>
  );
}

/**
 * Compares claimed complexity, actual code complexity, and optimal solution complexity.
 * Correctness is judged against the candidate's actual implementation rather than the optimal.
 */
function ComplexityTable({ axes }: { axes: ComplexityAxis[] }) {
  // Nothing discussed and nothing to compare: show no table rather than blanks.
  if (axes.length === 0) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border">
      <div className="border-b border-border bg-surface-alt px-3 py-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Complexity</h4>
      </div>

      {/* Wide content scrolls inside its own box; the page never scrolls sideways.
          Fixed layout so a long gloss wraps in its own column instead of
          pushing Optimal off the edge. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-28" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-fg-subtle">
              <th className="px-3 py-2 font-medium">Axis</th>
              <th className="px-3 py-2 font-medium">You said</th>
              <th className="px-3 py-2 font-medium">Your code</th>
              <th className="px-3 py-2 font-medium">Optimal</th>
            </tr>
          </thead>
          <tbody>
            {axes.map((a, i) => (
              <tr key={`${a.axis}-${i}`} className="border-b border-border last:border-0 align-top">
                <td className="px-3 py-2 text-fg-muted">{AXIS_LABEL[a.axis] ?? a.axis}</td>

                <td className="px-3 py-2">
                  {a.stated ? (
                    <div className="space-y-1">
                      <Figure value={a.stated} />
                      {a.statedQuote && (
                        <div className="flex items-start gap-1.5">
                          <span className="min-w-0 text-[11px] leading-snug text-fg-subtle">
                            &ldquo;{a.statedQuote}&rdquo;
                          </span>
                          <PlayFrom atMs={a.statedAtMs} />
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Never a guess: a blank here is the finding. */
                    <span className="text-[11px] italic text-fg-subtle">not stated</span>
                  )}
                </td>

                <td className="px-3 py-2">
                  <Figure value={a.actual} mark={<Mark correct={a.correct} />} />
                </td>

                <td className="px-3 py-2">
                  <Figure value={a.optimal} muted />
                  {/* Two strings cannot say which is slower, only that they differ;
                      and output size is fixed by the problem, not by your code. */}
                  {a.axis !== 'output' && !sameComplexity(a.actual, a.optimal) && (
                    <p className="mt-1 text-[11px] text-fg-subtle">differs from yours</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The bound in mono, and the evaluator's gloss on it ("where S is amount") as prose under it. */
function Figure({ value, muted, mark }: { value: string; muted?: boolean; mark?: React.ReactNode }) {
  const { head, rest } = splitComplexity(value);
  return (
    <div>
      <code className={`break-words font-mono text-[13px] ${muted ? 'text-fg-muted' : 'text-fg'}`}>
        {head}
      </code>
      {mark && <span className="ml-1.5">{mark}</span>}
      {rest && <p className="mt-0.5 break-words text-[11px] leading-snug text-fg-subtle">{rest}</p>}
    </div>
  );
}

/**
 * Tick, cross, or nothing. A glyph AND a colour, never colour alone — the
 * success/danger pair is validated for colour-blind separation, but a reader
 * should not have to rely on it to read a verdict.
 */
function Mark({ correct }: { correct: boolean | null }) {
  if (correct === null) return null;
  return (
    <span
      aria-label={correct ? 'matches what you said' : 'does not match what you said'}
      title={correct ? 'Matches what you said' : 'Does not match what you said'}
      className="text-xs font-semibold"
      style={{ color: correct ? 'var(--orvia-color-success)' : 'var(--orvia-color-danger)' }}
    >
      {correct ? '\u2713' : '\u2717'}
    </span>
  );
}

const OUTCOME_STYLE: Record<QuestionOutcomeKind, { color: string; bg: string; glyph: string }> = {
  solved:      { color: 'var(--orvia-color-success)', bg: 'var(--orvia-color-success-muted)', glyph: '✓' },
  partial:     { color: 'var(--orvia-color-warning)', bg: 'var(--orvia-color-warning-muted)', glyph: '~' },
  unsolved:    { color: 'var(--orvia-color-danger)',  bg: 'var(--orvia-color-danger-muted)',  glyph: '✗' },
  not_reached: { color: 'var(--orvia-color-fg-subtle)', bg: 'var(--orvia-color-surface-alt)',  glyph: '–' },
};

/**
 * Did you solve the problems you were given? By title, separate from the
 * question-by-question breakdown, which follows the CONVERSATION rather than
 * the problems. This row decides whether a problem is offered again, which is
 * why the evidence quote sits beside it: a verdict that removes a question from
 * your rotation has to be arguable with.
 */
function SolvedTable({ rows }: { rows: EvaluationView['assignedQuestions'] }) {
  const retired = rows.filter((r) => RETIRING_OUTCOMES.includes(r.outcome));
  const returning = rows.filter(
    (r) => r.outcome !== 'not_reached' && !RETIRING_OUTCOMES.includes(r.outcome),
  );

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Did you solve it?</h3>
        <p className="text-xs text-fg-subtle">
          {retired.length} of {rows.length} solved
          {returning.length > 0 && ` · ${returning.length} back in your rotation`}
        </p>
      </div>

      <ul className="mt-3 space-y-2">
        {rows.map((r) => {
          const style = OUTCOME_STYLE[r.outcome];
          return (
            <li key={r.questionId} className="rounded-md border border-border bg-surface-alt p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                                 text-[11px] font-bold"
                      style={{ color: style.color, background: style.bg }}
                      aria-hidden>
                  {style.glyph}
                </span>
                {/* Title from the question bank, never from the evaluator. */}
                <span className="min-w-0 flex-1 text-sm font-medium text-fg">
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {r.title}
                    </a>
                  ) : r.title}
                  {r.difficulty && (
                    <span className="ml-2 text-[11px] font-normal"
                          style={{ color: diffColor(r.difficulty) }}>
                      {r.difficulty}
                    </span>
                  )}
                </span>
                {/* Label as well as colour: the whole point is the difference
                    between solved and come-back-to-this, and a red/green pair
                    alone does not carry that. */}
                <span className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold"
                      style={{ color: style.color, background: style.bg }}>
                  {QUESTION_OUTCOME_LABELS[r.outcome]}
                </span>
              </div>

              <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{r.reason}</p>
              {r.evidenceQuote && (
                <p className="mt-1.5 border-l-2 border-border pl-2.5 text-xs italic text-fg-subtle">
                  “{r.evidenceQuote}”
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {returning.length > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-fg-subtle">
          A question you did not solve stays in the “Surprise me” rotation, so it will be
          offered to you again. Turn that off in Rules on the setup page.
        </p>
      )}
    </section>
  );
}

function Questions({ questions }: { questions: EvaluationView['questions'] }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="space-y-2">
      <div className="px-1">
        <h3 className="text-sm font-semibold text-fg">Question by question</h3>
        <p className="mt-1 text-xs text-fg-muted">
          What you said, what a strong answer looks like, and how to close the gap.
        </p>
      </div>

      {questions.map((q, i) => {
        const isOpen = open === i;
        const style = VERDICT_STYLE[q.verdict];
        return (
          <div key={q.id} className="overflow-hidden rounded-lg border border-border bg-surface">
            {/* The play control is a SIBLING of the toggle, not a child of it:
                a button inside a button is invalid HTML and React warns on it. */}
            <div className="flex items-center gap-1 pr-2 transition-colors hover:bg-surface-hover sm:pr-3">
              <button onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}
                aria-controls={`q-${q.id}`}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left sm:gap-3 sm:px-4">
                <span className="shrink-0 text-sm font-semibold tabular-nums"
                      style={{ color: scoreColor(q.score / 10) }}>
                  {q.score}<span className="text-xs font-normal text-fg-subtle">/10</span>
                </span>
                {/* A single truncated line leaves about seventy pixels of
                    question at phone width, which is not enough to tell two
                    rows apart. Two wrapped lines are, and the row still does
                    not grow unbounded. */}
                <span className="line-clamp-2 min-w-0 flex-1 text-sm text-fg sm:truncate">{q.question}</span>
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                      style={{ color: style.color, background: style.bg }}>
                  {VERDICT_LABELS[q.verdict]}
                </span>
              </button>
              <PlayFrom atMs={q.startMs} />
              <button onClick={() => setOpen(isOpen ? null : i)}
                      aria-expanded={isOpen} aria-controls={`q-${q.id}`}
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                      className="shrink-0 px-1 text-fg-subtle">{isOpen ? '−' : '+'}</button>
            </div>

            {isOpen && (
              <div id={`q-${q.id}`} className="space-y-4 border-t border-border px-4 py-4">
                <Block title="The question" tone="muted">{q.question}</Block>
                <Block title="What you said" tone="muted">{q.myAnswer}</Block>
                <Block title="What a strong answer looks like" tone="brand">{q.idealAnswer}</Block>

                {q.whatWasGood.length > 0 && (
                  <BulletBlock title="What worked" items={q.whatWasGood} color="var(--orvia-color-success)" />
                )}
                {q.whatWasMissing.length > 0 && (
                  <BulletBlock title="What was missing" items={q.whatWasMissing} color="var(--orvia-color-danger)" />
                )}

                <Block title="How to improve it" tone="warning">{q.howToImprove}</Block>

              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function CodeBlock({ title, code, accent }: { title: string; code: string; accent?: boolean }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code.trim());
      setCopied('yes');
    } catch {
      // Denied permission or an insecure context: say so rather than pretend.
      setCopied('failed');
    }
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</h4>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied === 'yes' ? 'Copied code' : copied === 'failed' ? 'Copy failed' : 'Copy code'}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          {copied === 'failed' ? (
            <span className="text-danger">Copy failed — select the code instead</span>
          ) : copied ? (
            <>
              <svg viewBox="0 0 12 12" className="h-3 w-3 text-success" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2.5 6.5 4.5 8.5 9.5 3.5" />
              </svg>
              <span className="text-success">Copied</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="6" height="6" rx="1" />
                <path d="M2.5 8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v0.5" />
              </svg>
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* Scrolls inside its own box; the page must never scroll sideways. */}
      <pre className="overflow-x-auto rounded-md p-3 text-xs leading-relaxed"
           style={{
             background: accent ? 'var(--orvia-color-brand-muted)' : 'var(--orvia-color-surface-alt)',
             fontFamily: 'var(--orvia-font-mono)',
           }}>
        <code className="text-fg">{code.trim()}</code>
      </pre>
    </div>
  );
}

function Block({
  title, children, tone,
}: { title: string; children: React.ReactNode; tone: 'muted' | 'brand' | 'warning' }) {
  const bg = tone === 'brand' ? 'var(--orvia-color-brand-muted)'
    : tone === 'warning' ? 'var(--orvia-color-warning-muted)'
    : 'var(--orvia-color-surface-alt)';
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</h4>
      <p className="rounded-md p-3 text-sm leading-relaxed text-fg" style={{ background: bg }}>
        {children}
      </p>
    </div>
  );
}

function BulletBlock({ title, items, color }: { title: string; items: string[]; color: string }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</h4>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-fg">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
