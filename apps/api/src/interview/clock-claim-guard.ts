import { norm } from './text-norm';

/**
 * Detects unauthorized time and closing claims made by the interviewer.
 *
 * Only the server tracks official round time. Because model sense of elapsed time
 * can drift significantly, these patterns catch explicit claims about elapsed or
 * remaining time made before the server has signaled that time is low.
 */

/**
 * Spelled out as well as digits: the interviewer is told to say numbers as
 * words, and a digits-only pattern missed "we have about two minutes left",
 * the form that actually occurs.
 */
const NUM =
  '(?:\\d+|a|an|another|one|two|three|four|five|six|seven|eight|nine|ten|' +
  'eleven|twelve|fifteen|twenty|thirty|forty five|forty|fifty|sixty|' +
  'a few|a couple of|couple of|several)';

const SMALL = '(?:[1-9]|one|two|three|four|five|six|seven|eight|nine|a few|a couple of|couple of)';

/**
 * Explicit claims about ELAPSED or REMAINING time — never closing language, and
 * never a planned length. "We have about forty minutes for this round" is the
 * introduction stating the booking, not a claim that time is short, so a bare
 * "have N minutes" needs a remaining-time word (only, just, still, more, left).
 */
const CLOCK_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:out of|run(?:ning)? out of|short on|low on) time\b/,
  // Catch statements where "running low" introduces an early wrap-up.
  /\btime (?:is |s )?(?:running|getting) (?:low|short|out|tight)\b/,
  /\b(?:running|getting) (?:low|short|tight) on time\b/,
  /\b(?:pressed|tight) for time\b/,
  // "over" must not take an object: "if the response time is over two hundred
  // milliseconds" is a design constraint.
  /\btime (?:is|has) (?:almost |nearly )?(?:up|finished|over)\b(?! (?:a|an|the|some|\d+|one|two|three|five|ten|twenty|fifty|hundred|thousand|the limit|our limit)\b)/,
  // "times up" alone: "times over" is "n times over the array".
  /\btimes (?:almost |nearly )?up\b/,
  /\ball (?:the|of the) time (?:weve|ive|(?:we|i) (?:have|had|got))\b/,
  new RegExp(`\\b${NUM} (?:more )?(?:minutes?|hours?) (?:left|remaining|to go)\\b`),
  new RegExp(`\\b(?:only|just|still) (?:have|got|theres|there is|there are) (?:about |roughly |around )?${NUM} (?:more )?minutes?\\b`),
  new RegExp(`\\b(?:have|got|theres|there is|there are) (?:only|just) (?:about |roughly |around )?${NUM} (?:more )?minutes?\\b`),
  new RegExp(`\\b(?:have|got|theres|there is|there are) (?:about |roughly |around )?${NUM} more minutes?\\b`),
  // A SMALL quantity is a time-short claim with no remaining-time word ("we've
  // got a couple of minutes"); a booking is a round length, fifteen and up.
  new RegExp(`\\b(?:have|got|theres|there is|there are) (?:about |roughly |around )?${SMALL} minutes?\\b`),
  /\bat (?:the|that) (?:\w+ )?(?:minute|time|thirty|hour) ?mark\b/,
  /\b(?:weve|we have) been (?:going|at this) for\b/,
  /\b(?:weve|we have) used (?:up )?(?:all )?(?:our|the) time\b/,
  // The booking plus a claim about where the round is against it. The booking
  // alone is the introduction.
  /\b(?:round|session|interview) (?:is|was) scheduled for\b.{0,40}\b(?:and|so|but) (?:were|we are|weve|we have)\b.{0,15}\b(?:at|past|over|reached|hit|used)\b/,
  /\b(?:running|were|we are) (?:behind|over)(?: on| our)? time\b/,
];

/** The claim, as the sentence it was made in, for the log and the correction. */
export type ClockClaim = { quote: string };

/**
 * Transcription is unpunctuated often enough that the whole turn is sometimes
 * one "sentence", hence the length cap on the quote.
 */
