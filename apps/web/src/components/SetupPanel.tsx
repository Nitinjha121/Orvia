import { useEffect, useState } from 'react';
import {
  INTERVIEW_MODES, INTERVIEW_STYLES, MODE_SHORT_LABELS, VOICES, DEFAULT_COLLECTION,
  type InterviewMode, type InterviewStyle, type SessionOptions, type StartSessionInput,
} from '@orvia/shared';
import type { DsaQuestion, Profile } from '../lib/api';
import type { FeedPracticeNavState } from '../lib/feedPractice';
import type { LoopNavState } from '../lib/loop';
import { useSurprise } from '../lib/useSurprise';
import { buildConfig, type ConceptDepth, type DesignLevel, type SetupState } from '../lib/buildConfig';
import { useSetupBanks } from '../hooks/useSetupBanks';
import { CollectionRail } from './CollectionRail';
import { FIELD, LABEL } from './ui/styles';
import { Segmented } from './ui/Segmented';
import { ErrorNote } from './ui/ErrorNote';
import { DsaSection } from './setup/DsaSection';
import { SystemDesignSection } from './setup/SystemDesignSection';
import { ExperienceSection, JdSection } from './setup/TextSections';
import { BehaviouralSection, ConceptsSection, HrSection } from './setup/SpokenSections';

const BARS = ['warmup', 'standard', 'hard'] as const satisfies readonly SessionOptions['difficulty'][];
const PERSONAS = ['friendly', 'neutral', 'terse'] as const satisfies readonly SessionOptions['persona'][];

const EMPTY_HR: SetupState['hr'] = {
  scenarioId: '', targetRole: '', currentCompensation: '', expectedCompensation: '',
  noticePeriod: '', competingOffers: '', reasonForLeaving: '',
};

