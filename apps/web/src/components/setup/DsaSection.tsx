import { useMemo } from 'react';
import type { DsaQuestion } from '../../lib/api';
import type { SurpriseDraw } from '../../lib/useSurprise';
import { DIFF_COLOR } from '../../lib/colors';
import { FIELD } from '../ui/styles';
import { SurprisePanel } from '../SurprisePanel';
import { ResolveStrip } from '../ResolveQueue';
import { CycleMark, PickedOrder } from './Pickers';
import { DIFFICULTY_FACET, DIFF_SHORT } from './facets';

export function DsaSection({
  draw, questions, loaded, picked, setPicked, search, setSearch, difficulty, setDifficulty, onResolve,
}: {
  draw: SurpriseDraw<DsaQuestion>;
  /** The list for the collection on the rail — empty until it has loaded. */
  questions: readonly DsaQuestion[];
  loaded: boolean;
  picked: string[];
  setPicked: (next: (prev: string[]) => string[]) => void;
  search: string;
  setSearch: (v: string) => void;
  difficulty: string;
  setDifficulty: (v: string) => void;
  /** Tick one problem from the re-solve queue, which may be outside this list. */
  onResolve: (questionId: string) => void;
}) {
  const topicOptions = useMemo(
    () => [...new Set(questions.flatMap((q) => q.topics ?? []))].sort((a, b) => a.localeCompare(b)),
    [questions],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return questions.filter((x) => {
      if (difficulty !== 'all' && x.difficulty !== difficulty) return false;
      if (!q) return true;
      return x.title.toLowerCase().includes(q) || x.topics.some((t) => t.toLowerCase().includes(q));
    });
  }, [questions, search, difficulty]);

  const justDrew = questions.find((q) => q.id === draw.justDrew);

  return (
    <>
      <ResolveStrip picked={picked} onResolve={onResolve} />

      {/* Above the browser: with no particular problem in mind, this IS the page. */}
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
          // Appends, so pressing it twice builds a two-problem round.
          if (q) setPicked((prev) => [...prev, q.id]);
        }}
        facets={[
          DIFFICULTY_FACET,
          {
            key: 'topic',
            label: 'Topics',
            options: topicOptions.map((t) => ({ value: t, label: t })),
            scroll: true,
          },
        ]}
        assigned={
          justDrew && (
            <p className="text-xs text-fg-subtle">
              Assigned <span className="font-medium text-fg">{justDrew.title}</span>
              {' · '}
              <span style={{ color: DIFF_COLOR[justDrew.difficulty] }}>{justDrew.difficulty}</span>
            </p>
          )
        }
      />

      <div>
        <div className="mb-2 flex gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Search by title or topic…" className={FIELD} />
          <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Difficulty"
                  className="rounded-md border border-border bg-surface-alt px-2 text-sm text-fg focus:border-brand focus:outline-none">
            <option value="all">All</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </div>

        {/* Full width, so no title is truncated. Shorter on a phone, where 26rem
            is most of the viewport and the options below become unreachable. */}
        <div className="max-h-[20rem] space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5 sm:max-h-[26rem]">
          {filtered.length === 0 && (
            <p className="p-3 text-sm text-fg-subtle">
              {!loaded ? 'Loading questions…'
                : questions.length === 0 ? 'This list has no questions.'
                : 'Nothing matches that search.'}
            </p>
          )}
          {filtered.map((q) => {
            const on = picked.includes(q.id);
            return (
              <button key={q.id} type="button" aria-pressed={on}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== q.id) : [...p, q.id]))}
                className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition-colors sm:gap-3 sm:px-3 ${
                  on ? 'bg-brand-muted text-fg' : 'text-fg-muted hover:bg-surface-hover'}`}>
                <span className="w-9 shrink-0 font-mono text-[10px] text-fg-subtle">{q.leetcodeId}</span>
                <span className="min-w-0 flex-1">{q.title}</span>
                <CycleMark {...draw.outcomeOf(q.id)} />
                <span className="hidden shrink-0 truncate text-[11px] text-fg-subtle sm:block sm:max-w-[11rem]">
                  {(q.topics ?? []).slice(0, 2).join(' · ')}
                </span>
                <span className="w-11 shrink-0 text-right text-[11px] font-semibold"
                      style={{ color: DIFF_COLOR[q.difficulty] }}>
                  {DIFF_SHORT[q.difficulty] ?? q.difficulty}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <PickedOrder
        label="Asked in this order"
        ids={picked}
        titleOf={(id) => questions.find((q) => q.id === id)?.title}
        onRemove={(id) => setPicked((p) => p.filter((x) => x !== id))}
      />
    </>
  );
}
