import { useEffect, useState } from 'react';
import type { InterviewMode } from '@orvia/shared';
import { useApi } from './useApi';
import {
  api, type CollectionInfo, type DsaQuestion, type SystemDesignProblem, type JobDescription,
  type ConceptQuestion, type BehaviouralQuestion, type HrScenario,
} from '../lib/api';

/** Stable across renders, so memoised consumers do not recompute while a bank loads. */
const EMPTY: never[] = [];

export type BankError = { label: string; message: string; reload: () => void };

/**
 * Every bank the setup screen reads, fetched once on mount — except the DSA
 * list, which follows `collection`.
 *
 * The concept and behavioural banks are fetched WHOLE and filtered in the
 * browser: a round can span topics, so the picked list has to be able to name
 * a question whose topic is no longer on screen.
 */
export function useSetupBanks(collection: string) {
  const collections = useApi<CollectionInfo[]>('/api/questions/collections');
  const problems = useApi<SystemDesignProblem[]>('/api/questions/system-design');
  const jds = useApi<JobDescription[]>('/api/profile/job-descriptions');
  const conceptTopics = useApi<CollectionInfo[]>('/api/questions/concept-topics');
  const concepts = useApi<ConceptQuestion[]>('/api/questions/concepts');
  const competencies = useApi<CollectionInfo[]>('/api/questions/competencies');
  const behavioural = useApi<BehaviouralQuestion[]>('/api/questions/behavioural');
  const scenarios = useApi<HrScenario[]>('/api/questions/hr-scenarios');

  /**
   * The DSA list is paired with its collection so pending collection changes
   * do not resolve selections against outdated question lists.
   */
  const [dsa, setDsa] = useState<{ collection: string; questions: DsaQuestion[] } | null>(null);
  const [dsaError, setDsaError] = useState<string | null>(null);
  const [dsaAttempt, setDsaAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setDsaError(null);
    api
      .get<DsaQuestion[]>(`/api/questions/dsa?collection=${encodeURIComponent(collection)}`)
      .then((questions) => {
        if (live) setDsa({ collection, questions });
      })
      .catch((e: unknown) => {
        if (live) setDsaError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [collection, dsaAttempt]);

  const dsaLoaded = dsa?.collection === collection;

  const errorsFor = (mode: InterviewMode): BankError[] => {
    const all: [InterviewMode[], string, { error: string | null; reload: () => void }][] = [
      [['dsa'], 'The question lists', collections],
      [['dsa'], 'This list', { error: dsaError, reload: () => setDsaAttempt((n) => n + 1) }],
      [['system_design'], 'The system design problems', problems],
      [['jd'], 'Your saved job descriptions', jds],
      [['concepts'], 'The concept topics', conceptTopics],
      [['concepts'], 'The concept questions', concepts],
      [['behavioural'], 'The competencies', competencies],
      [['behavioural'], 'The behavioural questions', behavioural],
      [['hr'], 'The HR scenarios', scenarios],
    ];
    return all
      .filter(([modes, , s]) => modes.includes(mode) && s.error)
      .map(([, label, s]) => ({ label, message: s.error!, reload: s.reload }));
  };

  return {
    collections: collections.data ?? EMPTY,
    /** Only ever the list for `collection`; empty while that one loads. */
    questions: dsaLoaded ? dsa.questions : EMPTY,
    /** True once `questions` is the answer for the current collection. */
    dsaLoaded,
    dsaFailed: dsaError !== null,
    problems: problems.data ?? EMPTY,
    problemsLoaded: problems.data !== null || problems.error !== null,
    jds: jds.data ?? EMPTY,
    conceptTopics: conceptTopics.data ?? EMPTY,
    concepts: concepts.data ?? EMPTY,
    conceptsLoaded: concepts.data !== null || concepts.error !== null,
    competencies: competencies.data ?? EMPTY,
    behavioural: behavioural.data ?? EMPTY,
    behaviouralLoaded: behavioural.data !== null || behavioural.error !== null,
    scenarios: scenarios.data ?? EMPTY,
    scenariosLoaded: scenarios.data !== null || scenarios.error !== null,
    errorsFor,
  };
}
