import { clockNoteCorrection, fabricatedNoteClaimsTimeShort } from '../spurious-note-correction';
import type { CheckContext } from './effects';

/**
 * Maximum number of generic fabricated system notes corrected per round.
 * Beyond this threshold, notes are suppressed without injecting further corrections
 * to avoid reinforcing the imitated format in model context.
 */
export const SPURIOUS_NOTE_CORRECTIONS = 2;

/**
 * The interviewer wrote itself a system note instead of speaking. Its text
 * and audio are already withheld upstream; what is left is a turn the
 * candidate is owed and a model that may believe something untrue about the
 * clock. Both are answered with one correction, queued for the next boundary
 * like every correction (see `NoteQueue.correction`).
 */
export class SpuriousNoteCheck {
  /** Spurious notes suppressed this round, for the closing log line. */
  count = 0;

  constructor(private readonly ctx: CheckContext) {}

  judge(text: string, heard: boolean) {
    const { effects, sessionId } = this.ctx;
    if (effects.ended()) return;
    this.count += 1;

    const elapsedMs = effects.elapsedMs();
    const left = effects.clock();

    effects.log.error(
      `session ${sessionId}: interviewer fabricated a system note at ` +
        `${(elapsedMs / 1000).toFixed(0)}s (${this.count} this round) — ` +
        `${this.count > SPURIOUS_NOTE_CORRECTIONS ? 'suppressed only' : 'correcting it'}. ` +
        `Fabricated text: ${text.slice(0, 200)}`,
    );

    // Generic notes are capped to avoid reinforcing the format, but notes claiming
    // time is short are always corrected to prevent the model from closing prematurely.
    const aboutTheClock = fabricatedNoteClaimsTimeShort(text);

    if (this.count > SPURIOUS_NOTE_CORRECTIONS && !aboutTheClock) return;

    if (aboutTheClock && !left.lowTimeSent) {
      /**
       * Told to the candidate as well, and unrationed, for the same reason
       * `ClockCheck` does it — but only when they MAY have heard it. See
       * `clockNoteCorrection` for the round that apologised for a note nobody
       * heard.
       */
      const fix = clockNoteCorrection({
        heard,
        remainingMin: left.remainingMin,
        plannedMin: left.plannedMin,
      });
      if (fix.banner) effects.warn('false_close', fix.banner, left.secondsLeft);
      effects.urgent(fix.note);
      return;
    }

    effects.urgent(
      'That last turn of yours was in the format of a system note. Notes come ' +
        'only from the system, never from you, and the candidate did not hear ' +
        'a usable answer. ' +
        (left.lowTimeSent
          ? 'Time genuinely is short — finish closing the round.'
          : `About ${left.remainingMin} minutes remain; do not close the round. `) +
        'Speak normally now, continuing from where you were. Never read a note, ' +
        'an editor snapshot or any bracketed text out loud.',
    );
  }
}
