import { prematureAdvance } from '../advance-guard';
import { norm } from '../text-norm';
import type { CheckContext } from './effects';

/**
 * Asking whether a problem is finished. Normalised, so "you're" and "you are"
 * are one pattern; only in a sentence that asks, so "let's move on to question
 * two" — a move, which `AdvanceCheck` judges — is not one.
 */
const WRAP_UP_ASKS: readonly RegExp[] = [
  /\b(?:ready|want|like) to move on\b/,
  /\bmove on to (?:the next|question)\b/,
  /\bshall we move on\b/,
  /\bhappy with (?:this|that|your|the) (?:solution|implementation|code|answer|approach|one)\b/,
  /\b(?:are you|youre) (?:done|finished) with (?:this|that|the|your) (?:problem|question|one|solution|code)\b/,
];

/** The asking sentence, or null. */
export function findWrapUpAsk(turn: string): string | null {
  for (const raw of turn.split(/(?<=[.!?])\s+/)) {
    const s = raw.trim();
    if (!s.includes('?')) continue;
    const n = norm(s, { joinContractions: true, keepQuestionMarks: true });
    if (WRAP_UP_ASKS.some((re) => re.test(n))) return s.slice(0, 200);
  }
  return null;
}

/**
 * Detects the interviewer asking if a problem is finished while the editor is still unstarted.
 *
 * Prevents premature wrap-up questions before code has been written.
 * Only checked when the editor holds starter code and the turn did not already advance questions.
 */
export class WrapUpCheck {
  private readonly corrected = new Set<string>();

  constructor(private readonly ctx: CheckContext) {}

  judge() {
    const { state, effects, sessionId } = this.ctx;
    if (effects.ended()) return;

    const turn = state.unjudged;
    if (!turn) return;
    const id = state.turnQuestionId;
    if (!id || id !== state.currentQuestionId || this.corrected.has(id)) return;

    const ask = findWrapUpAsk(turn);
    if (!ask) return;
    const why = prematureAdvance({
      code: state.codeByQuestion.get(id),
      starters: state.starters[id] ?? [],
      sinceQuestion: state.candidateSinceQuestion,
      lastTurn: state.candidateTurn,
    });
    if (why !== 'nothing_written') return;

    this.corrected.add(id);
    this.ctx.record('premature_wrapup', ask, true);
    effects.log.warn(
      `session ${sessionId}: interviewer asked whether a problem is done with nothing written — ` +
        `correcting it. Turn: ${ask}`,
    );

    const tracker = state.questions;
    const which = tracker?.current ? `question ${tracker.index + 1}, "${tracker.current.title}"` : 'this problem';
    effects.fact(
      `You just asked the candidate: "${ask}" They have not finished ${which}: their editor ` +
        `for it still holds only the starter code — they have not written the solution yet. ` +
        `An approach and a complexity are not a finished problem. Do not ask whether they ` +
        `are happy with it, done with it or ready to move on until they have written their ` +
        `code and told you they are done; let them write it.`,
    );
  }
}
