import type { SystemDesignProblem } from '../../lib/api';
import type { SurpriseDraw } from '../../lib/useSurprise';
import type { DesignLevel } from '../../lib/buildConfig';
import { LABEL } from '../ui/styles';
import { Segmented } from '../ui/Segmented';
import { SurprisePanel } from '../SurprisePanel';
import { CycleMark } from './Pickers';
import { StudyLink } from './StudyLink';

const LEVELS = ['junior', 'mid', 'senior', 'staff'] as const satisfies readonly DesignLevel[];

export function SystemDesignSection({
  draw, problems, loaded, problemId, setProblemId, level, setLevel,
}: {
  draw: SurpriseDraw<SystemDesignProblem>;
  problems: readonly SystemDesignProblem[];
  loaded: boolean;
  problemId: string;
  setProblemId: (id: string) => void;
  level: DesignLevel;
  setLevel: (l: DesignLevel) => void;
}) {
  const selected = problems.find((p) => p.id === problemId);

  return (
    <>
      <StudyLink mode="system_design">Shaky on caching, sharding or queues?</StudyLink>
      <SurprisePanel
        unit="problem"
        poolSize={draw.poolSize}
        tally={draw.tally}
        note={draw.note}
        error={draw.historyError}
        rules={draw.rules}
        onRules={draw.setRules}
        onReset={draw.newCycle}
        /* SELECTS rather than appends: a design round is one problem. */
        onDraw={() => {
          const p = draw.draw();
          if (p) setProblemId(p.id);
        }}
        /* Scored by phase rather than pass/fail, so retry-until-solved does not apply. */
        outcomes={draw.verdicts}
        facets={[{
          key: 'level',
          label: 'Target level',
          options: LEVELS.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) })),
        }]}
        assigned={
          draw.justDrew && selected?.id === draw.justDrew && (
            <p className="text-xs text-fg-subtle">
              Assigned <span className="font-medium text-fg">{selected.title}</span>
              {' · '}{selected.level}
            </p>
          )
        }
      />

      <div>
        <span className={LABEL}>Problem</span>
        <div className="max-h-60 space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5 sm:max-h-72">
          {problems.length === 0 && (
            <p className="p-3 text-sm text-fg-subtle">
              {loaded ? 'No system design problems loaded — has the bank been seeded?' : 'Loading problems…'}
            </p>
          )}
          {problems.map((p) => (
            <button key={p.id} type="button" onClick={() => setProblemId(p.id)} aria-pressed={problemId === p.id}
              className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm
                          transition-colors ${
                            problemId === p.id ? 'bg-brand-muted text-fg' : 'text-fg-muted hover:bg-surface-hover'}`}>
              <span className="min-w-0 flex-1">{p.title}</span>
              <CycleMark {...draw.outcomeOf(p.id)} verdicts={false} />
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-fg-subtle">{p.level}</span>
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <p className="rounded-md bg-surface-alt p-3 text-sm leading-relaxed text-fg">{selected.prompt}</p>
      )}
      <div>
        <span className={LABEL}>Target level</span>
        <Segmented value={level} options={LEVELS} onChange={setLevel} label="Target level" />
      </div>
    </>
  );
}
