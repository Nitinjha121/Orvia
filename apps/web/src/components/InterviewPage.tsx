import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  MODES_WITH_EDITOR, type EditorLanguage, type InterviewMode, type StartSessionInput,
} from '@orvia/shared';
import { ApiError, api, type DrillPlan, type DsaQuestion, type Profile, type ReplayPlan } from '../lib/api';
import type { ReplayNavState } from '../lib/replay';
import type { FeedPracticeNavState } from '../lib/feedPractice';
import type { DrillNavState } from '../lib/drill';
import type { LoopNavState } from '../lib/loop';
import { useInterview } from '../hooks/useInterview';
import { useApi } from '../hooks/useApi';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { SetupPanel } from './SetupPanel';
import { LiveRoom } from './LiveRoom';
import { EndScreen } from './EndScreen';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorNote } from './ui/ErrorNote';
import type { CodeEditorHandle } from './CodeEditor';

export function InterviewPage() {
  const iv = useInterview();
  const profileReq = useApi<Profile>('/api/profile');
  const profile = profileReq.data;
  const [language, setLanguage] = useState<EditorLanguage>('python');
  const [roundMode, setRoundMode] = useState<InterviewMode | null>(null);
  const withEditor = roundMode !== null && MODES_WITH_EDITOR.includes(roundMode);
  const editor = useRef<CodeEditorHandle>(null);
  /**
   * The questions picked at setup, held only for each one's starter skeleton;
   * the ORDER and the CURRENT question come from the server
   * (`iv.questions`, `iv.questionIndex`).
   */
  const [chosen, setChosen] = useState<DsaQuestion[]>([]);
  /**
   * Preserves setup configuration from the active round so re-running from
   * the end screen requires no network fetch or re-navigation.
   */
  const [lastInput, setLastInput] = useState<StartSessionInput | null>(null);
  /** What a repeat could not carry over, and why a repeat could not start. */
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  /** True between "run it again" and the round connecting, so the setup form
      does not flash up in the moment the old setup is being fetched. Says
      which, because a drill is not "the same round again". */
  const [replayLoading, setReplayLoading] = useState<'replay' | 'drill' | null>(null);

  /**
   * Tracks whether the round explicitly set the editor language, preventing
   * subsequent profile loads from overriding session-specific language choices.
   */
  const languageChosenByRound = useRef(false);

  useEffect(() => {
    if (profile && !languageChosenByRound.current) setLanguage(profile.preferredLanguage);
  }, [profile]);

  useLeaveGuard(
    iv.phase === 'live',
    'Leave the interview? The round ends here and will not be scored automatically. ' +
      'You can still score it from what was recorded, on its page in History.',
  );

  /**
   * The error renders above the setup form, and on a phone the page is still
   * scrolled to the Start button that raised it — 527px below, measured at
   * 390px wide — so a refused microphone looked like nothing happening.
   */
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (iv.phase === 'error' && iv.error) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [iv.phase, iv.error]);

  const dark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.hasAttribute('data-theme') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const start = useCallback(
    (input: StartSessionInput, picked?: DsaQuestion[]) => {
      setChosen(picked ?? []);
      setLastInput(input);
      setRoundMode(input.config.mode);
      languageChosenByRound.current = true;
      // Design rounds are note-taking; every language stays selectable.
      if (input.config.mode === 'system_design') setLanguage('markdown');
      // The language the round was CONFIGURED with, so a repeat meets the
      // problem under the same conditions as before.
      else if (input.config.mode === 'dsa') {
        setLanguage(input.config.language ?? profile?.preferredLanguage ?? 'python');
      }
      void iv.start(input);
    },
    [iv, profile],
  );

  /* ── repeating a past round ───────────────────────────────────────────────
     Replay navigation passes a session ID via router state. The server resolves
     the original configuration and starts the session immediately. */
  const location = useLocation();
  const navigate = useNavigate();
  const replaySessionId = (location.state as ReplayNavState | null)?.replaySessionId;
  /**
   * Which id has already been acted on.
   *
   * A ref, not state: it must be set before the render that clearing the router
   * state triggers, or StrictMode's second effect pass starts a second round —
   * and a round is a recorded artefact, not an idempotent fetch.
   */
  const replayed = useRef<string | null>(null);

  useEffect(() => {
    if (!replaySessionId || replayed.current === replaySessionId) return;
    replayed.current = replaySessionId;

    // Cleared first, so a reload or a Back does not silently start another
    // round from a stale entry in the history stack.
    navigate(location.pathname, { replace: true, state: null });

    setReplayError(null);
    setReplayNotice(null);
    setReplayLoading('replay');
    void api
      .get<ReplayPlan>(`/api/sessions/${replaySessionId}/replay`)
      .then((plan) => {
        if (plan.missingQuestionIds.length) {
          setReplayNotice(
            `${plan.missingQuestionIds.length} question(s) from that round have left the bank ` +
              `and were skipped: ${plan.missingQuestionIds.join(', ')}.`,
          );
        }
        start(plan.input, plan.questions);
      })
      .catch((e: unknown) => {
        setReplayError(
          e instanceof ApiError ? e.message : 'That round could not be set up again.',
        );
      })
      .finally(() => setReplayLoading(null));
  }, [replaySessionId, start, navigate, location.pathname]);

  /* ── retrying one moment ──────────────────────────────────────────────────
     The same shape as a repeat: the router carries only which moment, the
     server hands back the drill it rebuilt, and the round starts at once.
     Keyed by the navigation entry rather than the moment, because retrying
     the same moment again is the whole point — and a ref, for the reason the
     repeat's is one. */
  const drillRequest = (location.state as DrillNavState | null)?.drill;
  const drilled = useRef<string | null>(null);

  useEffect(() => {
    if (!drillRequest || drilled.current === location.key) return;
    drilled.current = location.key;
    navigate(location.pathname, { replace: true, state: null });

    setReplayError(null);
    setReplayNotice(null);
    setReplayLoading('drill');
    const minutes = drillRequest.minutes ? `?minutes=${drillRequest.minutes}` : '';
    void api
      .get<DrillPlan>(
        `/api/sessions/${drillRequest.sessionId}/moments/${encodeURIComponent(drillRequest.momentId)}/drill${minutes}`,
      )
      .then((plan) => start(plan.input, plan.questions))
      .catch((e: unknown) => {
        setReplayError(e instanceof ApiError ? e.message : 'That moment could not be set up as a drill.');
      })
      .finally(() => setReplayLoading(null));
  }, [drillRequest, location.key, start, navigate, location.pathname]);

  /* ── an onsite loop's next stage ──────────────────────────────────────────
     Opens the setup on the stage's mode and length; the questions are still
     picked by hand, and nothing starts until the user presses start. */
  const [loopStage, setLoopStage] = useState<LoopNavState['loopStage'] | null>(null);
  const loopRequest = (location.state as LoopNavState | null)?.loopStage;

  useEffect(() => {
    if (!loopRequest) return;
    setLoopStage(loopRequest);
    navigate(location.pathname, { replace: true, state: null });
  }, [loopRequest, navigate, location.pathname]);

  /* ── arriving from a feed card ────────────────────────────────────────────
     Unlike a repeat, this does NOT start anything: the question is ticked on
     the setup form and the user presses start themselves. Held in state and
     the router entry cleared immediately, so a Back or a reload does not
     re-tick a question the user has since removed. */
  const [feedPick, setFeedPick] = useState<FeedPracticeNavState['practice'] | null>(null);
  const practiceRequest = (location.state as FeedPracticeNavState | null)?.practice;

  useEffect(() => {
    if (!practiceRequest) return;
    setFeedPick(practiceRequest);
    navigate(location.pathname, { replace: true, state: null });
  }, [practiceRequest, navigate, location.pathname]);

  /**
   * The round's questions in the interviewer's order, with each one's starter
   * skeleton attached. Falls back to the setup selection when the server sent
   * no list (non-DSA rounds).
   */
  const roundQuestions = useMemo(() => {
    const byId = new Map(chosen.map((q) => [q.id, q]));
    if (iv.questions.length) {
      return iv.questions.map((q) => ({
        id: q.id,
        title: q.title,
        difficulty: q.difficulty,
        codeSnippets: byId.get(q.id)?.codeSnippets ?? null,
        practiceUrl: byId.get(q.id)?.practiceUrl ?? null,
      }));
    }
    return chosen.map((q) => ({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
      codeSnippets: q.codeSnippets,
      practiceUrl: q.practiceUrl,
    }));
  }, [iv.questions, chosen]);

  const pushContext = iv.pushContext;
  /**
   * The editor tags each push with the buffer it came from, which after a swap
   * is not the one now open. A design round's notes are a `scratchpad`: the
   * server labels them "design scratchpad" for the interviewer.
   */
  const pushCode = useCallback(
    (code: string, questionId: string | undefined, lang: EditorLanguage) =>
      pushContext(roundMode === 'system_design' ? 'scratchpad' : 'code', code, lang, questionId),
    [pushContext, roundMode],
  );

  const ivStop = iv.stop;
  // The editor's pending edit goes first: the server drops context after `session.stop`.
  const stopRound = useCallback(() => {
    editor.current?.flush();
    void ivStop();
  }, [ivStop]);

  return (
    <>
      {iv.error && iv.phase !== 'live' && (
        <div ref={errorRef} className="mx-auto mb-6 w-full max-w-3xl">
          <ErrorNote message={iv.error} />
        </div>
      )}

      {profileReq.error && iv.phase === 'idle' && (
        <ErrorNote className="mx-auto mb-6 w-full max-w-3xl"
                   message={`Your profile did not load, so its defaults are not applied: ${profileReq.error}`}
                   onRetry={profileReq.reload} />
      )}

      {replayError && iv.phase !== 'live' && (
        <div className="mx-auto mb-6 w-full max-w-3xl rounded-md border border-danger bg-danger-muted px-4 py-3">
          <p className="text-sm text-fg">{replayError}</p>
          <p className="mt-1 text-xs text-fg-muted">Set the round up below instead.</p>
        </div>
      )}

      {/* A repeat that dropped a retired question says so, and keeps saying so
          for the whole round: it is the difference between this round and the
          one it repeats, which is exactly what makes the two comparable. */}
      {replayNotice && (
        <div className="mx-auto mb-6 w-full max-w-3xl rounded-md border border-border bg-surface-alt px-4 py-3">
          <p className="text-sm text-fg">{replayNotice}</p>
        </div>
      )}

      {replayLoading && iv.phase === 'idle' ? (
        <div className="mx-auto w-full max-w-3xl rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
            <p className="text-sm text-fg">
              {replayLoading === 'drill' ? 'Setting up the drill…' : 'Setting the round up again…'}
            </p>
          </div>
          <p className="mt-2 text-xs text-fg-subtle">
            {replayLoading === 'drill'
              ? 'One question, put to you again, with what to fix on screen. The interviewer is not told how it went last time.'
              : 'Same questions, same voice, same length. This is a new round — the old one keeps its recording and its report.'}
          </p>
        </div>
      ) : (
        (iv.phase === 'idle' || iv.phase === 'connecting' || iv.phase === 'error') && (
          <SetupPanel
            onStart={start}
            connecting={iv.phase === 'connecting'}
            profile={profile}
            preselect={feedPick}
            loop={loopStage ?? null}
            onLeaveLoop={() => setLoopStage(null)}
          />
        )
      )}

      {(iv.phase === 'live' || iv.phase === 'ending') && (
        <ErrorBoundary panel="interview room">
          <LiveRoom
            transcript={iv.transcript}
            level={iv.level}
            aiSpeaking={iv.aiSpeaking}
            remainingMs={iv.remainingMs}
            notice={iv.notice}
            onStop={stopRound}
            ending={iv.phase === 'ending'}
            withEditor={withEditor}
            language={language}
            onLanguageChange={setLanguage}
            onPushCode={pushCode}
            editorRef={editor}
            dark={dark}
            questions={roundQuestions}
            questionIndex={iv.questionIndex}
            onSelectQuestion={iv.selectQuestion}
            practice={iv.practice}
            micLost={iv.micLost}
            onRetryMic={iv.retryMic}
            offline={iv.offline}
          />
        </ErrorBoundary>
      )}

      {iv.phase === 'ended' && (
        <EndScreen
          summary={iv.summary}
          transcript={iv.transcript}
          practice={iv.practice}
          onReset={() => {
            setLoopStage(null);
            iv.reset();
          }}
          onRunAgain={
            lastInput
              ? () => {
                  iv.reset();
                  // Never into the loop again: the loop's next stage is offered on
                  // its own, and a repeat would otherwise fill it with this round.
                  start({ ...lastInput, loopId: undefined }, chosen);
                }
              : undefined
          }
        />
      )}
    </>
  );
}
