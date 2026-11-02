import { useEffect, useRef } from 'react';
import { useCoach } from '../hooks/useCoach';
import { mmss } from '../lib/time';
import { speakerColor } from '../lib/colors';

/**
 * Talk to a coach about the round you just finished.
 *
 * The report tells you what was wrong; this rehearses the fix with you. It has
 * heard the actual recording, so it can react to how you sounded rather than
 * only to what you said.
 */
export function CoachPanel({
  sessionId, scope = 'session', title, blurb,
}: {
  sessionId?: string;
  scope?: 'session' | 'account';
  title?: string;
  blurb?: string;
}) {
  const coach = useCoach(sessionId ?? null, scope);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [coach.lines]);

  // 'ended' belongs here too: after hanging up you should be able to start
  // another round of coaching, not be left staring at a dead panel.
  if (coach.phase === 'idle' || coach.phase === 'error' || coach.phase === 'ended') {
    return (
      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-lg">
            <h3 className="text-sm font-semibold text-fg">
              {title ?? 'Talk it through with a coach'}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
              {blurb ??
                'A coach that has listened to this recording. Ask it how to structure an answer out loud, how to ask a clarifying question, or how to say your approach without rambling — then try the answer again and get reacted to.'}
            </p>
          </div>
          <button
            onClick={() => void coach.start()}
            className="w-full shrink-0 rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg
                       transition-opacity hover:opacity-90 sm:w-auto"
          >
            {coach.phase === 'ended'
              ? 'Start again'
              : scope === 'account'
                ? 'Ask your mentor'
                : 'Start coaching'}
          </button>
        </div>
        {coach.phase === 'ended' && coach.elapsedMs > 0 && (
          <p className="mt-3 text-xs text-fg-subtle">
            That conversation ran{' '}
            <span className="font-mono tabular-nums text-fg-muted">{mmss(coach.elapsedMs)}</span>.
          </p>
        )}
        {coach.error && (
          <p className="mt-3 rounded-md border border-danger bg-danger-muted px-3 py-2 text-sm text-fg">
            {coach.error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2.5">
          {/* No pulse while paused — a live-looking indicator next to "Paused"
              is exactly the ambiguity that makes people wonder if it can hear. */}
          <span className="relative flex h-2.5 w-2.5">
            {!coach.paused && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
            )}
            <span
              className="relative inline-flex h-2.5 w-2.5 rounded-full"
              style={{ background: coach.paused ? 'var(--orvia-color-fg-subtle)' : 'var(--orvia-color-brand)' }}
            />
          </span>
          <span className="text-sm font-medium text-fg">
            {coach.phase === 'connecting'
              ? scope === 'account'
                ? 'Reading your history…'
                : 'Listening back to your recording…'
              : coach.paused
                ? 'Paused'
                : coach.speaking
                  ? scope === 'account' ? 'Mentor speaking' : 'Coach speaking'
                  : 'Listening'}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/*
            Elapsed time. Counts only while live and unpaused — see `useCoach`.
            A mentor conversation has no time limit, so this counts UP; the
            interview's clock counts down because that one does.
          */}
          <span
            className="font-mono text-sm tabular-nums text-fg-muted"
            title={coach.paused ? 'Paused — the clock is stopped' : 'Time in this conversation'}
            aria-label={`Time in this conversation: ${mmss(coach.elapsedMs)}`}
          >
            {mmss(coach.elapsedMs)}
          </span>
          {/* Mic level, so it is obvious the coach can hear you. */}
          <div className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-alt sm:w-16">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-100"
              style={{ width: `${Math.min(100, coach.level * 160)}%` }}
            />
          </div>
          <button
            onClick={coach.togglePause}
            aria-pressed={coach.paused}
            disabled={coach.phase !== 'live'}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg
                       transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {coach.paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={() => void coach.stop()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg
                       transition-colors hover:bg-surface-hover"
          >
            End
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        className="max-h-72 min-h-32 space-y-3 overflow-y-auto rounded-md border border-border bg-surface-alt p-4"
      >
        {coach.lines.length === 0 && (
          <p className="text-sm text-fg-subtle">
            {coach.phase === 'connecting'
              ? scope === 'account'
                ? 'Give it a moment — it is reading every round you have done.'
                : 'Give it a moment — it is listening to the whole recording first.'
              : 'Say hello when you are ready.'}
          </p>
        )}
        {coach.lines.map((l) => (
          <div key={l.id}>
            <span
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: speakerColor(l.speaker) }}
            >
              {l.speaker === 'ai' ? (scope === 'account' ? 'Mentor' : 'Coach') : 'You'}
            </span>
            <p className={`mt-0.5 text-sm leading-relaxed ${l.final ? 'text-fg' : 'italic text-fg-muted'}`}>
              {l.text}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-2.5 text-xs text-fg-subtle">
        {coach.paused
          ? `Paused — your microphone is off. Everything said so far is kept, so resuming carries straight on${
              scope === 'account' ? '.' : ' — it still has the recording.'
            }`
          : 'Nothing here is recorded or scored. Practise as much as you want.'}
      </p>
    </section>
  );
}
