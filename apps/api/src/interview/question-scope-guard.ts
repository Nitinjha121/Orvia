import { bigrams, distinctiveBigrams, norm, type TrackedQuestion } from './question-tracker';

/**
 * Prevents the interviewer from going wider (inventing a question not in the round)
 * or backward (re-reading previously finished problems or re-introducing the current one).
 * Cues are matched on `norm(..., { joinContractions: true })`.
 */

/**
 * A move to a DIFFERENT problem. Each names a question or problem: a bare
 * "let's move on" is said constantly to move WITHIN one ("…to the complexity").
 */
const NEXT_PROBLEM_CUES: RegExp[] = [
  /\b(next|another|second|third|fourth|new|following) (question|problem)\b/,
  /\b(move|moving|movin) (on )?to (the |a |our )?(next|another|second|third|new)\b/,
  /\b(heres|here is|try|tackle|do) (another|the next|a new) (one|question|problem)\b/,
  /\blets (try|do|tackle) (another|a (new|different))\b/,
  /\bon to the (next|second|third)\b/,
];

/**
 * "Given ..., return ...": detects when an interviewer turn states a problem.
 */
const STATEMENT_SHAPE = /\bgiven\b[\s\S]{0,200}?\b(return|find|determine|output|print|compute)\b/i;

/**
 * Distinctive pairs a stated problem must share with a round question to be
 * recognized as belonging to the round.
 */
const MIN_OWN_HITS = 2;

/** Words a stated problem needs before it is treated as a statement at all. */
const MIN_STATEMENT_WORDS = 10;

/**
 * Distinctive pairs threshold separating re-reading a finished problem from
 * casually referencing a prior problem during follow-up questions.
 */
const MIN_REREAD_HITS = 6;

/**
 * A wider search window for re-reading detection where the return clause
 * appears further into the statement.
 */
const REREAD_SHAPE = /\bgiven\b[\s\S]{0,400}?\b(return|find|determine|output|print|compute)\b/i;

/**
 * Threshold for an unshaped or paraphrased re-read.
 */
const MIN_REREAD_HITS_UNSHAPED = MIN_REREAD_HITS * 2;

/**
 * Detects an explicit announcement to move to a question, as opposed to
 * re-reading upon candidate request. The movement verb is the key signal.
 */
const MOVE_ANNOUNCEMENT: RegExp[] = [
  /\b(move|moving|movin) (on )?to\b/,
  /\bon to the (next|second|third|fourth|fifth)\b/,
  /\b(next|second|third|fourth|fifth|another|new) (question|problem)\b/,
  /\blets (start|begin) with (question|the)\b/,
];

/**
 * Share of a statement's distinctive pairs that makes a cut-off reading count
 * as delivered.
 */
const MOSTLY_HEARD = 0.7;

export type ScopeVerdict = {
  /** Why it fired, for the log and for the note. */
  reason:
    | 'announced_next'
    | 'stated_foreign_problem'
    | 'restated_finished_problem'
    | 'reintroduced_current_problem';
  /** The offending text, trimmed for logging. */
  quote: string;
  /** How many times this round, so a repeat can be told off harder. */
  count: number;
  /** For the backward reasons: the problem read out again, named in the note. */
  question?: TrackedQuestion;
};

export class QuestionScopeGuard {
  private readonly distinctive: Set<string>[];
  /**
   * Statements already read out. Not "questions moved past": a re-introduction
   * of the current problem never moves the tracker.
   */
  private readonly presented = new Set<number>();
  private count = 0;
  /** Turns already ruled on, so one turn cannot be counted twice. */
  private lastQuote = '';

  constructor(private readonly questions: TrackedQuestion[]) {
    this.distinctive = distinctiveBigrams(questions);
  }

  /**
   * Forgets every statement after `idx`, for a round that has moved BACK to it
   * — by the candidate's hand, or by refusing a premature move. Reading the
   * next problem again when the round genuinely reaches it is its first real
   * introduction, and without this it would be corrected as a re-introduction.
   */
  forgetAfter(idx: number) {
    for (const q of [...this.presented]) if (q > idx) this.presented.delete(q);
  }

  /** True when there is genuinely no question after the current one. */
  private onLastQuestion(currentIdx: number): boolean {
    return currentIdx >= this.questions.length - 1;
  }

  /** One completed interviewer turn, at the boundary, like `RepeatGuard`. */
  observe(turn: string, currentIdx: number, opts: { cutOff?: boolean } = {}): ScopeVerdict | null {
    const text = turn.trim();
    if (!text || text === this.lastQuote) return null;

    const again = this.askedAgain(text, currentIdx, opts.cutOff === true);
    const reason = again ? again.reason
      : this.onLastQuestion(currentIdx) ? this.classify(text)
      : null;
    if (!reason) return null;

    this.lastQuote = text;
    this.count += 1;
    return {
      reason,
      quote: text.slice(0, 240),
      count: this.count,
      ...(again ? { question: again.question } : {}),
    };
  }

  /**
   * Detects whether a statement repeats a finished problem or re-introduces
   * the current problem with a spurious move announcement.
   */
  private askedAgain(
    text: string,
    currentIdx: number,
    cutOff: boolean,
  ): { question: TrackedQuestion; reason: ScopeVerdict['reason'] } | null {
    if (norm(text).split(' ').filter(Boolean).length < MIN_STATEMENT_WORDS) return null;

    // Which of the round's problems is being read out, if any?
    const spoken = bigrams(text);
    let best = -1;
    let bestHits = 0;
    for (let q = 0; q < this.distinctive.length; q++) {
      let hits = 0;
      for (const g of spoken) if (this.distinctive[q]!.has(g)) hits++;
      if (hits > bestHits) [best, bestHits] = [q, hits];
    }
    const shaped = REREAD_SHAPE.test(text);
    if (best < 0 || bestHits < (shaped ? MIN_REREAD_HITS : MIN_REREAD_HITS_UNSHAPED)) return null;

    const seenBefore = this.presented.has(best);
    // A statement cut off early by a barge-in was never presented; its restart
    // is the first full reading. Only statements heard past MOSTLY_HEARD count as presented.
    const heard = this.distinctive[best]!.size
      ? bestHits / this.distinctive[best]!.size
      : 0;
    if (!cutOff || heard >= MOSTLY_HEARD) this.presented.add(best);

    if (best < currentIdx) {
      return { question: this.questions[best]!, reason: 'restated_finished_problem' };
    }
    const n = norm(text, { joinContractions: true });
    if (seenBefore && MOVE_ANNOUNCEMENT.some((re) => re.test(n))) {
      return { question: this.questions[best]!, reason: 'reintroduced_current_problem' };
    }
    return null;
  }

  private classify(text: string): ScopeVerdict['reason'] | null {
    // Cheapest first, and the least ambiguous: it said "the next question"
    // when there is no next question.
    const n = norm(text, { joinContractions: true });
    if (NEXT_PROBLEM_CUES.some((re) => re.test(n))) return 'announced_next';

    if (!STATEMENT_SHAPE.test(text)) return null;
    const words = norm(text).split(' ').filter(Boolean);
    if (words.length < MIN_STATEMENT_WORDS) return null;

    // Any question, not only the current one: looking back is legitimate.
    const spoken = bigrams(text);
    const belongs = this.distinctive.some((set) => {
      let hits = 0;
      for (const g of spoken) if (set.has(g) && ++hits >= MIN_OWN_HITS) return true;
      return false;
    });
    return belongs ? null : 'stated_foreign_problem';
  }
}
