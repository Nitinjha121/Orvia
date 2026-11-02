import { candidateSignal } from '../advance-guard';
import type { CheckContext } from './effects';

/**
 * Time left below which finishing the last problem is simply the end of the
 * round, and saying how much remains would only invite a close.
 */
const MATERIAL_NOTE_MIN_REMAINING_MIN = 4;

/**
 * Informs the interviewer when the candidate finishes the last problem with substantial
 * time remaining, directing it to probe deeper rather than closing early.
 */
export class MaterialNote {
  /** Whether the interviewer has been told how much time is left after the last problem. */
  private sent = false;

  constructor(private readonly ctx: CheckContext) {}

  /** After each candidate fragment. */
  check() {
    const { state, effects } = this.ctx;
    if (this.sent || effects.ended()) return;
    const clock = effects.clock();
    if (clock.lowTimeSent) return;
    const tracker = state.questions;
    if (tracker && tracker.index < tracker.length - 1) return;
    if (candidateSignal(state.candidateTurn) !== 'done') return;

    if (clock.remainingMin < MATERIAL_NOTE_MIN_REMAINING_MIN) return;
    this.sent = true;
    const title = tracker?.current?.title;
    effects.fact(
      `The candidate has finished the last problem on the list. About ${clock.remainingMin} of ` +
        `the round's ${clock.plannedMin} minutes remain, and the round ` +
        `goes on until a note tells you time is low. Running out of prepared material is ` +
        `normal and it is never a reason to close: do not thank them, do not mention ` +
        `feedback, and do not say the round is ending. Do not read any problem's statement ` +
        `out again. Spend the time going DEEPER on work they have already done` +
        (title ? `, starting with ${title}` : '') +
        `: ask them to trace their code on a small input, probe an edge case they have not ` +
        `covered, push on the complexity, ask for a cleaner or alternative implementation, ` +
        `or change a constraint on a problem they have already solved.`,
      { key: 'material' },
    );
  }
}
