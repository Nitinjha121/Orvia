import { norm } from './text-norm';

/**
 * Tracks which question the round is currently on by matching spoken
 * text against question prompts and titles.
 */

export type TrackedQuestion = {
  id: string;
  title: string;
  prompt: string;
};

/**
 * A fragment is often a few words, and `outputTranscription.finished` is never
 * set, so a rolling window gives the matcher a sentence or two.
 */
const WINDOW_CHARS = 700;

/** About a clause of the statement; a passing reference must not move the round. */
const MIN_HITS = 4;

/** Two near-duplicate questions matched about equally identify neither. */
const WIN_MARGIN = 2;

/**
 * Common word pairs present in prompt boilerplate to exclude from distinctive matching.
 * Regenerate with `pnpm --filter @orvia/api derive:boilerplate`.
 */
const BOILERPLATE = new Set([
  '0 to', 'a binary', 'a list', 'a single', 'a string', 'all the', 'an algorithm', 'an array',
  'an integer', 'an m', 'and a', 'and an', 'and return', 'and the', 'any order', 'are also',
  'are given', 'array nums', 'array of', 'as a', 'as the', 'at least', 'at most', 'at the',
  'binary tree', 'can be', 'does not', 'equal to', 'example the', 'false otherwise',
  'find the', 'for example', 'from 0', 'from the', 'given a', 'given an', 'given the',
  'given two', 'i and', 'i e', 'i is', 'i th', 'if it', 'if the', 'if there', 'if you',
  'implement the', 'in a', 'in any', 'in the', 'initializes the', 'integer array', 'integer k',
  'is a', 'is defined', 'is no', 'is not', 'is the', 'is to', 'it is', 'length of',
  'linked list', 'list of', 'm x', 'n 1', 'need to', 'note that', 'number of', 'of a',
  'of integers', 'of length', 'of strings', 'of the', 'of two', 'on the', 'return all',
  'return the', 'return true', 'root of', 'sequence of', 'should be', 'so that', 'sorted in',
  'string s', 'such that', 'sum of', 'that is', 'that the', 'that you', 'the answer',
  'the array', 'the first', 'the following', 'the given', 'the i', 'the input', 'the length',
  'the longest', 'the maximum', 'the minimum', 'the number', 'the root', 'the same', 'the sum',
  'the value', 'there are', 'there is', 'to be', 'to n', 'to the', 'tree given', 'true if',
  'up to', 'where each', 'will be', 'with the', 'x n', 'you are', 'you can', 'you may',
  'you must',
]);

export { norm };

export function bigrams(text: string): Set<string> {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
  return out;
}

/** Words, because digits never appear in the transcript. */
const ORDINALS: Record<string, number> = {
  one: 0, first: 0,
  two: 1, second: 1,
  three: 2, third: 2,
  four: 3, fourth: 3,
  five: 4, fifth: 4,
  six: 5, sixth: 5,
  seven: 6, seventh: 6,
  eight: 7, eighth: 7,
};

/**
 * Pairs that identify ONE of these questions: unshared within the round, and
 * not bank-wide boilerplate. Shared with `QuestionScopeGuard` so the two cannot
 * drift.
 */
export function distinctiveBigrams(questions: TrackedQuestion[]): Set<string>[] {
  const all = questions.map((q) => bigrams(`${q.title} ${q.prompt}`));

  const seen = new Map<string, number>();
  for (const set of all) for (const g of set) seen.set(g, (seen.get(g) ?? 0) + 1);

  return all.map(
    (set) => new Set([...set].filter((g) => (seen.get(g) ?? 0) === 1 && !BOILERPLATE.has(g))),
  );
}

/** A bare interjection straight before the ordinal: "Alright, second question." */
const LEAD_INS = new Set(['alright', 'okay', 'ok', 'right', 'great', 'good', 'perfect', 'fine']);

/**
 * Determines whether the ordinal at `i` announces moving to another question,
 * rather than referring to code issues ("a second problem with that loop").
 */
function announcesMove(w: string[], i: number): boolean {
  const near = w.slice(Math.max(0, i - 3), i).join(' ');
  const far = w.slice(Math.max(0, i - 6), i).join(' ');
  const after = w.slice(i + 2, i + 4).join(' ');
  const prev = w[i - 1] ?? '';
  return (
    /\b(now|next|onto|on to|turn to|move|moving|movin|start|begin|proceed)\b/.test(near) ||
    /(^|\s)(here s|here is|heres)( the| our)?$/.test(near) ||
    /(^|\s)for the$/.test(near) ||
    prev === 'our' ||
    LEAD_INS.has(prev) ||
    /^(is about|is called|asks you|asks us|today)\b/.test(after) ||
    /\b(let s|lets) (move|go|turn|start|begin|look at|do|try|take|tackle)\b/.test(far) ||
    /\b(move|moving|movin) (on )?(to|onto)\b/.test(far)
  );
}

