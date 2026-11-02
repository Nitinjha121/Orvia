import type { BehaviouralQuestion, CollectionInfo, ConceptQuestion, HrScenario } from '../../lib/api';
import type { SurpriseDraw } from '../../lib/useSurprise';
import type { ConceptDepth, SetupState } from '../../lib/buildConfig';
import { DIFF_COLOR } from '../../lib/colors';
import { FIELD, LABEL } from '../ui/styles';
import { Segmented } from '../ui/Segmented';
import { SurprisePanel } from '../SurprisePanel';
import { PickList, PickedOrder } from './Pickers';
import { StudyLink } from './StudyLink';
import { DIFFICULTY_FACET } from './facets';

type Toggle = (next: (prev: string[]) => string[]) => void;
const toggle = (id: string) => (p: string[]) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

const DEPTHS = ['fundamentals', 'practical', 'internals'] as const satisfies readonly ConceptDepth[];
const DEPTH_BLURB: Record<ConceptDepth, string> = {
  fundamentals: 'What it is and why it exists. A correct working understanding is enough.',
  practical: 'How you actually use it — a decision you made, a bug it caused, a trade-off you took.',
  internals: 'The mechanism underneath. A correct description is where the answer starts, not where it ends.',
};

export function ConceptsSection({
  draw, bank, loaded, topics, topic, picked, setPicked, depth, setDepth,
}: {
  draw: SurpriseDraw<ConceptQuestion>;
  bank: readonly ConceptQuestion[];
  loaded: boolean;
  topics: readonly CollectionInfo[];
  /** The topic on the rail. */
  topic: string;
  picked: string[];
  setPicked: Toggle;
  depth: ConceptDepth;
  setDepth: (d: ConceptDepth) => void;
}) {
  const topicLabel = (id: string | undefined) => topics.find((t) => t.id === id)?.label ?? id;
  const justDrew = bank.find((q) => q.id === draw.justDrew);

  return (
    <>
      <SurprisePanel
        unit="question"
        poolSize={draw.poolSize}
        tally={draw.tally}
        note={draw.note}
        error={draw.historyError}
        rules={draw.rules}
        onRules={draw.setRules}
        onReset={draw.newCycle}
        onDraw={() => {
          const q = draw.draw();
          if (q) setPicked((prev) => [...prev, q.id]);
        }}
        /* Not limited to the topic on the rail: a concepts round is normally a
           mix, and a draw that only returns what is on screen is no surprise. */
        facets={[
          DIFFICULTY_FACET,
          {
            key: 'topic',
            label: 'Topics',
            options: topics.map((t) => ({ value: t.id, label: t.label })),
            scroll: true,
          },
        ]}
        assigned={
          justDrew && (
            <p className="text-xs text-fg-subtle">
              Assigned <span className="font-medium text-fg">{justDrew.title}</span>
              {' · '}{topicLabel(justDrew.topic)}{' · '}
              <span style={{ color: DIFF_COLOR[justDrew.difficulty] }}>{justDrew.difficulty}</span>
            </p>
          )
        }
      />

      <PickList
        items={bank
          .filter((q) => q.topic === topic)
          .map((q) => ({
            id: q.id, title: q.title, prompt: q.prompt, meta: q.difficulty,
            cycle: draw.outcomeOf(q.id),
          }))}
        picked={picked}
        onToggle={(id) => setPicked(toggle(id))}
        empty={
          !loaded ? 'Loading questions…'
            : bank.length === 0 ? 'No concept questions loaded — has the bank been seeded?'
            : 'Nothing in this topic yet.'
        }
        metaColor={DIFF_COLOR}
      />

      {/* Named across topics: a picked list that hides half of itself when you
          change topic is the bug. */}
      <PickedOrder
        label="Asked in this order"
        ids={picked}
        titleOf={(id) => bank.find((q) => q.id === id)?.title}
        subtitleOf={(id) => topicLabel(bank.find((q) => q.id === id)?.topic)}
        onRemove={(id) => setPicked((p) => p.filter((x) => x !== id))}
      />

      <div>
        <span className={LABEL}>Depth</span>
        <Segmented value={depth} options={DEPTHS} onChange={setDepth} label="Depth" />
        <p className="mt-1.5 text-xs text-fg-subtle">{DEPTH_BLURB[depth]}</p>
      </div>
    </>
  );
}

