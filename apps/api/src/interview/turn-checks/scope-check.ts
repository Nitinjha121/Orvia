import { QuestionScopeGuard } from '../question-scope-guard';
import type { TrackedQuestion } from '../question-tracker';
import type { CheckContext } from './effects';

/**
 * Detects when the interviewer introduces a problem not assigned to the round.
 *
 * Reads `aiTurn` without consuming it so subsequent repeat checks see the full turn.
 * The turn is preserved in the transcript so evaluation reflects the candidate's actual experience.
 */
export class ScopeCheck {
  /**
   * Built for EVERY dsa round, including a one-question one — unlike the
   * tracker, which has nothing to track below two questions. The one-question
   * round is precisely where the interviewer invented a second problem.
   */
  readonly guard: QuestionScopeGuard;
  corrected = 0;

  constructor(
    private readonly ctx: CheckContext,
    questions: TrackedQuestion[],
  ) {
    this.guard = new QuestionScopeGuard(questions);
  }

  judge(opts: { cutOff?: boolean } = {}) {
    const { state, effects, sessionId } = this.ctx;
    if (effects.ended()) return;

    const turn = state.unjudged;
    if (!turn) return;

    const verdict = this.guard.observe(turn, state.questions?.index ?? 0, opts);
    if (!verdict) return;

    this.corrected += 1;
    const backward =
      verdict.reason === 'restated_finished_problem' ||
      verdict.reason === 'reintroduced_current_problem';
    this.ctx.record(backward ? 'scope_backward' : 'scope_wider', verdict.quote, true);
    const total = state.questions ? state.questions.length : 1;
    const title = state.questions?.current?.title;
    const { remainingMin, lowTimeSent } = effects.clock();

    effects.log.error(
      `session ${sessionId}: interviewer went outside the round's ${total} ` +
        `question(s) (${verdict.reason}, ${verdict.count} this round) — correcting it. ` +
        `Turn: ${verdict.quote}`,
    );

    /**
     * Re-reading a FINISHED problem is a different failure from inventing one
     * and needs a different note: the list is not the problem, so telling it
     * the list is closed would agree with what it just did. What it needs to
     * be told is that this particular problem is DONE, and where the time it
     * is trying to fill should actually go.
     */
    if (backward) {
      const named = verdict.question?.title;
      const current = verdict.reason === 'reintroduced_current_problem';
      effects.fact(
        (current
          ? `You have just announced a move to ${named ? named : 'a problem'} and read its ` +
            `statement out — but that is the problem the candidate is ALREADY on, and you ` +
            `have already given it to them once. You did not move anywhere. From their ` +
            `side you have just started the same question over while they were part way ` +
            `through answering it.\n\n`
          : `You have just read out ${named ? `${named}, ` : 'a problem '}which this ` +
            `candidate has ALREADY worked through and finished earlier in this round. ` +
            `They answered it, they wrote the code, and you moved on from it yourself. ` +
            `Asking for their approach to it again is the single most irritating thing ` +
            `you can do: it reads as not having listened to anything they said.\n\n` +
            `Their screen has not moved with you either — their heading and editor are ` +
            `still on ${title ?? 'the current problem'}, so there is nowhere for them to ` +
            `answer what you just asked, and their earlier answer is the one on their ` +
            `report.\n\n`) +
          `Do not read a problem statement out a second time, and do not announce a move ` +
          `you are not making. Never ask for an approach, a complexity or an ` +
          `implementation you have already been given.\n\n` +
          `Say briefly that you misspoke, then pick up from exactly where the candidate ` +
          `had got to. If you have run out of prepared material and time remains, that is ` +
          `normal and it is not a reason to go round again. Go DEEPER on ` +
          `${title ?? 'the problem you are on'}: ask for a cleaner implementation, change ` +
          `a constraint on that same problem, probe an edge case they have not covered, ` +
          `or ask them to trace their code on a small input. You may revisit a problem ` +
          `only to go FURTHER into it — by referring to what they already said about it, ` +
          `never by reading its statement out again.\n\n` +
          // Emphasize remaining time so having nothing prepared does not trigger early closing.
          (lowTimeSent
            ? `Time genuinely is short, so finish on the problem they are on.`
            : `About ${remainingMin} minutes of the round remain. Having nothing new ` +
              `prepared is never a reason to close: do not thank them, do not mention ` +
              `feedback, and do not say the round is ending — only a note from the system ` +
              `can end it. Keep going deeper until one does.`),
      );
      return;
    }

    /**
     * Names the failure as the interviewer's and says what it costs, because
     * a note that only states a preference gets ignored — the same lesson as
     * the second-tier repeat note.
     */
    const note =
      `There is no next question. This round has exactly ${total} ` +
      `problem${total === 1 ? '' : 's'} and you are on the last one. That list is ` +
      `CLOSED: the candidate chose it, and you were given every problem you are ` +
      `allowed to ask. You have just put a problem to them that is not on it.\n\n` +
      `This is not a small thing. The candidate's screen and code editor are built ` +
      `from that list, so there is no editor for your invented problem and nowhere ` +
      `for them to write an answer, and nothing they say about it can appear on ` +
      `their report. Telling them to reuse the previous editor destroys the work ` +
      `they already finished.\n\n` +
      `Say plainly and briefly that you misspoke and that there is no further ` +
      `problem` +
      (title ? `, then return to ${title}.` : `.`) +
      ` Never introduce a problem that was not given to you — not one you know, ` +
      `not a variation you invent, not "a quick extra". Time left on the clock is ` +
      `NEVER a reason to add a problem: go DEEPER on the problem you have, on its ` +
      `complexity, a cleaner implementation, its edge cases, or a changed ` +
      `constraint on that same problem.`;

    // A fact, not a snapshot: two scope failures are two different failures,
    // and either one losing a race with a keystroke is the correction lost.
    effects.fact(note);
  }
}
