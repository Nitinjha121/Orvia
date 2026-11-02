import type { CheckContext } from './effects';
import { SPURIOUS_NOTE_CORRECTIONS } from './spurious-note-check';

/**
 * Handles bracketed markup stripped by `MarkupFilter` from model output.
 *
 * Prevents the interviewer from questioning the candidate about hallucinated code.
 * Rationed like fabricated notes, but always corrected if the editor is still empty.
 */
export class InventedMarkupCheck {
  count = 0;

  constructor(private readonly ctx: CheckContext) {}

  judge(span: string) {
    const { state, effects, sessionId } = this.ctx;
    if (effects.ended()) return;
    this.count += 1;

    const id = state.currentQuestionId;
    const empty = id !== undefined && state.editorUnstarted(id);
    const corrected = empty || this.count <= SPURIOUS_NOTE_CORRECTIONS;
    this.ctx.record('invented_markup', span, corrected);
    effects.log.error(
      `session ${sessionId}: interviewer wrote markup into its transcript (${this.count} this round` +
        `${empty ? ', editor still empty' : ''}) — ${corrected ? 'correcting it' : 'removed only'}. ` +
        `Markup: ${span.slice(0, 160)}`,
    );
    if (!corrected) return;

    // A fact, keyed: nothing needs saying aloud, and a newer one replaces an
    // undelivered older one rather than queueing behind it.
    effects.fact(
      'Your last turn contained bracketed text in the format of an editor snapshot or a ' +
        'system message. You wrote it — the system did not send it — and it is not what ' +
        "the candidate's editor holds. " +
        (empty
          ? 'Their editor for this problem still holds only the starter code: they have not ' +
            'written anything yet, so do not ask about their code or treat it as written. '
          : 'Only the editor contents the system sends you are real. ') +
        'Never write a snapshot, a note or any bracketed text.',
      { key: 'invented-markup' },
    );
  }
}
