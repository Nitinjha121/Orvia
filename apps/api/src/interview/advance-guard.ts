import { norm } from './text-norm';

/**
 * Guards against the interviewer prematurely advancing past an unfinished problem.
 *
 * Examines candidate turn statements and editor buffer contents to determine whether
 * the current question is still actively being worked on.
 */

/**
 * The candidate saying the problem is over for them: finished, a request for
 * the next one, or giving it up. Any of these licenses the move.
 */
const DONE: readonly RegExp[] = [
  /\b(?:i am|im|i m|we are|were) (?:done|finished)\b/,
  /\bdone with (?:this|the|my|that) (?:solution|problem|question|code|one|implementation)\b/,
  /\b(?:lets|we can|can we|shall we|should we|could we) (?:move on|go to the next|do the next|go ahead with the next)\b/,
  // Not "the next one": in narration that is the next interval or element.
  /\bnext (?:question|problem)\b/,
  /\bask me (?:the |your )?(?:next|question)\b/,
  /\bmove on to (?:the )?(?:next|question|problem|second|third|fourth|fifth)\b/,
  /\b(?:i cant|i cannot|i can not|i wont be able to) (?:do|solve|figure out|finish|complete) (?:this|it|the)\b/,
  /\b(?:i give up|skip (?:this|it|the question|this question|this one))\b/,
];

/**
 * The candidate saying they are still ON it. Read from their LATEST turn only:
 * "I am almost done" outranks an "I'm done" from ten minutes earlier.
 */
const UNFINISHED: readonly RegExp[] = [
  /\b(?:almost|nearly|not yet|not|isnt|is not) (?:done|finished|complete|completed)\b/,
  /\b(?:havent|have not|didnt|did not|werent|were not) (?:yet )?(?:finish(?:ed)?|complete(?:d)?|solve(?:d)?|writ(?:e|ten)|code(?:d)?|done|implement(?:ed)?)\b/,
  /\b(?:let me|i need to|i have to|i will|ill|i want to) (?:finish|complete)\b/,
  /\bstill (?:writing|working|coding|thinking|implementing|on (?:this|it|the))\b/,
  /\b(?:dont|do not) have (?:a |an )?(?:clear |proper |full )?(?:approach|solution|idea)\b/,
  /\b(?:im|i am|i m) (?:just )?thinking\b/,
  /\bthinking (?:through|about) (?:it|this|them|the problem)\b/,
  /\bgive me a (?:moment|minute|second|sec)\b/,
];

export type CandidateSignal = 'done' | 'unfinished' | null;

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  const n = norm(text, { joinContractions: true });
  return !!n && patterns.some((re) => re.test(n));
}

export function candidateSignal(text: string): CandidateSignal {
  if (matchesAny(text, UNFINISHED)) return 'unfinished';
  if (matchesAny(text, DONE)) return 'done';
  return null;
}

/** Lines that are never the candidate's own work, whatever the language. */
const SCAFFOLD =
  /^(?:#|\/\/|\/\*|\*|pass$|[{}()[\];]+$|class \w|public |private |protected |def \w|function \w|func \w|fn \w|impl |var \w+ = function|\/\*\*|\* @)/;

/** Minimum non-scaffold lines required to count as started code. */
const MIN_WORK_LINES = 2;

/**
 * Whether an editor buffer holds no work yet — nothing pushed, or only what the
 * starter skeleton already had. `starters` is every language's skeleton for the
 * question, because the candidate may have switched language.
 */
export function codeUnstarted(code: string | undefined, starters: readonly string[]): boolean {
  if (!code) return true;
  const given = new Set(
    starters.flatMap((s) => s.split('\n').map((l) => l.trim()).filter(Boolean)),
  );
  const work = code
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !given.has(l) && !SCAFFOLD.test(l));
  return work.length < MIN_WORK_LINES;
}

/**
 * Whether moving off this problem now is premature.
 *
 * The latest turn decides first: a candidate who says they are still on it is
 * still on it, whatever their editor holds. Otherwise an explicit "done" since
 * the problem began licenses the move, and without one an empty editor refuses
 * it. A problem with real code and no word either way is let go — the
 * interviewer judging that the candidate has finished is its job, and a wrong
 * correction here would drag them back to a problem they consider done.
 */
export function prematureAdvance(input: {
  code: string | undefined;
  starters: readonly string[];
  /** Everything the candidate has said since this problem became current. */
  sinceQuestion: string;
  /** The candidate's most recent turn. */
  lastTurn: string;
}): false | 'said_unfinished' | 'nothing_written' {
  const last = candidateSignal(input.lastTurn);
  if (last === 'unfinished') return 'said_unfinished';
  if (last === 'done' || matchesAny(input.sinceQuestion, DONE)) return false;
  return codeUnstarted(input.code, input.starters) ? 'nothing_written' : false;
}
