import type { GuardEvent } from '@orvia/shared';
import type { TrackedQuestion } from '../question-tracker';
import type { CheckContext, RoundEffects } from './effects';
import { RoundState } from './round-state';
import { ClockCheck } from './clock-check';
import { ScopeCheck } from './scope-check';
import { CodeClaimCheck } from './code-claim-check';
import { RepeatCheck } from './repeat-check';
import { AdvanceCheck } from './advance-check';
import { MaterialNote } from './material-note';
import { SpuriousNoteCheck } from './spurious-note-check';
import { InventedMarkupCheck } from './invented-markup-check';
import { WrapUpCheck } from './wrap-up-check';

/**
 * Coordinates all speech and turn checks on interviewer utterances.
 *
 * Runs synchronously in the transcript-fragment handler so turns remain strictly
 * ordered. Detected defects are corrected upstream and logged for evaluation.
 */
export class TurnChecks {
  readonly state: RoundState;
  /** Guard firing events persisted at the end of the round for evaluation. */
  readonly guardLog: GuardEvent[] = [];

  readonly clock: ClockCheck;
  readonly code: CodeClaimCheck;
  readonly repeat: RepeatCheck;
  readonly spurious: SpuriousNoteCheck;
  readonly invented: InventedMarkupCheck;
  /** DSA rounds only: the bank's questions are what they check against. */
  readonly scope?: ScopeCheck;
  readonly material?: MaterialNote;
  readonly wrapUp?: WrapUpCheck;
  /** Rounds of more than one question only. */
  readonly advance?: AdvanceCheck;

  private readonly effects: RoundEffects;

  constructor(o: {
    sessionId: string;
    mode: string;
    questionIds: string[];
    /** The bank questions, DSA only; empty for every other mode. */
    questions: TrackedQuestion[];
    starters: Record<string, string[]>;
    effects: RoundEffects;
  }) {
    this.state = new RoundState(o.questionIds, o.starters, o.questions);
    this.effects = o.effects;
    const ctx: CheckContext = {
      sessionId: o.sessionId,
      state: this.state,
      effects: o.effects,
      record: (kind, said, corrected) =>
        this.guardLog.push({
          atMs: Math.max(0, Math.round(o.effects.elapsedMs())),
          kind,
          said: said.trim().slice(0, 300),
          corrected,
        }),
    };
    this.clock = new ClockCheck(ctx);
    this.code = new CodeClaimCheck(ctx);
    this.repeat = new RepeatCheck(ctx, o.mode);
    this.spurious = new SpuriousNoteCheck(ctx);
    this.invented = new InventedMarkupCheck(ctx);
    if (o.questions.length) {
      this.scope = new ScopeCheck(ctx, o.questions);
      this.material = new MaterialNote(ctx);
      this.wrapUp = new WrapUpCheck(ctx);
    }
    if (this.state.questions) {
      this.advance = new AdvanceCheck(ctx, this.state.questions, this.scope, this.repeat);
    }
  }

  /** One fragment of the interviewer's speech, as transcribed. */
  interviewerFragment(text: string) {
    if (!this.state.aiTurn) this.state.turnQuestionId = this.state.currentQuestionId;
    // Before it joins the buffer: a refused move quotes the turn so far.
    this.advance?.observe(text);
    this.state.aiTurn = `${this.state.aiTurn} ${text}`.trim();
  }

  /** One fragment of the candidate's speech, as transcribed. */
  candidateFragment(text: string) {
    // The candidate answering — or refusing — closes the topic just asked.
    this.repeat.guard.observeCandidate(text);
    this.state.noteCandidate(text);
    this.material?.check();
  }

  /**
   * Evaluates checks at turn boundaries (`turnComplete` or `interrupted`).
   *
   * Clock, scope, code, and wrap-up checks run on both clean completion and
   * candidate interruption. The repeat check runs on clean completion when the
   * full turn text is available.
   */
  boundary(how: 'turnComplete' | 'interrupted') {
    this.clock.judge();
    this.scope?.judge(how === 'interrupted' ? { cutOff: true } : {});
    this.code.judge();
    if (!this.advance?.held) this.wrapUp?.judge();
    if (how === 'interrupted') this.state.aiTurnJudged = this.state.aiTurn.length;
    else this.consumeTurn();
    this.closeInterviewerTurn();
  }

  /** The candidate moved the round to another question by hand. Returns the question, or null if nothing moved. */
  candidateSelected(index: number) {
    const tracker = this.state.questions;
    if (!tracker) return null;
    const from = tracker.index;
    if (!tracker.select(index)) return null;
    const q = tracker.current;
    if (!q) return null;
    this.state.candidateSinceQuestion = '';
    // Going back makes the next statement's reading its first real one again.
    if (tracker.index < from) this.scope?.guard.forgetAfter(tracker.index);
    // Forward moves give the new problem its own allowance; a BACKWARD move is
    // ignored by `onQuestion`, so flipping back to question one cannot hand its
    // spent topics a second round of asks.
    this.repeat.guard.onQuestion(tracker.index);
    return q;
  }

  /** The interviewer wrote markup into its transcript; the live session has already removed it. */
  inventedMarkup(span: string) {
    this.invented.judge(span);
  }

  /** The interviewer wrote itself a system note; the live session has already withheld it. */
  spuriousNote(text: string, heard: boolean) {
    this.spurious.judge(text, heard);
  }

  private consumeTurn() {
    const turn = this.state.aiTurn;
    this.state.aiTurn = '';
    this.state.aiTurnJudged = 0;
    // A refused move was another problem's statement; its questions do not count
    // against the current problem's repeat allowance.
    if (!turn || this.effects.ended() || this.advance?.held) return;
    this.repeat.judge(turn);
  }

  /**
   * What ends with every interviewer turn, however it ended: the candidate's
   * next words start a new turn, and a refused move stops being held.
   */
  private closeInterviewerTurn() {
    this.state.candidateTurnClosed = true;
    if (this.advance?.held) {
      // A barged turn keeps its buffer for the next `turnComplete`; this one's
      // must not reach the repeat check there either.
      this.state.aiTurn = '';
      this.state.aiTurnJudged = 0;
    }
    this.advance?.release();
  }
}