export function SetupPanel({
  onStart, connecting, profile, preselect, loop = null, onLeaveLoop,
}: {
  /**
   * `chosen` is the DSA questions that were picked, in order. Not part of
   * `StartSessionInput`: the server already has these rows, and the client
   * needs them only for the editor's starter skeletons.
   */
  onStart: (input: StartSessionInput, chosen?: DsaQuestion[]) => void;
  connecting: boolean;
  profile: Profile | null;
  /** One question to arrive with already ticked, from a feed card. */
  preselect?: FeedPracticeNavState['practice'] | null;
  /** An onsite loop's next stage: the mode and length are the stage's, not a choice. */
  loop?: LoopNavState['loopStage'] | null;
  onLeaveLoop?: () => void;
}) {
  const [mode, setMode] = useState<InterviewMode>('dsa');

  const [collection, setCollection] = useState(DEFAULT_COLLECTION);
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [difficulty, setDifficultyFilter] = useState('all');

  /* Rail and single-choice selections default to the bank's first row until
     the user picks one, so they are stored as a choice and resolved below. */
  const [conceptTopicChoice, setConceptTopic] = useState('');
  const [conceptPicked, setConceptPicked] = useState<string[]>([]);
  const [depth, setDepth] = useState<ConceptDepth>('practical');

  const [competencyChoice, setCompetency] = useState('');
  const [behaviouralPicked, setBehaviouralPicked] = useState<string[]>([]);

  const [hr, setHrState] = useState(EMPTY_HR);
  const setHr = (patch: Partial<SetupState['hr']>) => setHrState((cur) => ({ ...cur, ...patch }));

  const [jd, setJd] = useState('');
  const [experience, setExperience] = useState('');
  const [problemChoice, setProblemId] = useState('');
  const [level, setLevel] = useState<DesignLevel>('mid');

  const [durationMinutes, setDuration] = useState(profile?.defaultDurationMinutes ?? 30);
  const [bar, setBar] = useState<SessionOptions['difficulty']>(profile?.defaultDifficulty ?? 'standard');
  const [persona, setPersona] = useState<SessionOptions['persona']>(profile?.defaultPersona ?? 'neutral');
  const [voice, setVoice] = useState(profile?.defaultVoice ?? 'Charon');
  const [style, setStyle] = useState<InterviewStyle>('general');

  // Pre-filled from the profile: the point of it is never pasting this again.
  useEffect(() => {
    if (!profile) return;
    setDuration(profile.defaultDurationMinutes);
    setBar(profile.defaultDifficulty);
    setPersona(profile.defaultPersona);
    setVoice(profile.defaultVoice);
    setExperience(profile.experience);
  }, [profile]);

  // Set after the profile effect above, so a loop stage's length is not
  // overwritten by the profile's default when both arrive together.
  useEffect(() => {
    if (!loop) return;
    setMode(loop.mode);
    setDuration(loop.minutes);
  }, [loop, profile]);

  const banks = useSetupBanks(collection);
  const { questions, problems, concepts, behavioural, scenarios } = banks;

  const conceptTopic = conceptTopicChoice || banks.conceptTopics[0]?.id || '';
  const competency = competencyChoice || banks.competencies[0]?.id || '';
  const problemId = problemChoice || problems[0]?.id || '';
  const scenarioId = hr.scenarioId || scenarios[0]?.id || '';

  const chooseCollection = (id: string) => {
    setCollection(id);
    setPicked([]);
  };

  /* ── arriving from a feed card ────────────────────────────────────────────
     Held until the bank it lives in has loaded, and for DSA it may not be in
     the collection on screen at all. Cleared once resolved. */
  const [pendingPick, setPendingPick] = useState(preselect ?? null);

  useEffect(() => {
    if (!preselect) return;
    setPendingPick(preselect);
    setMode(preselect.mode);
  }, [preselect]);

  useEffect(() => {
    if (!pendingPick) return;
    const { mode: m, questionId } = pendingPick;

    switch (m) {
      case 'dsa':
        if (banks.dsaFailed) return setPendingPick(null);
        // Resolved only against the list for the collection now on the rail.
        if (!banks.dsaLoaded) return;
        if (questions.some((q) => q.id === questionId)) {
          setPicked([questionId]);
          setPendingPick(null);
        } else if (collection !== 'all') {
          // `all` is derived from the whole table, so a slug from any list is in it.
          chooseCollection('all');
        } else {
          // Not in the bank at all. The form is still usable; an error about a
          // question the user never typed would be noise.
          setPendingPick(null);
        }
        return;
      case 'concepts': {
        if (!banks.conceptsLoaded) return;
        const q = concepts.find((x) => x.id === questionId);
        if (q) {
          setConceptPicked([questionId]);
          // The rail too, or it reads "1 selected" over a topic that is not it.
          setConceptTopic(q.topic);
        }
        return setPendingPick(null);
      }
      case 'behavioural': {
        if (!banks.behaviouralLoaded) return;
        const q = behavioural.find((x) => x.id === questionId);
        if (q) {
          setBehaviouralPicked([questionId]);
          setCompetency(q.competency);
        }
        return setPendingPick(null);
      }
      case 'system_design':
        if (!banks.problemsLoaded) return;
        if (problems.some((p) => p.id === questionId)) setProblemId(questionId);
        return setPendingPick(null);
      case 'hr':
        if (!banks.scenariosLoaded) return;
        if (scenarios.some((s) => s.id === questionId)) setHr({ scenarioId: questionId });
        return setPendingPick(null);
      default:
        return setPendingPick(null);
    }
  }, [pendingPick, banks.dsaLoaded, banks.dsaFailed, banks.conceptsLoaded, banks.behaviouralLoaded,
      banks.problemsLoaded, banks.scenariosLoaded, questions, concepts, behavioural, problems, scenarios,
      collection]);

  /* ── the random draw ──────────────────────────────────────────────────────
     Same rules for every mode (`@orvia/shared/practice`); they differ in what
     they filter on and which cycle they count against. `active` defers each
     one's history request until its tab is opened. */

  const dsaDraw = useSurprise({
    mode: 'dsa',
    // Per list: exhausting Blind 75 must not reset your NeetCode 150 progress.
    scope: `dsa:${collection}`,
    items: questions,
    facetsOf: (q) => ({ difficulty: [q.difficulty], topic: q.topics ?? [] }),
    picked,
    active: mode === 'dsa',
  });

  const conceptDraw = useSurprise({
    mode: 'concepts',
    // ONE cycle across every topic: a per-topic cycle would need "reset"
    // pressed eight times to go round again.
    scope: 'concepts',
    items: concepts,
    facetsOf: (q) => ({ difficulty: [q.difficulty], topic: [q.topic] }),
    picked: conceptPicked,
    active: mode === 'concepts',
  });

  const designDraw = useSurprise({
    mode: 'system_design',
    scope: 'system_design',
    items: problems,
    facetsOf: (p) => ({ level: [p.level] }),
    // One problem per round, so "already picked" is the selection — pressing
    // again hands you a different one rather than the same one back.
    picked: problemId ? [problemId] : [],
    unit: 'problem',
    active: mode === 'system_design',
    verdicts: false,
  });

  const selectedProblem = problems.find((p) => p.id === problemId);

  const input = buildConfig(mode, {
    dsa: { questionIds: picked, language: profile?.preferredLanguage ?? 'python' },
    jobDescription: jd,
    experience,
    systemDesign: { problem: selectedProblem ?? null, level },
    concepts: { questionIds: conceptPicked, depth },
    behavioural: { questionIds: behaviouralPicked },
    hr: { ...hr, scenarioId },
    // `general` is left out rather than sent, so a round without a style is
    // stored exactly as rounds were before styles existed.
    options: { durationMinutes, difficulty: bar, persona, voice, ...(style !== 'general' ? { style } : {}) },
  });

  function submit() {
    if (!input) return;
    // Only when the tab still matches the stage: the server refuses a loop
    // round in the wrong mode, and a user who switched tabs has left the loop.
    const withLoop = loop && mode === loop.mode ? { ...input, loopId: loop.loopId } : input;
    const chosen =
      mode === 'dsa'
        ? picked.map((id) => questions.find((q) => q.id === id)).filter((q): q is DsaQuestion => !!q)
        : undefined;
    onStart(withLoop, chosen);
  }

  const hasRail =
    (mode === 'dsa' && banks.collections.length > 0) ||
    (mode === 'concepts' && banks.conceptTopics.length > 0) ||
    (mode === 'behavioural' && banks.competencies.length > 0);

  const errors = banks.errorsFor(mode);

  return (
    <div className="mx-auto w-full max-w-5xl">
      {loop && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-brand-muted px-4 py-3">
          <p className="text-sm text-fg">
            <span className="font-semibold">{loop.label}</span> — round {loop.stage + 1} of {loop.of}:{' '}
            {MODE_SHORT_LABELS[loop.mode]}, {loop.minutes} minutes.
            {mode !== loop.mode && (
              <span className="text-fg-muted"> Switch back to the {MODE_SHORT_LABELS[loop.mode]} tab to run it as this stage.</span>
            )}
          </p>
          {onLeaveLoop && (
            <button type="button" onClick={onLeaveLoop}
              className="text-xs font-medium text-fg-muted hover:text-fg">
              Not now
            </button>
          )}
        </div>
      )}
      {/* Modes stay as tabs, with the SHORT labels. Even short they are ~700px,
          so below `sm` the row scrolls rather than wrapping into three rows.
          Buttons with aria-pressed, not role=tab: the live room's question
          tabs are the only tablist the browser suite counts. */}
      <div role="group" aria-label="Interview mode"
           className="mb-4 flex gap-1.5 overflow-x-auto pb-1 sm:mb-5 sm:flex-wrap sm:overflow-visible sm:pb-0">
        {INTERVIEW_MODES.map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === m ? 'bg-brand text-brand-fg' : 'bg-surface-alt text-fg-muted hover:bg-surface-hover hover:text-fg'}`}>
            {MODE_SHORT_LABELS[m]}
          </button>
        ))}
      </div>

      <div className={hasRail ? 'grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-5' : ''}>
        {hasRail && mode === 'dsa' && (
          <CollectionRail
            collections={banks.collections} collection={collection} onCollection={chooseCollection}
            pickedCount={picked.length} onClear={() => setPicked([])}
          />
        )}
        {hasRail && mode === 'concepts' && (
          <CollectionRail
            heading="Topics" unit="questions"
            collections={banks.conceptTopics} collection={conceptTopic} onCollection={setConceptTopic}
            pickedCount={conceptPicked.length} onClear={() => setConceptPicked([])}
          />
        )}
        {hasRail && mode === 'behavioural' && (
          <CollectionRail
            heading="Competencies" unit="questions"
            collections={banks.competencies} collection={competency} onCollection={setCompetency}
            pickedCount={behaviouralPicked.length} onClear={() => setBehaviouralPicked([])}
          />
        )}

        <div className="min-w-0 space-y-5 rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-5">
          {errors.map((e) => (
            <ErrorNote key={e.label} message={`${e.label} could not be loaded: ${e.message}`} onRetry={e.reload} />
          ))}

          {mode === 'dsa' && (
            <DsaSection
              draw={dsaDraw} questions={questions} loaded={banks.dsaLoaded}
              picked={picked} setPicked={setPicked}
              search={search} setSearch={setSearch}
              difficulty={difficulty} setDifficulty={setDifficultyFilter}
              onResolve={(questionId) =>
                // Added beside anything already picked, as a draw is; a problem
                // outside this list goes the feed's way, which switches to `all`.
                questions.some((q) => q.id === questionId)
                  ? setPicked((prev) => (prev.includes(questionId) ? prev : [...prev, questionId]))
                  : setPendingPick({ mode: 'dsa', questionId })}
            />
          )}

          {mode === 'system_design' && (
            <SystemDesignSection
              draw={designDraw} problems={problems} loaded={banks.problemsLoaded}
              problemId={problemId} setProblemId={setProblemId}
              level={level} setLevel={setLevel}
            />
          )}

          {mode === 'jd' && <JdSection jds={banks.jds} jd={jd} setJd={setJd} />}

          {mode === 'experience' && (
            <ExperienceSection experience={experience} setExperience={setExperience}
                               fromProfile={!!profile?.experience}
                               jds={banks.jds} jd={jd} setJd={setJd} />
          )}

          {mode === 'concepts' && (
            <ConceptsSection
              draw={conceptDraw} bank={concepts} loaded={banks.conceptsLoaded}
              topics={banks.conceptTopics} topic={conceptTopic}
              picked={conceptPicked} setPicked={setConceptPicked}
              depth={depth} setDepth={setDepth}
            />
          )}

          {mode === 'behavioural' && (
            <BehaviouralSection
              bank={behavioural} loaded={banks.behaviouralLoaded}
              competencies={banks.competencies} competency={competency}
              picked={behaviouralPicked} setPicked={setBehaviouralPicked}
              experience={experience} setExperience={setExperience}
            />
          )}

          {mode === 'hr' && (
            <HrSection scenarios={scenarios} loaded={banks.scenariosLoaded}
                       hr={{ ...hr, scenarioId }} setHr={setHr} />
          )}

          <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="dur">Length — {durationMinutes} min</label>
              <input id="dur" type="range" min={5} max={90} step={5} value={durationMinutes}
                     onChange={(e) => setDuration(Number(e.target.value))} className="w-full accent-brand" />
            </div>
            <div>
              <label className={LABEL} htmlFor="voice">Interviewer voice</label>
              <select id="voice" value={voice} onChange={(e) => setVoice(e.target.value)} className={FIELD}>
                {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <span className={LABEL}>Bar</span>
              <Segmented value={bar} options={BARS} onChange={setBar} label="Bar" />
            </div>
            <div>
              <span className={LABEL}>Manner</span>
              <Segmented value={persona} options={PERSONAS} onChange={setPersona} label="Manner" />
            </div>
            {/* Full width: five options do not fit the half-column at phone width. */}
            <div className="sm:col-span-2">
              <span className={LABEL}>Interviewer style</span>
              <Segmented value={style} options={INTERVIEW_STYLES} onChange={setStyle} label="Interviewer style" />
              {style !== 'general' && (
                <p className="mt-1.5 text-xs text-fg-subtle">
                  Changes what the interviewer probes for, not how you are scored.
                </p>
              )}
            </div>
          </div>

          <button type="button" onClick={submit} disabled={!input || connecting}
            className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg
                       transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {connecting ? 'Connecting…' : 'Start interview'}
          </button>
          <p className="text-center text-xs text-fg-subtle">
            Your microphone stays on for the whole round. Nothing is scored until it ends.
          </p>
        </div>
      </div>
    </div>
  );
}
