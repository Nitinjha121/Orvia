import { norm } from '../interview/question-tracker';

/**
 * Classifies candidate turn intent to determine conversational floor state.
 *
 * Silence alone cannot distinguish thinking from a stalled session.
 * - `yield`: The candidate asked a question, checked line liveness, or said they are done.
 * - `hold`: The candidate asked for time ("give me a moment", "let me think").
 * - `neutral`: Ongoing narration or an answer without explicit floor handback.
 */

export type Floor = 'yield' | 'hold' | 'neutral';

/**
 * Matched on normalized text (lower-case, punctuation removed, contractions expanded).
 * Check-in phrases indicate line liveness and always hand the floor back.
 */
const CHECK_IN: RegExp[] = [
  /\bhello\b/,
  /\b(hear|hearing) me\b/,
  /\b(am i|i am) audible\b/,
  /\bplease respond\b/,
  /\b(not|seem to be|seems to be) responding\b/,
  /\b(you|anyone|anybody) (still )?there\b/,
  // Finished, and saying so — not a future promise ("once I am done") or
  // partial progress ("done with the base case").
  /(?<!\b(once|when|after|until|till|if|before) )\bi (m|am) (done|finished|ready)\b(?! with)/,
  /\bthat s (it|all|my (answer|solution|approach))\b/,
];

/**
 * An ASK is a request put to the interviewer — but "can I do better than n
 * squared? Yes, with a heap" is the same words put to themselves. So an ask
 * the candidate answers in the next sentence is not a handback (see
 * `ANSWERED`), and only REQUEST shapes count: "would you" alone also opens
 * "what would you return if it is empty? You'd return null".
 */
const ASK: RegExp[] = [
  /\b(can|could|would|will) you (please |kindly |just )?(give|tell|repeat|explain|clarify|confirm|provide|share|show|help|say|read|check|let|go over)\b/,
  /\b(do|did) you (have|want|need|think|agree|mean|mind|expect)\b/,
  /\bwhat do you (think|mean)\b/,
  /\bfrom you\b/,
  /\b(give|show|tell) me (an?|some|another|one more|the) (example|hint|test|input|sample|constraint|range|clarification|question)/,
  /\b(is|does) that (sound |look )?(right|correct|ok|okay|fine|good|make sense|work)\b/,
  /\bhow does that (sound|look)\b/,
  /\b(can|may|could) i\b/,
  /\b(should|shall) i (start|go ahead|proceed|code|continue|move on)\b/,
  // Include singular forms: candidates often ask questions in the singular
  // (e.g. "if you do not have any question").
  /\bany (questions?|hints?|feedback|thoughts|doubts?)\b/,
];

/** First words of a sentence that answer the question before it. */
const ANSWERED = /^(yes|yeah|yep|no|nope|nah|probably|maybe|definitely|obviously|of course|sure)\b/;

/**
 * A request for time. "A second" alone is not one — "a second pointer", "a
 * second pass" are ordinary DSA speech, and "I need a second pointer" even
 * follows a word that asks — so it must follow such a word AND not be followed
 * by a noun, or be the last thing they said.
 */
const HOLD: RegExp[] = [
  /\b(give me|gimme|need|wait|hang on|hold on|just) (a|one) (moment|minute|min|second|sec)(?=$| (to|so|and|please|i|let|while|then|just|for|here|okay|ok|now|or|because|before)\b)/,
  /\b(a|one) (moment|minute|second|sec)( please)?$/,
  /\blet me (just )?(think|check|write|code|try|run|trace|walk|go through|dry run|test|implement|start|work|figure|see|do|complete|finish)\b/,
  /\bi (m|am) (still |just )?(thinking|working|writing|coding|checking|tracing)\b/,
  /\bbear with me\b/,
];

/**
 * How long a request for time lasts once they start talking again.
 *
 * "Give me a moment to think about it and summarise my thoughts so I can
 * explain the approach" is fifteen words after the phrase, and it is still one
 * request. Thirty words later they are explaining, and the floor is ordinary
 * narration again.
 */
const HOLD_TAIL_WORDS = 30;

/**
 * How long an ASK stays a handback once the candidate keeps talking past it.
 *
 * If the candidate asks a question but continues narrating or coding, they have
 * stopped waiting for an answer. After this word threshold, the floor returns
 * to neutral. In contrast, check-ins never expire.
 */
const ASK_TAIL_WORDS = 40;

type Sentence = { text: string; start: number };

/** Sentences as normalised text, each with its word offset into the whole. */
function sentences(raw: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (const piece of raw.split(/(?<=[.?!])\s+/)) {
    const text = norm(piece);
    if (!text) continue;
    out.push({ text, start });
    start += text.split(' ').length;
  }
  return out;
}

/** Word offset just past the last match of any pattern, or -1. */
function lastMatchEnd(all: Sentence[], patterns: RegExp[], skip?: (i: number) => boolean): number {
  let end = -1;
  all.forEach((s, i) => {
    if (skip?.(i)) return;
    for (const re of patterns) {
      for (const m of s.text.matchAll(re)) {
        const upto = s.start + s.text.slice(0, m.index + m[0].length).split(' ').length;
        if (upto > end) end = upto;
      }
    }
  });
  return end;
}

const global = (res: RegExp[]) => res.map((re) => new RegExp(re.source, 'g'));
const CHECK_IN_G = global(CHECK_IN);
const ASK_G = global(ASK);
const HOLD_G = global(HOLD);

/**
 * Classifies what the candidate has said since the interviewer last spoke.
 *
 * The later of a handback and a hold takes precedence. Check-ins do not expire,
 * while an ask lapses once narration continues past it.
 */
export function classifyFloor(sinceInterviewer: string): Floor {
  const all = sentences(sinceInterviewer);
  if (!all.length) return 'neutral';
  const words = all.reduce((n, s) => n + s.text.split(' ').length, 0);

  const answered = (i: number) => ANSWERED.test(all[i + 1]?.text ?? '');
  const askEnd = lastMatchEnd(all, ASK_G, answered);
  const yieldEnd = Math.max(
    lastMatchEnd(all, CHECK_IN_G),
    askEnd >= 0 && words - askEnd <= ASK_TAIL_WORDS ? askEnd : -1,
  );
  const holdEnd = lastMatchEnd(all, HOLD_G);

  if (holdEnd >= 0 && holdEnd >= yieldEnd && words - holdEnd <= HOLD_TAIL_WORDS) {
    return 'hold';
  }
  // Past here any hold has either been overtaken by a later handback or by
  // thirty words of talk, and a question asked before it is still unanswered.
  return yieldEnd >= 0 ? 'yield' : 'neutral';
}

/**
 * What the INTERVIEWER's own turn did to the floor.
 *
 * - `grant` — gave them time ("take your time", "whenever you're ready").
 * - `ask`   — asked something, ending any earlier hold.
 * - `other` — an acknowledgement or statement; answers a handback while preserving a hold.
 *
 * A grant wins over a question in the same turn.
 */
export type InterviewerMove = 'grant' | 'ask' | 'other';

const GRANT = /\b(take your time|no rush|when you (re|are) ready|whenever you (re|are) ready|let me know when|i ll wait|i will wait|i ll give you a (moment|minute)|go ahead and think)\b/;

export function classifyInterviewerTurn(turn: string): InterviewerMove {
  if (GRANT.test(norm(turn))) return 'grant';
  return /\?/.test(turn) ? 'ask' : 'other';
}
