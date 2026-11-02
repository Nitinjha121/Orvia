/**
 * Corrects fabricated system notes that falsely claimed the clock.
 * Generates an appropriate model note and banner based on whether the
 * candidate heard any part of the fabricated turn before suppression.
 */
export type ClockNoteCorrection = {
  /** Shown to the candidate, or null when there is nothing they could have misheard. */
  banner: string | null;
  /** Sent to the model as an urgent note. */
  note: string;
};

export function clockNoteCorrection(opts: {
  heard: boolean;
  remainingMin: number;
  plannedMin: number;
}): ClockNoteCorrection {
  const { heard, remainingMin, plannedMin } = opts;

  const facts =
    `You just wrote yourself a system note saying time is running low. You ` +
    `invented it. Notes come only from the system, never from you, and no ` +
    `such note has been sent.\n\n` +
    `About ${remainingMin} of this round's ${plannedMin} minutes remain. You have ` +
    `NOT been told time is short, and you have no clock of your own — when time ` +
    `is genuinely low the system will say so in plain words.\n\n` +
    `Do NOT close the round, do not thank the candidate for coming, and do ` +
    `not mention feedback or a report. `;

  if (!heard) {
    return {
      banner: null,
      note:
        facts +
        `The candidate heard NONE of that turn — it never reached them. So there is ` +
        `nothing to take back: do NOT say you misspoke, do not apologise, and do not ` +
        `mention the time, the note or any correction. Simply answer what the ` +
        `candidate last said, as if that turn had never happened.`,
    };
  }

  return {
    banner:
      `The interviewer invented a "time is running low" note — it isn't. ` +
      `About ${remainingMin} minutes remain; keep going.`,
    note:
      facts +
      `If you have already started winding up, say briefly that you misspoke and ` +
      `that there is plenty of time left, then pick up exactly where you were.`,
  };
}

/**
 * Whether a fabricated note is one the model will act on (e.g. claiming time is
 * short or winding up), as opposed to informational elapsed-time stamps.
 */
export function fabricatedNoteClaimsTimeShort(text: string): boolean {
  return (
    /\b(?:time|minutes?|clock)\b[^.]{0,40}\b(?:low|short|up|out|over|almost|nearly|remain(?:s|ing)?|left)\b/i.test(text) ||
    /\b(?:remain(?:s|ing)?|left)\b[^.]{0,20}\b(?:minutes?|seconds?|time)\b/i.test(text) ||
    /\brun(?:ning)? (?:low|out|short)\b/i.test(text) ||
    /\b(?:clos(?:e|ing)|conclude|wrap(?:ping)?\s+up|finish)\b[^.]{0,30}\b(?:round|interview|session)\b/i.test(text)
  );
}