export class QuestionTracker {
  /** Word pairs unique to each question WITHIN this round. */
  private readonly distinctive: Set<string>[];
  /** Titles as ordered words, for contiguous phrase matching in `announcedIndex`. */
  private readonly titleWords: string[][];
  private window = '';
  private idx = 0;

  constructor(private readonly questions: TrackedQuestion[]) {
    this.distinctive = distinctiveBigrams(questions);
    this.titleWords = questions.map((q) => norm(q.title).split(' ').filter(Boolean));
  }

  get index() {
    return this.idx;
  }

  get current(): TrackedQuestion | undefined {
    return this.questions[this.idx];
  }

  at(index: number): TrackedQuestion | undefined {
    return this.questions[index];
  }

  /** -1 when the id is not one of this round's questions. */
  indexOfId(id: string): number {
    return this.questions.findIndex((q) => q.id === id);
  }

  byId(id: string): TrackedQuestion | undefined {
    return this.questions.find((q) => q.id === id);
  }

  get length() {
    return this.questions.length;
  }

  /** Moves the round by hand. Returns false if the index is not a real question. */
  select(index: number): boolean {
    if (index < 0 || index >= this.questions.length || index === this.idx) return false;
    this.idx = index;
    this.window = '';
    return true;
  }

  /**
   * One final output fragment; returns the new index when the round moved.
   * Called per fragment, so no model call and nothing awaited.
   */
  observe(text: string): number | null {
    if (this.questions.length < 2) return null;

    this.window = `${this.window} ${text}`.slice(-WINDOW_CHARS);
    const spoken = bigrams(this.window);
    if (!spoken.size) return null;

    const hits = this.distinctive.map((set) => {
      let n = 0;
      for (const g of set) if (spoken.has(g)) n++;
      return n;
    });

    // Worth more than the statement: it arrives BEFORE the problem is read, so
    // the editor switches while the candidate is still being told.
    const announced = this.announcedIndex();

    let best = -1;
    let bestHits = 0;
    let runnerUp = 0;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i]! > bestHits) {
        runnerUp = bestHits;
        bestHits = hits[i]!;
        best = i;
      } else if (hits[i]! > runnerUp) {
        runnerUp = hits[i]!;
      }
    }

    const target =
      announced !== null && announced !== this.idx ? announced
      : best > this.idx && bestHits >= MIN_HITS && bestHits >= runnerUp + WIN_MARGIN ? best
      : null;

    // Forward only: going back is the candidate's act, in the UI.
    if (target === null || target <= this.idx) return null;

    this.idx = target;
    this.window = '';
    return target;
  }

  /**
   * Identifies when the interviewer names a question by ordinal or title.
   * The latest match in the window takes precedence.
   */
  private announcedIndex(): number | null {
    const w = norm(this.window).split(' ').filter(Boolean);

    /** Latest match wins, so track the position alongside the index. */
    let at = -1;
    let found: number | null = null;
    const offer = (pos: number, idx: number) => {
      if (idx < this.questions.length && pos >= at) {
        at = pos;
        found = idx;
      }
    };

    for (let i = 0; i < w.length; i++) {
      const word = w[i]!;
      // "question two" / "problem three"
      if (word === 'question' || word === 'problem') {
        const n = ORDINALS[w[i + 1] ?? ''];
        if (n !== undefined) offer(i, n);
      }
      // "the second question", only when a move is being announced: "there's a
      // second problem with that loop" is a remark about the code.
      const n = ORDINALS[word];
      if (n !== undefined && (w[i + 1] === 'question' || w[i + 1] === 'problem') && announcesMove(w, i)) {
        offer(i, n);
      }
    }

    // A title read aloud, as a contiguous phrase so its position competes with
    // the ordinals above.
    for (let qi = 0; qi < this.titleWords.length; qi++) {
      const title = this.titleWords[qi]!;
      if (title.length < 2) continue;
      for (let i = 0; i + title.length <= w.length; i++) {
        let hit = true;
        for (let k = 0; k < title.length; k++) {
          if (w[i + k] !== title[k]) {
            hit = false;
            break;
          }
        }
        if (hit) offer(i, qi);
      }
    }

    return found;
  }
}
