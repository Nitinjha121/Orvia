import { lazy, Suspense, useState, type Ref } from 'react';
import type { CodeSnippets, EditorLanguage, SessionReadyPayload } from '@orvia/shared';
import type { TranscriptEntry } from '../lib/transcript';
import type { CodeEditorHandle } from './CodeEditor';
import { mmss } from '../lib/time';
import { diffColor } from '../lib/colors';
import { TranscriptView } from './TranscriptView';

/**
 * Loaded dynamically because CodeMirror and language grammars are large
 * and only needed in modes that display an editor (`MODES_WITH_EDITOR`).
 */
const CodeEditor = lazy(() =>
  import('./CodeEditor').then((m) => ({ default: m.CodeEditor })),
);

/** One question of the round, as the live room needs it. */
export type RoundQuestionView = {
  id: string;
  title: string;
  difficulty: string;
  codeSnippets: CodeSnippets | null;
  /** Paid-only problems only; see `CodeEditor`'s prop of the same name. */
  practiceUrl: string | null;
};

export function LiveRoom({
  transcript, level, aiSpeaking, remainingMs, notice, onStop, ending,
  withEditor, language, onLanguageChange, onPushCode, editorRef, dark,
  questions, questionIndex, onSelectQuestion, practice = {},
  micLost = false, onRetryMic, offline = false,
}: {
  transcript: TranscriptEntry[];
  level: number;
  aiSpeaking: boolean;
  /** Already stall-adjusted by the server; see `displayRemainingMs`. */
  remainingMs: number;
  notice: string | null;
  onStop: () => void;
  ending: boolean;
  withEditor: boolean;
  language: EditorLanguage;
  onLanguageChange: (l: EditorLanguage) => void;
  onPushCode: (code: string, questionId: string | undefined, language: EditorLanguage) => void;
  editorRef?: Ref<CodeEditorHandle>;
  dark: boolean;
  /** The round's questions in the interviewer's order. Empty for non-DSA rounds. */
  questions: RoundQuestionView[];
  /** Which one the round is on, as decided by the server. */
  questionIndex: number;
  onSelectQuestion: (index: number) => void;
  /** What the round is working on, as the server decided it at start. */
  practice?: Pick<SessionReadyPayload, 'focus' | 'drill' | 'loop'>;
  /** The microphone ended and re-opening it once failed. */
  micLost?: boolean;
  /** Resolves true if the microphone is capturing again. */
  onRetryMic?: () => Promise<boolean>;
  offline?: boolean;
}) {
  const current = questions[questionIndex] ?? questions[0];
  const multi = questions.length > 1;

  const voicePane = (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Orb aiSpeaking={aiSpeaking} level={level} micLost={micLost} />
      <TranscriptView entries={transcript} />
    </div>
  );

  return (
    /*
     * Spoken rounds fill the viewport so transcript and clock stay fixed.
     * Editor rounds stack panes vertically below `lg` with page scrolling,
     * switching to side-by-side view on larger screens.
     */
    <div className={
      withEditor
        ? 'flex flex-col gap-4 lg:h-[calc(100dvh-9rem)]'
        : 'flex h-[calc(100dvh-10.5rem)] flex-col gap-4 sm:h-[calc(100dvh-9rem)]'
    }>
      {/* ── status bar ───────────────────────────────────────────────────────
          Sticky while the editor layout scrolls, because the time remaining and
          the way out of the round are the two things that must never scroll
          away mid-answer. */}
      <div className={`flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 ${
        withEditor ? 'sticky top-0 z-10 -mx-4 bg-bg px-4 py-2 sm:-mx-5 sm:px-5 lg:static lg:mx-0 lg:bg-transparent lg:p-0' : ''
      }`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-live" />
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-fg">
            {multi && <span className="text-fg-muted">{questionIndex + 1}/{questions.length} · </span>}
            {current?.title ?? 'Interview in progress'}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3 sm:gap-4">
          <span
            className="font-mono text-sm tabular-nums"
            style={{ color: remainingMs < 120_000 ? 'var(--orvia-color-warning)' : 'var(--orvia-color-fg-muted)' }}
          >
            {mmss(remainingMs)} left
          </span>
          <button
            onClick={onStop}
            disabled={ending}
            className="rounded-md bg-live px-3.5 py-1.5 text-sm font-semibold text-white
                       transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {ending ? 'Wrapping up…' : 'End & get report'}
          </button>
        </div>
      </div>

      {micLost && !ending && <MicLostBanner onRetry={onRetryMic} />}

      {offline && !ending && (
        <div role="status" className="shrink-0 rounded-md border border-border bg-warning-muted px-3 py-2 text-sm text-fg">
          You are offline. If the connection comes back quickly the round carries on; if the link to the
          server drops, the round ends and what was recorded up to then can still be scored.
        </div>
      )}

      <FocusStrip practice={practice} />

      {/* Always mounted, so a screen reader hears each notice as it arrives. */}
      <div role="status" aria-live="polite" className={notice ? 'shrink-0' : 'sr-only'}>
        {notice && (
          <div className="rounded-md border border-border bg-info-muted px-3 py-2 text-sm text-fg">
            {notice}
          </div>
        )}
      </div>

      {/* ── voice on the left, editor on the right; stacked below `lg` ─────── */}
      {withEditor ? (
        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          {/* Viewport-relative heights are used for stacked panes.
              `min-w-0` prevents wide nowrap tab rows from expanding the grid cell
              and forcing horizontal page overflow. */}
          <div className="h-[55dvh] min-h-0 min-w-0 lg:h-auto">{voicePane}</div>
          <div className="flex h-[70dvh] min-h-0 min-w-0 flex-col gap-2 lg:h-full">
            {multi && (
              <QuestionTabs
                questions={questions}
                index={questionIndex}
                onSelect={onSelectQuestion}
              />
            )}
            <Suspense
              fallback={
                <div className="flex h-full min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-surface">
                  <p className="text-sm text-fg-subtle">Loading the editor…</p>
                </div>
              }
            >
              <CodeEditor
                language={language}
                onLanguageChange={onLanguageChange}
                onPush={onPushCode}
                ref={editorRef}
                dark={dark}
                starterCode={current?.codeSnippets ?? null}
                practiceUrl={current?.practiceUrl ?? null}
                questionId={current?.id}
              />
            </Suspense>
          </div>
        </div>
      ) : (
        <div className="mx-auto min-h-0 w-full max-w-3xl flex-1">{voicePane}</div>
      )}
    </div>
  );
}

/**
 * Alerts the user when microphone input is lost during a round.
 */
function MicLostBanner({ onRetry }: { onRetry?: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'trying' | 'failed'>('idle');
  return (
    <div role="alert" className="shrink-0 rounded-md border border-danger bg-danger-muted px-3 py-2">
      <p className="text-sm font-semibold text-fg">Your microphone disconnected — the interviewer cannot hear you.</p>
      <p className="mt-0.5 text-sm text-fg-muted">
        Reconnect it, or pick another input in your system sound settings, then try again. The round is still running.
        {state === 'failed' && ' Still no microphone.'}
      </p>
      {onRetry && (
        <button type="button" disabled={state === 'trying'}
          onClick={() => {
            setState('trying');
            void onRetry().then((ok) => setState(ok ? 'idle' : 'failed'));
          }}
          className="mt-2 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg
                     transition-colors hover:bg-surface-hover disabled:opacity-50">
          {state === 'trying' ? 'Trying…' : 'Try the microphone again'}
        </button>
      )}
    </div>
  );
}

/**
 * Displays the round's questions, advancing automatically with the interviewer.
 * Questions remain clickable so the candidate can manually select the active question
 * if needed, keeping the interviewer aligned.
 */
function QuestionTabs({
  questions, index, onSelect,
}: {
  questions: RoundQuestionView[];
  index: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Round questions"
      className="flex shrink-0 gap-1.5 overflow-x-auto pb-0.5"
    >
      {questions.map((q, i) => {
        const active = i === index;
        return (
          <button
            key={q.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(i)}
            title={q.title}
            className={`flex min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1
                        text-xs transition-colors ${
                          active
                            ? 'border-brand bg-brand-muted font-semibold text-fg'
                            : 'border-border bg-surface text-fg-muted hover:text-fg'
                        }`}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: diffColor(q.difficulty) }}
            />
            <span className="tabular-nums">{i + 1}.</span>
            {/* Titles truncate at 37% of rail width, which is why the number
                always shows and the title is what gets clipped — harder still
                on a phone, so the clip is tighter there rather than the row
                growing wide enough to need two scrolls. */}
            <span className="max-w-[7rem] truncate sm:max-w-[11rem]">{q.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Displays the active practice focus areas for this round.
 * Collapsible to conserve vertical space on smaller screens.
 */
function FocusStrip({ practice }: { practice: Pick<SessionReadyPayload, 'focus' | 'drill' | 'loop'> }) {
  const [open, setOpen] = useState(true);
  const items = practice.focus ?? [];
  const { drill, loop } = practice;
  if (!items.length && !drill && !loop) return null;

  const heading = drill
    ? `Drill · ${drill.label}`
    : loop
      ? `Onsite loop · round ${loop.stage + 1} of ${loop.of}`
      : 'Working on';

  return (
    <section aria-label="What this round is working on"
             className="shrink-0 rounded-md border border-border bg-brand-muted px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {heading}
          {drill && (
            <span className="ml-2 font-normal normal-case tracking-normal text-fg-subtle">
              last time {drill.beforeScore}/{drill.outOf}
            </span>
          )}
        </p>
        {items.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
                  className="shrink-0 text-xs font-medium text-brand hover:underline">
            {open ? 'Hide' : `Show ${items.length}`}
          </button>
        )}
      </div>
      {open && items.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {items.map((f) => (
            <li key={f.key} className="flex gap-2 text-sm leading-snug text-fg">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
              <span className="min-w-0">{f.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One indicator carrying both directions of the conversation: it pulses with
 * the interviewer's voice and swells with your microphone level. With no video,
 * this is the only cue that the loop is alive.
 */
function Orb({ aiSpeaking, level, micLost }: { aiSpeaking: boolean; level: number; micLost: boolean }) {
  const scale = 1 + Math.min(level, 1) * 0.3;
  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-3 py-2">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full transition-[transform,box-shadow] duration-100 sm:h-20 sm:w-20"
        style={{
          transform: `scale(${aiSpeaking ? 1.08 : scale})`,
          background: aiSpeaking ? 'var(--orvia-color-brand)' : 'var(--orvia-color-surface-alt)',
          boxShadow: aiSpeaking ? 'var(--orvia-shadow-md)' : 'none',
          border: `1px solid var(--orvia-color-${aiSpeaking ? 'brand' : 'border-strong'})`,
        }}
      >
        <MicIcon className={aiSpeaking ? 'text-brand-fg' : 'text-fg-muted'} />
      </div>
      <p className="text-xs uppercase tracking-widest text-fg-subtle">
        {aiSpeaking ? 'Interviewer speaking' : micLost ? 'Microphone disconnected' : 'Listening'}
      </p>
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
         strokeLinecap="round" strokeLinejoin="round" className={`h-7 w-7 ${className ?? ''}`}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </svg>
  );
}