function sentences(turn: string): string[] {
  return turn
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstMatch(turn: string, patterns: readonly RegExp[]): ClockClaim | null {
  for (const s of sentences(turn)) {
    // `?` kept so a sentence-final pattern cannot match a question ("do we
    // stop there?").
    const n = norm(s, { joinContractions: true, keepQuestionMarks: true });
    if (patterns.some((re) => re.test(n))) return { quote: s.slice(0, 200) };
  }
  return null;
}

/**
 * Whether this interviewer turn claims to know the clock. Once the server HAS
 * sent the low-time note the model has been told to close, so nothing fires.
 */
export function findClockClaim(turn: string, serverSaidTimeIsLow: boolean): ClockClaim | null {
  if (serverSaidTimeIsLow) return null;
  return firstMatch(turn, CLOCK_CLAIM_PATTERNS);
}

/**
 * Patterns matching phrases where the interviewer attempts to conclude the round prematurely.
 *
 * Before the server issues an official low-time note, ending the round is unauthorized
 * unless explicitly requested by the candidate.
 */
const THE_ROUND =
  '(?:(?:the|this|our|todays) (?:round|interview)(?! of| robin| trip)|(?:this|our|todays) session)';

/** Who closes a round out loud: the interviewer, never a loop or a pointer. */
const SPEAKER = '\\b(?:we|lets|i|ill|well|im|were)\\b(?: \\w+){0,3}?';

const CLOSING_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:stop(?:ping)?|end(?:ing)?|finish(?:ing)?|conclud(?:e|es|ed|ing)|clos(?:e|ing)(?: out)?|wrap(?:ping)?(?: up)?)\\b(?! of)(?: \\w+){0,2}? ${THE_ROUND}\\b`,
  ),
  // "That brings us to the end of the interview." The lead-in is required: "at
  // the end of the interview you'll get feedback" describes the round.
  new RegExp(`\\b(?:brings us to|thats|that is|this is|weve reached|we have reached|that marks|were at|we are at) the end of ${THE_ROUND}`),
  // "We'll stop here." — only at the END of the sentence, so "let's stop there
  // and look at your code" is a topic move.
  new RegExp(`${SPEAKER} (?:stop|wrap(?: things)? up|end|conclude|close)(?: it| things)? (?:here|there|now)(?: for today)?$`),
  // "Let's close the session." — a call or session only as the last words:
  // "we close the session when the user logs out" is system design.
  new RegExp(`${SPEAKER} (?:end|close|conclude|stop|wrap up)(?: out)? (?:the|this|our) (?:call|session)(?: here| now| for today)?$`),
  // "for now" is deliberately absent: "let's stop there for now and look at
  // your code" pauses a topic.
  /\b(?:stop|end|finish|conclude|wrap|leave it|call it)\b[a-z ]{0,20}\bfor today\b/,
  /\bcall it a day\b/,
  /\b(?:thats|this is) (?:all|it) (?:for|we have)\b[a-z ]{0,20}\b(?:today|(?:this|the) (?:round|interview))\b/,
  /\bproceeding with (?:closing|ending|concluding)\b/,
  new RegExp(`\\b${THE_ROUND} is (?:now )?(?:concluding|ending|over|complete|finished|done)\\b`),

  // The sign-off: thanks for ATTENDING rather than for an answer. Not "thanks
  // for joining" or "thanks for your time", which open a round as often as
  // they close it — a banner at t=0 saying the round is ending. Feedback
  // "at the end" is the introduction describing the round.
  /\bthanks?(?: you)?(?: so much| again)? for (?:coming in|participating|your participation)\b/,
  /^(?!.*\b(?:at the end|afterwards|after (?:the|this) (?:round|interview))\b).*\b(?:youll|you will) (?:receive|get) (?:the |your )?feedback\b/,
  /^(?!.*\b(?:at the end|afterwards|after (?:the|this) (?:round|interview))\b).*\bfeedback (?:report )?will (?:follow|be (?:provided|sent|shared))\b/,
];

/**
 * Checks whether this turn ends the round prematurely without server authorization
 * or candidate agreement.
 */
export function findFalseClose(
  turn: string,
  serverSaidTimeIsLow: boolean,
  candidateLastSaid = '',
): ClockClaim | null {
  if (serverSaidTimeIsLow || candidateOfferedToEnd(candidateLastSaid)) return null;
  return firstMatch(turn, CLOSING_PATTERNS);
}

/**
 * The candidate offering to END THE ROUND — not to finish a problem. "I am done
 * with this solution" and "let's move on" are about the question and must not
 * license a close.
 */
const OFFER_TO_END: readonly RegExp[] = [
  /\b(?:we can|we could|lets|shall we|should we|can we|could we|i would like to|id like to|i want to) (?:wrap(?: it| this| things)? up|call it a day|(?:end|stop|finish) (?:it )?(?:here|now|today|the (?:round|interview|session|call))|end it)\b/,
  // A bare "we can stop" only as the last words: "we can stop when the
  // pointers cross" is the algorithm.
  /\b(?:we can|we could|lets|shall we|should we|can we) (?:end|stop|finish)\??$/,
  /\b(?:thats|that is) (?:all|it) (?:from me|for me|for today)\b/,
  /\b(?:end|stop|finish) the (?:round|interview|session|call)\b/,
];

export function candidateOfferedToEnd(text: string): boolean {
  if (!text.trim()) return false;
  const n = norm(text, { joinContractions: true, keepQuestionMarks: true });
  return OFFER_TO_END.some((re) => re.test(n));
}
