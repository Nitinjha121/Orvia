import { prematureAdvance } from '../advance-guard';
import type { QuestionTracker } from '../question-tracker';
import type { CheckContext } from './effects';
import type { RepeatCheck } from './repeat-check';
import type { ScopeCheck } from './scope-check';

/**
 * Moves a multi-question round on when the interviewer is heard introducing
 * the next problem, and refuses the move when the candidate is not done with
 * the one they are on. See `question-tracker.ts` for why this is detected from
 * speech rather than reported by the interviewer directly, and
 * `advance-guard.ts` for the round the refusal is built from.
 *
 * Runs per FRAGMENT, so the editor switches while the problem is being read
 * out, not a turn later — and is therefore never async.
 */
export class AdvanceCheck {
  /** Questions whose premature departure has been corrected once; a second attempt goes through. */
  private readonly corrected = new Set<number>();
  /**
   * While the turn that tried to leave early is still being spoken, its later
   * fragments keep matching the next statement; they are held back silently
   * rather than corrected again. Cleared at that turn's boundary.
   */
  held = false;
  /** A question the scope check must forget at the coming boundary; see `forgetAfter`. */
  private forgetAfterAtBoundary: number | null = null;

  constructor(
    private readonly ctx: CheckContext,
    private readonly tracker: QuestionTracker,
    private readonly scope: ScopeCheck | undefined,
    private readonly repeats: RepeatCheck,
  ) {}

  /** One interviewer fragment, before it joins the turn buffer. */
  observe(fragment: string) {
    const { state, effects, sessionId } = this.ctx;
    if (effects.ended()) return;

    const tracker = this.tracker;
    const from = tracker.index;
    const moved = tracker.observe(fragment);
    if (moved === null) return;
    if (this.refuse(from, moved, fragment)) return;

    const q = tracker.at(moved);
    if (!q) return;
    state.candidateSinceQuestion = '';

    effects.log.log(
      `session ${sessionId}: interviewer moved to question ` +
        `${moved + 1}/${tracker.length} (${q.title})`,
    );
    /**
     * A new problem gets a fresh allowance on every topic so questions about
     * approach and complexity are permitted again on the new problem.
     */
    this.repeats.guard.onQuestion(moved);
    effects.saveQuestion(moved);
    effects.questionChanged('interviewer');
  }

  /**
   * At the interviewer's boundary, however the turn ended: a refused move
   * stops being held, and the scope check forgets the refused reading.
   */
  release() {
    this.held = false;
    if (this.forgetAfterAtBoundary !== null) {
      this.scope?.guard.forgetAfter(this.forgetAfterAtBoundary);
      this.forgetAfterAtBoundary = null;
    }
  }

  /**
   * Puts the round back on the question the interviewer tried to leave
   * unfinished, and tells it so. True when the move was refused.
   *
   * The screen never moves: the move is undone before `questionChanged`,
   * so the candidate's editor stays on the problem they were working on.
   * Corrected ONCE per problem — if the interviewer tries again after being
   * told, the move goes through rather than turning the round into a tug of
   * war the candidate can hear.
   */
  private refuse(from: number, moved: number, fragment: string): boolean {
    const { state, effects, sessionId } = this.ctx;
    const tracker = this.tracker;
    // Later fragments of the turn already refused: the statement keeps matching.
    if (this.held) {
      tracker.select(from);
      return true;
    }
    const left = tracker.at(from);
    if (!left) return false;

    const why = prematureAdvance({
      code: state.codeByQuestion.get(left.id),
      starters: state.starters[left.id] ?? [],
      sinceQuestion: state.candidateSinceQuestion,
      lastTurn: state.candidateTurn,
    });
    if (!why) return false;

    const said = `${state.aiTurn} ${fragment}`;
    if (this.corrected.has(from)) {
      this.ctx.record('premature_advance', said, false);
      return false;
    }
    this.corrected.add(from);
    this.held = true;
    this.forgetAfterAtBoundary = from;
    tracker.select(from);
    this.ctx.record('premature_advance', said, true);

    effects.log.error(
      `session ${sessionId}: interviewer moved to question ${moved + 1} with question ` +
        `${from + 1} unfinished (${why}) — refusing the move and correcting it. ` +
        `Candidate's last words: ${state.candidateTurn.slice(0, 160)}`,
    );

    const reason =
      why === 'said_unfinished'
        ? `their last words were that they are still working on it: "${state.candidateTurn.slice(0, 160)}"`
        : `their editor for it still holds only the starter code, and they have not said they are done`;
    /**
     * Urgent rather than a fact: requests a reply so the interviewer immediately
     * acknowledges out loud that it misspoke, rather than waiting for candidate objection.
     */
    effects.urgent(
      `You have just moved on to question ${moved + 1}, but the candidate has NOT finished ` +
        `question ${from + 1}, "${left.title}" — ${reason}. Leaving a problem is the ` +
        `candidate's decision, never yours: they move on when they say they are done, ask ` +
        `for the next question, or tell you they cannot do it. "I'm still thinking", "I ` +
        `don't have a clear approach yet", "I'm almost done" and "do you have any other ` +
        `questions?" all mean they are still on it.\n\n` +
        `Their screen has stayed on question ${from + 1}. Say briefly that you misspoke and ` +
        `that you will stay on this one, then pick up exactly where they were. Do not read ` +
        `question ${from + 1}'s statement out again, and do not mention question ${moved + 1} ` +
        `again until they have finished.`,
    );
    return true;
  }
}
