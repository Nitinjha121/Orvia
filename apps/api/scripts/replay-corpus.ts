/** The shape `export-replay-corpus.mts` writes and `replay-guards.mts` reads. */
export type ReplayRound = {
  id: string;
  mode: string;
  kind: string;
  startedAt: string;
  config: unknown;
  options: unknown;
  questions: {
    id: string;
    title: string;
    difficulty: string;
    prompt: string;
    constraints: string[] | null;
  }[];
  starters: Record<string, string[]>;
  turns: { speaker: 'ai' | 'user'; text: string; startMs: number; interrupted: boolean }[];
  context: { kind: 'code' | 'design'; content: string; atMs: number }[];
  /** As recorded live, for comparison only — the replay never reads it. */
  guardEvents: unknown[];
};

export type ReplayCorpus = { exportedAt: string; rounds: ReplayRound[] };
