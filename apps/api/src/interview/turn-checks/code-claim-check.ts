import { findCodeClaim } from '../code-claim-guard';
import type { CheckContext } from './effects';

/**
 * Descriptions of unwritten code corrected per round. Each is another note in
 * the model's context, and the slip is cheap next to the ones above.
 */
const CODE_CLAIM_CORRECTIONS = 2;

/**
 * The interviewer describing code the candidate has not written, checked
 * against the newest buffer it was actually sent. See `code-claim-guard.ts`.
 * Reads `aiTurn` without consuming it, so it must run before the repeat check.
 */
export class CodeClaimCheck {
  /** Code claims made, rationed by `CODE_CLAIM_CORRECTIONS`. */
  private claims = 0;

  constructor(private readonly ctx: CheckContext) {}

  judge() {
    const { state, effects, sessionId } = this.ctx;
    if (effects.ended()) return;

    const turn = state.unjudged;
    if (!turn) return;
    const id = state.currentQuestionId;
    if (!id) return;

    const claim = findCodeClaim(turn, state.codeByQuestion.get(id));
    if (!claim) return;

    this.claims += 1;
    const corrected = this.claims <= CODE_CLAIM_CORRECTIONS;
    this.ctx.record('code_claim', claim.quote, corrected);
    effects.log.warn(
      `session ${sessionId}: interviewer described code that is not in the editor ` +
        `(${claim.missing}, ${this.claims} this round) — ` +
        `${corrected ? 'correcting it' : 'not correcting again'}. Turn: ${claim.quote}`,
    );
    if (!corrected) return;

    // A fact, not an urgent note: nothing needs saying aloud, and a reply
    // requested now would talk over a candidate who is typing.
    effects.fact(
      `You just told the candidate: "${claim.quote}" Their editor, as last sent to you, has ` +
        `no ${claim.missing} in it. You described code that is not there — most likely ` +
        `something they said they were ABOUT to write. Describe only what the editor ` +
        `actually contains. If they are still typing, let them keep going without comment.`,
    );
  }
}
