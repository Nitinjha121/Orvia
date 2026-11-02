import { findClockClaim, findFalseClose } from '../clock-claim-guard';
import type { CheckContext } from './effects';
import { SPURIOUS_NOTE_CORRECTIONS } from './spurious-note-check';

/**
 * Closes of the round corrected upstream, counted apart from other clock claims.
 * A false close prematurely ends the round, so it receives a higher allowance than ordinary claims.
 */
const FALSE_CLOSE_CORRECTIONS = 4;

/**
 * Detects and corrects interviewer statements about the clock, which only the server tracks.
 *
 * Reads `aiTurn` without consuming it so subsequent scope and repeat checks receive the same text.
 * Corrected with an urgent note requesting an immediate verbal retraction.
 */
export class ClockCheck {
  /**
   * Times the interviewer made a claim about the clock the server never gave
   * it. Counted so the round can say so, and rationed like a spurious note.
   */
  claims = 0;
  /** Closes of the round, counted apart from `claims` — see `FALSE_CLOSE_CORRECTIONS`. */
  private falseCloses = 0;

  constructor(private readonly ctx: CheckContext) {}

  judge() {
    const { state, effects, sessionId } = this.ctx;
    if (effects.ended()) return;

    const turn = state.unjudged;
    if (!turn) return;
    const clock = effects.clock();

    // A claim asserts a specific time duration; a close attempts to conclude the round prematurely.
    const close = findFalseClose(turn, clock.lowTimeSent, state.candidateTurn);
    const claim = close ?? findClockClaim(turn, clock.lowTimeSent);
    if (!claim) return;

    this.claims += 1;
    if (close) this.falseCloses += 1;
    const corrected = close
      ? this.falseCloses <= FALSE_CLOSE_CORRECTIONS
      : this.claims - this.falseCloses <= SPURIOUS_NOTE_CORRECTIONS;
    this.ctx.record(close ? 'false_close' : 'clock_claim', claim.quote, corrected);

    effects.log.error(
      `session ${sessionId}: interviewer ${close ? 'closed the round' : 'claimed the clock'} at ` +
        `${(effects.elapsedMs() / 1000).toFixed(0)}s of ${clock.plannedMin}min ` +
        `(${this.claims} this round, ${clock.notesSent} clock note(s) sent) — ` +
        `${corrected ? 'correcting it' : 'not correcting again'}. ` +
        `Turn: ${claim.quote}`,
    );

    /**
     * The candidate is told EVERY time, unrationed and before the correction.
     * They have already heard "we're out of time" — correcting the model
     * upstream fixes the interviewer, not their belief that the round is over,
     * and someone who thinks it has ended stops the round themselves.
     */
    effects.warn(
      'false_close',
      `The interviewer said the round is ending — it isn't. About ${clock.remainingMin} minutes remain; keep going.`,
      clock.secondsLeft,
    );

    /**
     * Rationed like a fabricated note, and for the same reason: every
     * correction is another injected note for the model to imitate. Closes
     * get their own, larger allowance — see `FALSE_CLOSE_CORRECTIONS` — because
     * an uncorrected close is the one that ends the round.
     */
    if (!corrected) return;

    effects.urgent(
      `You just told the candidate something about the clock: "${claim.quote}" That is ` +
        `not true, and you are not in a position to know it. You have no clock. About ` +
        `${clock.remainingMin} of the round's ${clock.plannedMin} minutes ` +
        `remain, and you have NOT been told time is low — when you are, the note will ` +
        `say so in plain words.\n\n` +
        `The round is still running. If you implied it was ending, say briefly that you ` +
        `misspoke and that there is plenty of time left, then pick up exactly where you ` +
        `were — if the candidate was walking you through their code, let them finish and ` +
        `engage with it properly. Never state or imply the elapsed or remaining time ` +
        `again for the rest of this round.`,
    );
  }
}
