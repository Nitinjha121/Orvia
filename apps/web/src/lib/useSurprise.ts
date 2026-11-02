import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cycleAttempts, cycleTally, drawOne, eligible, emptyPoolNote, ruleMatches,
  type DrawRules, type PracticeAttempt, type QuestionOutcomeKind, type SurpriseMode,
} from '@orvia/shared';
import { api } from './api';
import { cycleStart, loadRules, resetCycle, saveRules } from './practice';

/**
 * Hook managing random question draw state and facet filtering for setup modes.
 * Defers fetching attempt history until a mode's tab becomes active, caching
 * results for the lifetime of the panel.
 */
export function useSurprise<T extends { id: string }>({
  mode, scope, items, facetsOf, picked, unit, active, verdicts = true,
}: {
  mode: SurpriseMode;
  /** Cycle key. Namespaced by mode — see `practice.ts`. */
  scope: string;
  items: readonly T[];
  /** facet name → this item's values. Empty values simply never match a rule. */
  facetsOf: (item: T) => Record<string, string[]>;
  /** Already chosen for this round, so a draw never hands you the same one twice. */
  picked: readonly string[];
  /** The noun this mode uses in prose: "question", "problem". */
  unit?: string;
  active: boolean;
  /**
   * Whether a report can ever say how one of these went. False for system
   * design — one open-ended problem, scored by phase — where every handout
   * arrives with a null verdict and stays retired on that alone.
   */
  verdicts?: boolean;
}) {
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([]);
  const [rules, setRulesState] = useState<DrawRules>(() => loadRules(mode));
  const [cycleAt, setCycleAt] = useState<string | null>(() => cycleStart(scope));
  const [justDrew, setJustDrew] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loaded = useRef(false);

  /**
   * Held in a ref to prevent inline callbacks from causing unnecessary
   * candidate list recalculations on frequent parent re-renders.
   */
  const facets = useRef(facetsOf);
  facets.current = facetsOf;

  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void api
      .get<PracticeAttempt[]>(`/api/questions/attempted?mode=${mode}`)
      .then((a) => {
        setAttempts(a);
        setHistoryError(null);
      })
      .catch((e: unknown) => {
        // Without history every question looks unasked, so the draw would
        // happily repeat — say so rather than draw from a wrong pool silently.
        setHistoryError(
          `Could not load your round history (${e instanceof Error ? e.message : String(e)}), ` +
            'so this draw may repeat questions you have already had.',
        );
      });
  }, [active, mode]);

  // Cycles are per scope, so switching lists switches which line counts.
  useEffect(() => {
    setCycleAt(cycleStart(scope));
    setJustDrew(null);
  }, [scope]);

  const candidates = useMemo(
    () => items.map((item) => ({ id: item.id, facets: facets.current(item), item })),
    [items],
  );

  /** This cycle's handouts, id → verdict. */
  const cycle = useMemo(() => cycleAttempts(attempts, cycleAt), [attempts, cycleAt]);

  const matched = useMemo(() => ruleMatches(candidates, rules), [candidates, rules]);
  const allowed = useMemo(() => eligible(candidates, rules, cycle), [candidates, rules, cycle]);
  /** What a draw can actually return right now. */
  const pool = useMemo(() => allowed.filter((c) => !picked.includes(c.id)), [allowed, picked]);
  const tally = useMemo(() => cycleTally(candidates, cycle), [candidates, cycle]);

  const note = emptyPoolNote(
    {
      total: candidates.length,
      ruleMatches: matched.length,
      eligible: allowed.length,
      pool: pool.length,
      pending: tally.pending,
    },
    rules,
    unit,
    verdicts,
  );

  /** One item, uniformly at random, from whatever the rules leave. */
  const draw = useCallback((): T | null => {
    const hit = drawOne(pool);
    if (!hit) return null;
    setJustDrew(hit.id);
    return hit.item;
  }, [pool]);

  const setRules = useCallback(
    (next: DrawRules) => {
      setRulesState(next);
      saveRules(mode, next);
    },
    [mode],
  );

  const newCycle = useCallback(() => {
    setCycleAt(resetCycle(scope));
    setJustDrew(null);
  }, [scope]);

  /** What this cycle already knows about one item, for the row marks. */
  const outcomeOf = useCallback(
    (id: string): { asked: boolean; outcome: QuestionOutcomeKind | null } => ({
      asked: cycle.has(id),
      outcome: cycle.get(id) ?? null,
    }),
    [cycle],
  );

  return {
    rules, setRules, verdicts,
    poolSize: pool.length,
    tally, note,
    draw, justDrew, newCycle,
    outcomeOf,
    historyError,
  };
}

export type SurpriseDraw<T extends { id: string }> = ReturnType<typeof useSurprise<T>>;