export function BehaviouralSection({
  bank, loaded, competencies, competency, picked, setPicked, experience, setExperience,
}: {
  bank: readonly BehaviouralQuestion[];
  loaded: boolean;
  competencies: readonly CollectionInfo[];
  competency: string;
  picked: string[];
  setPicked: Toggle;
  experience: string;
  setExperience: (v: string) => void;
}) {
  return (
    <>
      <StudyLink mode="behavioural">No stories ready yet, or unsure what is being scored?</StudyLink>
      <PickList
        items={bank
          .filter((q) => q.competency === competency)
          .map((q) => ({ id: q.id, title: q.title, prompt: q.prompt }))}
        picked={picked}
        onToggle={(id) => setPicked(toggle(id))}
        empty={
          !loaded ? 'Loading questions…'
            : bank.length === 0 ? 'No behavioural questions loaded — has the bank been seeded?'
            : 'Nothing in this competency yet.'
        }
      />

      <PickedOrder
        label="Asked in this order"
        ids={picked}
        titleOf={(id) => bank.find((q) => q.id === id)?.title}
        subtitleOf={(id) =>
          competencies.find((c) => c.id === bank.find((q) => q.id === id)?.competency)?.label
        }
        onRemove={(id) => setPicked((p) => p.filter((x) => x !== id))}
      />

      <div>
        <label className={LABEL} htmlFor="bexp">Your experience</label>
        <textarea id="bexp" rows={8} value={experience}
          onChange={(e) => setExperience(e.target.value)}
          placeholder="Projects, decisions, numbers you can defend…"
          className={`${FIELD} resize-y font-mono text-xs leading-relaxed`} />
        <p className="mt-1.5 text-xs text-fg-subtle">
          Optional, and the same text as an experience round. The interviewer uses it to
          ask for detail you should be able to give — it never reads it back at you.
        </p>
      </div>
    </>
  );
}

type HrFields = SetupState['hr'];

const HR_INPUTS: { key: Exclude<keyof HrFields, 'scenarioId'>; id: string; label: string; placeholder: string }[] = [
  { key: 'targetRole', id: 'hr-role', label: 'Role you are interviewing for', placeholder: 'Senior backend engineer' },
  { key: 'noticePeriod', id: 'hr-notice', label: 'Notice period', placeholder: '60 days, negotiable to 30' },
  { key: 'currentCompensation', id: 'hr-current', label: 'Current compensation', placeholder: 'e.g. 24L fixed plus 4L variable' },
  { key: 'expectedCompensation', id: 'hr-expected', label: 'What you actually want', placeholder: 'e.g. 38L total, 34L fixed floor' },
  { key: 'competingOffers', id: 'hr-offers', label: 'Competing offers', placeholder: 'One at final round, no number yet' },
  { key: 'reasonForLeaving', id: 'hr-why', label: 'Why you are leaving', placeholder: 'No path to senior for two years' },
];

/**
 * All fields are optional to allow practicing withholding specific compensation figures.
 */
export function HrSection({
  scenarios, loaded, hr, setHr,
}: {
  scenarios: readonly HrScenario[];
  loaded: boolean;
  /** `scenarioId` here is the effective selection. */
  hr: HrFields;
  setHr: (patch: Partial<HrFields>) => void;
}) {
  const selected = scenarios.find((s) => s.id === hr.scenarioId);

  return (
    <>
      <StudyLink mode="hr">Not sure how to answer "what is your current CTC?" or handle a big-jump objection?</StudyLink>
      <div>
        <span className={LABEL}>Scenario</span>
        <div className="max-h-60 space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5 sm:max-h-72">
          {scenarios.length === 0 && (
            <p className="p-3 text-sm text-fg-subtle">
              {loaded ? 'No scenarios loaded — has the bank been seeded?' : 'Loading scenarios…'}
            </p>
          )}
          {scenarios.map((sc) => (
            <button key={sc.id} type="button" onClick={() => setHr({ scenarioId: sc.id })}
              aria-pressed={hr.scenarioId === sc.id}
              className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm
                          transition-colors ${
                            hr.scenarioId === sc.id ? 'bg-brand-muted text-fg' : 'text-fg-muted hover:bg-surface-hover'}`}>
              <span className="min-w-0 flex-1">{sc.title}</span>
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-fg-subtle">
                {sc.stage.replace(/_/g, ' ')}
              </span>
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <p className="rounded-md bg-surface-alt p-3 text-sm leading-relaxed text-fg">{selected.blurb}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {HR_INPUTS.map((f) => (
          <div key={f.key}>
            <label className={LABEL} htmlFor={f.id}>{f.label}</label>
            <input id={f.id} value={hr[f.key]} onChange={(e) => setHr({ [f.key]: e.target.value })}
                   placeholder={f.placeholder} className={FIELD} />
          </div>
        ))}
      </div>

      {/* Without this the compensation fields read as a form to fill in
          honestly, and a candidate who types their number here and then gives
          it away in the room learns nothing. */}
      <p className="rounded-md border border-border bg-surface-alt p-3 text-xs leading-relaxed text-fg-muted">
        Every field is optional. <span className="text-fg">The interviewer is never told
        what you are earning or what you want</span> — those two go only to the report,
        so it can tell you whether the number you held in the room was the number you
        actually came in with. Leave them blank and the round still runs; you just lose
        that comparison.
      </p>
    </>
  );
}
