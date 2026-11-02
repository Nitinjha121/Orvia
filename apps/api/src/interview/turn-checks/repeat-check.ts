import { RepeatGuard, PRESSURE_EXTRA_ASKS } from '../repeat-guard';
import type { CheckContext } from './effects';

/**
 * Prevents the interviewer from repeatedly probing topics it has already covered.
 *
 * Injects corrective notes when an ask count exceeds thresholds, stopping the
 * model from pestering the candidate on questions they have already answered or declined.
 */
export class RepeatCheck {
  /**
   * Counts what the interviewer has already asked, so it can be stopped when
   * it asks the same thing a third time.
   */
  readonly guard: RepeatGuard;
  /** Repeated asks corrected this round, for the closing log line. */
  corrected = 0;

  constructor(
    private readonly ctx: CheckContext,
    mode: string,
  ) {
    /**
     * An HR round is the one place where asking again after a deflection
     * is the exercise rather than the defect the guard exists to stop.
     * The scenario beats say "press once, then take the answer", so the
     * guard is given exactly one extra ask and still fires beyond it.
     */
    this.guard = new RepeatGuard(mode === 'hr' ? { extraAllowance: PRESSURE_EXTRA_ASKS } : {});
  }

  /** Judges a whole interviewer turn, already taken off the buffer by `TurnChecks`. */
  judge(turn: string) {
    const { effects, sessionId } = this.ctx;
    const verdict = this.guard.observe(turn);
    if (!verdict) return;

    this.corrected += 1;
    this.ctx.record('repeat_ask', turn, true);
    effects.log.warn(
      `session ${sessionId}: interviewer asked "${verdict.topic}" ` +
        `${verdict.count} times (${verdict.level}) — correcting it`,
    );

    /**
     * Two very different notes. A model that ignored the polite one is not
     * going to be moved by hearing it again, and the second names the failure
     * as the interviewer's rather than describing a preference.
     */
    const note =
      verdict.level === 'warn'
        ? `You have now asked about this ${verdict.count} times in this round. You ` +
          `first asked it as: "${verdict.firstAsked}" The candidate has given you ` +
          `whatever answer they are going to give — including "I don't know", "I ` +
          `haven't considered that", or declining it, all of which are answers and ` +
          `are final. This topic is CLOSED. Do not ask it again in any wording, do ` +
          `not rephrase it, and do not return to it later in the round. Acknowledge ` +
          `once, briefly, and ask about something you have not covered yet.`
        : `You have asked about this ${verdict.count} times and you were already ` +
          `told to stop. This is a serious failure on your part: it reads as not ` +
          `listening, it is the most irritating thing an interviewer can do, and a ` +
          `candidate who pushes back or asks to end the round is responding ` +
          `reasonably to YOUR behaviour. Stop entirely. Never mention this topic ` +
          `again for the rest of the round, in any form. Move to a completely ` +
          `different area now, or if there is nothing left to cover, say so and ` +
          `wait for the candidate.`;

    effects.fact(note);
  }
}
