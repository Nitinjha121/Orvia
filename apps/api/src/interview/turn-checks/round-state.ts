import { QuestionTracker, type TrackedQuestion } from '../question-tracker';
import { codeUnstarted } from '../advance-guard';

/** The candidate's words kept per question, enough for several turns of an answer. */
const CANDIDATE_WINDOW_CHARS = 3_000;

/**
 * The part of the interviewer's turn buffer no boundary check has ruled on yet.
 *
 * Ensures that a barged-into turn is judged once at `onInterrupted`, and not
 * again when the next `turnComplete` finds the same text at the head of the buffer.
 */
export function unjudgedTail(turn: string, judgedChars: number): string {
  return turn.slice(Math.min(Math.max(0, judgedChars), turn.length)).trim();
}

/**
 * What the checks know about the conversation: whose turn said what, which
 * question the round is on, and what each editor holds. Written only by
 * `TurnChecks` and the gateway's editor push; every check reads it.
 */
export class RoundState {
  /**
   * Which question a multi-question round is on, and the detector that decides.
   *
   * Absent for single-question and non-DSA rounds, where there is nothing to
   * track. See `question-tracker.ts` for why this is heard rather than told.
   */
  readonly questions?: QuestionTracker;

  /**
   * The newest buffer per question, exactly as pushed to the interviewer. Held
   * here because `saveContext` is a database write and the checks that read it
   * run in the fragment handler, where nothing may be awaited.
   */
  readonly codeByQuestion = new Map<string, string>();

  /**
   * The interviewer's speech for the turn in progress.
   *
   * Accumulated from fragments synchronously rather than read from the database,
   * preventing race conditions where incoming fragments overtake earlier ones.
   */
  aiTurn = '';

  /**
   * How much of `aiTurn` the clock and scope checks have already ruled on.
   *
   * A barge-in is a boundary, so those two run at the barge-in as well — but
   * the repeat check still consumes the buffer only at `turnComplete`, so the
   * interrupted text is still there when that arrives and must not be judged a
   * second time. See `unjudgedTail`.
   */
  aiTurnJudged = 0;

  /** The question the round was on when the interviewer's current turn began. */
  turnQuestionId: string | undefined;

  /** The candidate's latest turn: everything they have said since the interviewer last finished one. */
  candidateTurn = '';
  /** Set at each interviewer boundary, so the next candidate words start a new `candidateTurn`. */
  candidateTurnClosed = false;
  /** What the candidate has said since the current question began, bounded. */
  candidateSinceQuestion = '';

  constructor(
    /** This round's question ids, the only ones a context push may file under. */
    readonly questionIds: string[],
    /** Every language's starter skeleton per question id; see `codeUnstarted`. */
    readonly starters: Record<string, string[]>,
    questions: TrackedQuestion[],
  ) {
    /**
     * Only built for a round that actually has questions to move between.
     * A single-question round has nothing to detect and must not pay for the
     * matching on every transcript fragment.
     */
    this.questions = questions.length > 1 ? new QuestionTracker(questions) : undefined;
  }

  /** The question the round is on, by the tracker or because there is only one. */
  get currentQuestionId(): string | undefined {
    return this.questions?.current?.id ?? (this.questionIds.length === 1 ? this.questionIds[0] : undefined);
  }

  /** Whether a question's editor still holds no work. See `codeUnstarted`. */
  editorUnstarted(id: string): boolean {
    return codeUnstarted(this.codeByQuestion.get(id), this.starters[id] ?? []);
  }

  /** The interviewer turn no boundary check has ruled on yet. */
  get unjudged(): string {
    return unjudgedTail(this.aiTurn, this.aiTurnJudged);
  }

  /**
   * A turn ends at the INTERVIEWER's boundary, not at its first fragment:
   * input transcription lands in a burst after the candidate stops, often
   * after the reply has begun, and that tail is still the same turn.
   */
  noteCandidate(text: string) {
    if (this.candidateTurnClosed) {
      this.candidateTurn = '';
      this.candidateTurnClosed = false;
    }
    this.candidateTurn = `${this.candidateTurn} ${text}`.trim();
    this.candidateSinceQuestion = `${this.candidateSinceQuestion} ${text}`.slice(-CANDIDATE_WINDOW_CHARS);
  }
}
