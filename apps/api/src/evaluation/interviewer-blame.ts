import type { GuardEvent } from '@orvia/shared';

/**
 * Ensures the candidate is not blamed in evaluation summaries or top fixes
 * for interviewer defects (such as prolonged silences, premature advances, or
 * repetitive prompts).
 */

/**
 * A failure of OURS, named. Deliberately not the bare word "interviewer": "ask
 * the interviewer for the constraints before you start" is a real fix.
 */
const INTERVIEWER_FAULT = new RegExp(
  [
    String.raw`\bwent quiet\b`,
    String.raw`\b(?:stopped|stops) (?:responding|replying|talking)\b`,
    String.raw`\bnot responding\b`,
    String.raw`\bunresponsive\b`,
    String.raw`\bglitch(?:es|y)?\b`,
    String.raw`\btechnical (?:issues?|problems?|difficult(?:y|ies))\b`,
    String.raw`\bconnection (?:issues?|problems?|drops?|dropped|lost)\b`,
    String.raw`\bnetwork\b`,
    String.raw`\baudib(?:le|ility)\b`,
    String.raw`\bcan you hear\b`,
    String.raw`\bdead (?:line|air|windows?)\b`,
    String.raw`\bstall(?:s|ed|ing)?\b`,
    String.raw`\b(?:interviewer|it) (?:repeats|repeated|re-?asks|re-?asked|re-?reads)\b`,
    String.raw`\brepetitive (?:questions?|questioning|prompts?)\b`,
    String.raw`\brepeated (?:questions?|prompts?)\b`,
    String.raw`\bprematur(?:e|ely)\b`,
    String.raw`\b(?:wrap(?:s|ped)? up|ends?|ended|closes?|closed) (?:the round |the interview )?(?:early|too soon)\b`,
  ].join('|'),
  'i',
);

/**
 * Silence is only OURS when the interviewer is the one silent. "Avoid long
 * silences while you think — narrate" is the commonest real delivery fix there
 * is, so the bare word cannot condemn a line on its own.
 */
const INTERVIEWER_SILENT =
  /\b(?:interviewer|it)(?:'s| was| is| went| goes| fell)? (?:(?:silent|quiet)|(?:experienc\w+|had|has) (?:a |long |prolonged )*silences?)\b|\bprolonged silences?\b|\bsilen(?:ce|t) (?:from|on) the interviewer\b/i;

/** A sentence that holds the candidate's REACTION to one of those faults against them. */
const REACTION_BLAMED = new RegExp(
  [
    String.raw`\byou (?:allowed|let)\b`,
    String.raw`\bdisrupt(?:s|ed|ing)? your\b`,
    String.raw`\byour (?:focus|composure|flow|rhythm) (?:slipped|suffered|broke|faltered)\b`,
    String.raw`\byou (?:lost|broke) (?:your )?(?:focus|composure|flow|rhythm)\b`,
    String.raw`\byou (?:were|became|got|seemed) (?:rattled|thrown|flustered|distracted|frustrated|irritated|impatient)\b`,
    String.raw`\b(?:maintain|keep|stay) (?:your )?(?:composure|calm|composed|focus(?:ed)?)\b`,
    String.raw`\bcontinue methodically\b`,
  ].join('|'),
  'i',
);

export function blamesCandidateForInterviewer(text: string): boolean {
  return INTERVIEWER_FAULT.test(text) || INTERVIEWER_SILENT.test(text);
}

/**
 * Drops every fix about the interviewer's faults and refills from the report's
 * own per-question advice, which is about the candidate by construction.
 * A fix list shorter than it came is better than a fix the candidate cannot act on.
 */
export function sanitiseTopFixes(fixes: string[], fallbacks: string[]): { fixes: string[]; dropped: string[] } {
  const dropped = fixes.filter((f) => blamesCandidateForInterviewer(f));
  const kept = fixes.filter((f) => !blamesCandidateForInterviewer(f));
  const seen = new Set(kept.map((f) => f.trim().toLowerCase()));
  for (const f of fallbacks) {
    if (kept.length >= fixes.length) break;
    const k = f.trim().toLowerCase();
    if (!k || seen.has(k) || blamesCandidateForInterviewer(f)) continue;
    seen.add(k);
    kept.push(f.trim());
  }
  return { fixes: kept, dropped };
}

export type InterviewerFacts = {
  deadMs: number;
  guardEvents: GuardEvent[];
};

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/**
 * The sentence the summary must contain whenever the round had measured faults.
 * Built from the measurements, never from the model, so it cannot be omitted
 * or softened. Null when nothing went wrong.
 */
export function interviewerFaultSentence(facts: InterviewerFacts): string | null {
  const count = (k: GuardEvent['kind']) => facts.guardEvents.filter((e) => e.kind === k).length;
  const clauses = [
    facts.deadMs > 0 ? `stopped responding for ${mmss(facts.deadMs)} in total` : null,
    count('premature_advance') ? `moved on from an unfinished problem ${times(count('premature_advance'))}` : null,
    count('false_close') ? `announced the round was over ${times(count('false_close'))} when it was not` : null,
    count('scope_backward') ? `went back to a problem you had already finished ${times(count('scope_backward'))}` : null,
    count('code_claim') ? `described code that was not in your editor ${times(count('code_claim'))}` : null,
    count('invented_markup') ? `invented editor contents you had not written ${times(count('invented_markup'))}` : null,
    count('premature_wrapup')
      ? `asked whether you were done before you had written your code ${times(count('premature_wrapup'))}`
      : null,
  ].filter((c): c is string => !!c);
  if (!clauses.length) return null;
  const list = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`;
  return `The interviewer failed during this round — it ${list}. That was the app's fault, not yours.`;
}

/**
 * Removes summary sentences that blame the candidate's reaction to one of our
 * faults, and appends the measured fault sentence.
 */
export function sanitiseSummary(summary: string, facts: InterviewerFacts): { summary: string; dropped: string[] } {
  const sentences = summary.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [summary];
  const dropped: string[] = [];
  const kept = sentences.filter((s) => {
    const blame = blamesCandidateForInterviewer(s) && REACTION_BLAMED.test(s);
    if (blame) dropped.push(s.trim());
    return !blame;
  });
  const fact = interviewerFaultSentence(facts);
  const body = kept.map((s) => s.trim()).filter(Boolean).join(' ');
  return { summary: fact ? `${body} ${fact}`.trim() : body, dropped };
}
