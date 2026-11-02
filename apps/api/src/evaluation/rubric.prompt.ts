import {
  DELIVERY_DIMENSIONS, RUBRIC_VERSION, VERDICTS, STYLE_LABELS, INTERVIEW_STYLES,
  type FocusItem, type GuardEvent, type SpeechMetrics, type InterviewMode, type InterviewStyle,
} from '@orvia/shared';
import { describeMetrics } from './metrics';
import { UNTRANSCRIBED_TURN_MARKER } from '../interview/untranscribed-turn';

export type EvaluationInput = {
  mode: InterviewMode;
  durationMinutes: number;
  /**
   * What the round ACTUALLY ran, so the evaluator can check any claim about the
   * clock against it rather than believing the interviewer. Null only for a row
   * that never finalized a duration.
   */
  actualMinutes: number | null;
  /**
   * Set when the round ended without the interview ending — the browser socket
   * dropped or the candidate left (`connection`), or the API stopped
   * (`server`). Such a round is only ever scored on request, and without this
   * it reads as a candidate who ran out of things to say a minute in.
   */
  cutShort?: 'connection' | 'server' | null;
  /**
   * Windows in which the interviewer produced nothing, measured by the stall
   * watchdog while the round ran. The rubric has always been told this happens;
   * these make it CHECKABLE, which is the difference between the evaluator
   * believing the candidate's "can you hear me?" was nerves and knowing the
   * line was dead. Empty for a round that never stalled.
   */
  deadWindows?: { atMs: number; forMs: number; recovered: boolean; opening: boolean; deaf?: boolean }[];
  /**
   * What the live guards caught the interviewer doing, persisted per round. The
   * same move as `deadWindows`: the evaluator is told the interviewer is
   * fallible either way, and these make each failure checkable.
   */
  guardEvents?: GuardEvent[];
  difficulty: string;
  transcript: { speaker: 'ai' | 'user'; text: string; startMs: number }[];
  metrics: SpeechMetrics;
  /** Reference material for the questions asked — evaluator-only. */
  referenceMaterial: string;
  /** Editor / scratchpad snapshots, if the round had them. */
  writtenContext: string | null;
  /**
   * Whether each problem's code actually works, decided before this prompt was
   * built. See `code-check.service.ts` for why this is not a rubric
   * instruction: telling the evaluator to read the code did not make it.
   */
  codeChecks?: {
    questionId: string;
    title: string;
    verdict: 'correct' | 'incorrect' | 'incomplete' | 'empty';
    failingInput: string | null;
    expected: string | null;
    actual: string | null;
    whatBreaks: string | null;
    otherFaults?: string[];
  }[];
  /** Language the candidate was coding in, so the model solution matches it. */
  codeLanguage?: string | null;
  /** True when the model is also receiving the raw recording. */
  hasAudio: boolean;
  /** Higher-accuracy re-transcription of the candidate's audio, if available. */
  verbatimTranscript?: string | null;
  /**
   * The problems this round ASSIGNED, in the order the round ran them.
   *
   * Separate from `referenceMaterial` (which is study notes) because these ids
   * are a closed set the evaluator must echo back: they are what decides
   * whether a problem stays in the candidate's practice rotation. Empty for
   * modes with no question bank.
   */
  assignedQuestions?: { id: string; title: string; difficulty: string }[];
  /**
   * What the candidate carried into this round: fixes they committed to from
   * earlier reports, or on a drill the weaknesses being retried. Each key is a
   * closed enum in the response schema. Empty for most rounds.
   */
  focus?: FocusItem[];
  /** Whether this round is a drill of one moment, which changes nothing about how it is scored. */
  isDrill?: boolean;
  /** Which company's loop the interviewer imitated. Absent or `general` adds nothing. */
  style?: string | null;
};

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const MODE_FOCUS: Record<InterviewMode, string> = {
  dsa: 'Judge the approach before the code: did they clarify, state an approach, justify it, analyse complexity, and consider edge cases? A correct answer arrived at without reasoning is worth less than a slightly wrong one arrived at well.',
  jd: 'Judge against what the role actually requires. Depth on the listed competencies matters more than breadth elsewhere.',
  experience: 'Judge specificity and ownership above all. Vague collective claims ("we built", "improved performance") with no personal role or measurement are the primary failure mode here.',
  system_design: 'Judge the phases: requirements, estimation, API, data model, high-level design, deep dive, trade-offs. Skipping straight to boxes without scoping is a significant failure regardless of how good the boxes are.',
  concepts:
    'Judge depth against fluency. A correct textbook definition is the floor, not the answer — credit the candidate who connects the mechanism to a decision they made, a failure they saw, or a trade-off they took, and mark down confident buzzwords with nothing underneath them. "I do not know" said plainly is worth more than a plausible invention, and you must say so: a fabricated mechanism is the most serious failure available in this round.',
  behavioural:
    'Judge specificity, ownership and honesty. A strong answer names a real situation, says what THIS PERSON did rather than what the team did, gives a decision with a reason, and reports an outcome that can be checked. The failure modes are: answering in the general ("I always make sure to…") when asked for a specific time, collective ownership that never resolves to a personal action, unmeasured claims, and a story with no cost or mistake in it. Do NOT score the candidate on whether their history is impressive — you are scoring how they told it.',
  hr:
    'This round tests negotiation, not technical skill, and the delivery dimensions carry almost all of it. The things that matter: did they avoid naming a number before they had to, and do it without sounding evasive; when they did name one, was it justified and did they hold it; did they negotiate against themselves by lowering their own figure to fill a silence or in response to a soft objection; did they ask what the band or budget was; did they stay warm while holding a position. Quote the exact sentence where they conceded, if they did — it is the single most useful line in the report. Accepting a first offer out of relief is the most common failure. Being unkind or combative is a failure too: they may need this person later.',
};

/**
 * Prompt section for evaluating assigned problem outcomes. Tailored per mode
 * (e.g. code implementation for DSA vs verbal explanation for concepts) so
 * questions are judged appropriately before updating the practice rotation.
 */
function assignedSection(mode: InterviewMode, count: number, list: string): string {
  const concepts = mode === 'concepts';
  const unit = concepts ? 'question' : 'problem';

  const outcomes = concepts
    ? `  - \`solved\` — they answered it correctly and with real understanding: the
    mechanism is right, and they could say why rather than only what. A minor
    gap in an otherwise correct answer is still solved.
  - \`partial\` — a real attempt with something genuinely wrong or missing. A
    correct definition with no mechanism underneath it, a right answer they
    could not defend when probed, or an answer that only became correct after
    the interviewer supplied the key idea.
  - \`unsolved\` — the question was genuinely put to them and they did not get
    there: a wrong mechanism held confidently, an invented explanation, or a
    plain "I do not know" with nothing else offered. Saying "I do not know"
    honestly is better CONDUCT than inventing, and you should say so in the
    delivery scores — but it is still unsolved here.
  - \`not_reached\` — the interviewer never asked this question. Say this rather
    than guessing. It is not a mark against the candidate, and a round that
    spent its time on the first two questions is a normal round.`
    : `  - \`solved\` — they arrived at a correct, working approach to the problem as
    stated, and reasoned it out rather than guessing — and where they wrote
    code, that code is correct too. Optimality is NOT required here: a correct
    solution they analysed honestly is solved even if a better algorithm
    exists. That is what the complexity table is for.
  - \`partial\` — a real attempt that did not get there. A brute force they never
    improved when asked to, code that fails a case — whether or not anybody
    pointed that case out during the round — an approach abandoned half-way, or
    a correct idea never turned into working code.
  - \`unsolved\` — the problem was genuinely put to them and they did not reach a
    working approach at all.
  - \`not_reached\` — the interviewer never got to this problem. Say this rather
    than guessing. It is not a mark against the candidate, and a round that
    spent all its time on problem one is a normal round.`;

  const judging = concepts
    ? `Judge \`solved\` against what they SAID, not against the reference notes'
wording. Reaching the same mechanism in their own words — or by a different
route — is solved. Do not mark someone down here for needing a follow-up to get
there, and do not credit \`solved\` for fluent vocabulary with no mechanism
underneath it, which is the failure this round exists to catch.`
    : `Judge \`solved\` against the PROBLEM, never against the model solution you wrote.
Do not mark someone down here for being suboptimal, for writing untidy code, or
for needing a hint along the way — none of those mean they cannot solve it.
Equally, do not credit \`solved\` for an approach that was only described in the
abstract and never made concrete when the round had an editor open.

**Where they wrote code, READ IT before you decide, and trace it on one small
input.** The code under "What the candidate wrote" is the answer they actually
gave; what they said about it is a claim about that answer. When the two
disagree, the CODE decides this field. A plan stated correctly out loud and
then not implemented — a memo table written but never read back, a base case
that returns on the wrong condition, a loop that never advances — is
\`partial\`, however fluent the plan was and however confidently the complexity
was asserted.

Two things make this easy to get wrong here, so check them explicitly. The
interviewer is FORBIDDEN from correcting the candidate or confirming an answer,
so nobody in the transcript will have pointed out a bug: the interviewer moving
on is not agreement, and its silence is not a signal. And a candidate who
walks through their own code aloud may narrate the algorithm they INTENDED
rather than the one on screen — on one real round the candidate traced their
own solution to the wrong answer and concluded "yeah, I think it's fine", and
the code was scored \`solved\` on the strength of the plan they had described
several minutes earlier.

\`evidenceQuote\` stays their own words, so where the code is what decides it,
quote the words the code does NOT support — the claim, or the walkthrough that
skips the broken line — rather than the sentence where the plan sounded right.`;

  return `### Assigned ${unit}s — did they get it?

The candidate was assigned exactly these ${unit}s, and no others:

${list}

Return **one entry per ${unit} above — all ${count} of them** — using the
id on the left verbatim as \`questionId\`. This is a different list from the
question-by-question breakdown above: that one follows the conversation, this one
follows the ${unit}s that were handed out.

- **outcome** — one of:
${outcomes}
- **reason** — one sentence. Say why this outcome and not the neighbouring one.
- **evidenceQuote** — the candidate's own words that decide it, verbatim. Null
  ONLY when the outcome is \`not_reached\`.

${judging}

This field removes a ${unit} from the candidate's practice rotation, so it is the
one place in this report where being generous does real damage: a ${unit} marked
solved will not be offered to them again.

`;
}

/**
 * Injects deterministic code execution and trace findings into the prompt as
 * verified facts, preventing the model from assuming code correctness based
 * solely on spoken plans.
 */
function describeCodeChecks(checks: EvaluationInput['codeChecks']): string {
  if (!checks?.length) return '';

  const lines = checks.map((c) => {
    if (c.verdict === 'correct') {
      return `- **${c.title}** — traced and it returns the right answer.`;
    }
    if (c.verdict === 'empty') {
      return `- **${c.title}** — nothing of substance was written.`;
    }
    const label = c.verdict === 'incomplete' ? 'never finished' : 'does NOT work';
    const others = (c.otherFaults ?? []).filter((f) => f.trim());
    return (
      `- **${c.title}** — ${label}. ` +
      `For ${c.failingInput ?? 'at least one allowed input'} the problem requires ` +
      `${c.expected ?? 'a different answer'}, and this code gives ${c.actual ?? 'something else'}. ` +
      `${c.whatBreaks ?? ''}`.trim() +
      (others.length
        ? ` **Also broken, independently — fixing the fault above would not fix these:** ${others.join(' ')}`
        : '')
    );
  });

  return `
## Whether the code works (checked separately — treat as a finding, not an opinion)

Each problem's final editor contents were traced line by line against the
problem statement, on its own, before this report was written:

${lines.join('\n')}

Use these when you decide \`assignedQuestions\`, the per-question verdicts and
the summary. Name EVERY fault a finding lists, not only the first — telling the
candidate their approach was sound and one variable was missing, when the code
had a second fault that broke the algorithm itself, sends them to fix the wrong
thing. A problem whose code does not work is **not \`solved\`**, however
well the candidate described the approach out loud and however confidently they
asserted the complexity — a plan they did not implement is \`partial\`. Say what
was actually wrong, in your own words, so the feedback is usable: naming the
line beats saying "there was a bug".

**Confirm the fault against the code before you use it — you can overrule it.**
Each finding above names a specific line or condition. Go to that line in the
section above and check the claim yourself. This reader is right about blatant
defects — a cache written and never read, a loop bound one short, a base case on
the wrong condition — and measurably wrong sometimes about code that is subtle
but correct, which is the expensive direction because it costs the candidate a
\`solved\` they earned. If you look at the line it names and the code is in fact
right, SAY SO and score it \`solved\`. Deferring to a finding you can see is
wrong is the one thing you must not do.

Its arithmetic is the least reliable part. The failing input and the value it
claims that input produces are working notes — one finding offered an input
where the claimed and the required answers were identical — so do not repeat
those numbers to the candidate as fact. Describe the fault itself.

Two things follow from how this round ran, and both are easy to get backwards.
The interviewer is FORBIDDEN from correcting the candidate or confirming an
answer, so nobody will have pointed the bug out — its silence is not agreement
and moving on is not a pass. And a candidate walking through their own code
aloud often narrates what they MEANT to write: where their walkthrough and this
finding disagree, the finding is about the code that is actually there.
`;
}

/**
 * The interviewer's dead windows, as facts rather than as a warning.
 *
 * Absent entirely when the round had none — an empty heading is a fact the
 * evaluator will try to interpret, and "the interviewer stalled 0 times" reads
 * as a hint that it probably did.
 */
function describeDeadWindows(windows: EvaluationInput['deadWindows']): string {
  if (!windows?.length) return '';

  const mmss = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };
  const totalMs = windows.reduce((n, w) => n + w.forMs, 0);
  const lines = windows
    .map(
      (w) =>
        `- ${w.opening ? 'From the start of the round' : `At ${mmss(w.atMs)}`}, the ` +
        `interviewer produced nothing for ${mmss(w.forMs)}` +
        (w.deaf
          ? ' — and could not hear the candidate at all, so what they said in it is ' +
            'MISSING from the transcript below, not absent from the round'
          : '') +
        (w.recovered ? '.' : ', and never spoke again.'),
    )
    .join('\n');
  // A gap in the transcript reads as the candidate doing nothing, which could
  // lead to wrongly concluding that an unassessed problem was unsolved.
  const deafNote = windows.some((w) => w.deaf)
    ? '\n\nWhere a window says the interviewer could not hear the candidate, do not ' +
      'score what is missing: a problem that stalls inside one is unassessed, not ' +
      'unsolved, and its outcome is not_reached.'
    : '';

  return `

**The interviewer was DEAD for ${mmss(totalMs)} of this round, measured.** Not
slow, not listening — producing nothing at all, while the candidate's microphone
stayed open and recording:

${lines}

Anything the candidate said inside those windows was said into silence. Repeating
themselves, asking "can you hear me?", thinking aloud at length, going quiet, or
ending the round are all correct responses to a dead line and **must not be
scored as a conduct, composure, concision or communication problem**. Do not
count that time against their pace, and do not describe them as rambling,
rattled or unstructured over it. The round's planned length already excludes it.${deafNote}`;
}

const GUARD_EVENT_WORDING: Record<GuardEvent['kind'], string> = {
  premature_advance: 'moved on to the next problem while this one was still unfinished',
  false_close: 'announced the round was over when it was not',
  clock_claim: 'made a claim about the clock that the real clock contradicts',
  scope_backward: 'went back to re-read a problem the round had already finished',
  scope_wider: 'introduced a problem from outside this round',
  repeat_ask: 'asked again for something it had already asked',
  code_claim: 'described code that was not in the editor at the time',
  invented_markup: 'wrote an editor snapshot or system message of its own, holding code the candidate had not written',
  premature_wrapup: 'asked whether a problem was finished before the candidate had written it',
};

/**
 * The interviewer's other measured faults, as facts. Absent when there were
 * none, for the reason `describeDeadWindows` gives.
 */
function describeGuardEvents(events: EvaluationInput['guardEvents']): string {
  if (!events?.length) return '';
  const lines = events
    .map((e) => `- At ${fmt(e.atMs)}, the interviewer ${GUARD_EVENT_WORDING[e.kind]}: "${e.said.slice(0, 200)}"`)
    .join('\n');
  return `

**The interviewer made these mistakes, caught by the app while the round ran:**

${lines}

Each is the interviewer's fault, not the candidate's. A candidate who objected
("we have not finished this one", "I think you are hallucinating"), kept working
on the unfinished problem, or ignored a false sign-off was doing the right thing.
None of these may lower a score, appear in \`topFixes\`, or be described in the
summary as something the candidate handled badly.`;
}

/** A candidate sentence that states or revises a complexity. */
const COMPLEXITY_CLAIM =
  /\b(?:complexity|big o|o of|linear|constant|log(?:arithmic)?\s*n|n squared|n square|quadratic|exponential|m into n|m times n)\b|\bo\s*\(|\bm\s*\*\s*n\b/i;

/**
 * Extracts candidate complexity statements in chronological order so the model
 * can accurately identify their final claim after any revisions.
 */
export function complexityClaims(transcript: EvaluationInput['transcript']): string[] {
  const out: string[] = [];
  for (const t of transcript) {
    if (t.speaker !== 'user') continue;
    for (const s of t.text.match(/[^.!?]+[.!?]*/g) ?? []) {
      if (COMPLEXITY_CLAIM.test(s)) out.push(`[${fmt(t.startMs)}] ${s.trim()}`);
    }
  }
  return out;
}

function describeComplexityClaims(transcript: EvaluationInput['transcript']): string {
  const claims = complexityClaims(transcript);
  if (!claims.length) return '';
  return `
## Every complexity claim the candidate made, in order

Extracted from the transcript by the app. A later claim about the same problem
and axis REPLACES an earlier one — use the LAST one for \`stated\` and quote it.

${claims.slice(-80).join('\n')}
`;
}

/**
 * The focus items, as a separate verdict from the scores.
 *
 * Kept apart deliberately: the candidate chose these, so a report that let
 * them move the SCORES would reward whatever they happened to be working on.
 * The check is binary evidence — did it show up, with a quote — and the
 * scores stay exactly what they would have been.
 */
function focusSection(items: FocusItem[], isDrill: boolean): string {
  if (!items.length) return '';
  const list = items.map((f) => `  - ${f.key} — "${f.text}"`).join('\n');
  return `### What the candidate was working on (${items.length})

${isDrill
  ? 'This round is a short drill: the candidate retried ONE question from an earlier round, after reading that round\'s report. These are the weaknesses the earlier report found, which they were trying to fix.'
  : 'The candidate committed, after earlier reports, to fixing these in their next rounds. They could see this list during the round.'}

${list}

Return EXACTLY one \`focusChecks\` entry per item, with its key verbatim:

- **result** — \`applied\` when the round shows the fix clearly, every time it
  had the chance; \`partly\` when it showed up but not
  consistently, or only after the interviewer prompted it; \`not_applied\`
  when the round gave a clear chance and the old habit came back;
  \`no_chance\` when nothing in THIS round gave an opening for it — a coding
  fix in a round with no code, say. Do not use \`no_chance\` to avoid a
  judgement: if the chance was there, decide.
- **evidenceQuote** — the candidate's own words that show the result, verbatim.
  ALWAYS given for \`applied\` and \`partly\` — a verdict with no quote is not
  kept. Null for \`no_chance\`, and for \`not_applied\` only when the habit
  showed as an omission and there is nothing they said to quote.
- **note** — one sentence on why this result and not the neighbouring one.

These checks are a SEPARATE verdict. They must not move any score, the verdict,
the summary or topFixes — score this round exactly as you would if the list did
not exist.${isDrill ? ' Score the answer they gave on its merits, as for any round: the report they read is how a drill is meant to work, and the page that shows this score says so.' : ''}

`;
}

const styleLine = (style: string | null | undefined) =>
  style && style !== 'general' && (INTERVIEW_STYLES as readonly string[]).includes(style)
    ? `\n- Interviewer style: ${STYLE_LABELS[style as InterviewStyle]} — it changes what the interviewer probed, never the anchors you score against`
    : '';

/** A round that stopped mid-interview, stated as a fact rather than left for the length to imply. */
function describeCutShort(how: 'connection' | 'server', actual: number | null, planned: number): string {
  const cause =
    how === 'server'
      ? 'the server running the interview stopped'
      : "the candidate's connection dropped or they left the page";
  const ran = actual === null ? 'part' : `${actual} of the planned ${planned} minutes`;
  return (
    `\n\n**This round was CUT SHORT: ${cause}, after ${ran}.** It did not end ` +
    `because the candidate finished, gave up or ran out of things to say, and the ` +
    `interviewer did not close it. Score only what happened before the cut. Questions ` +
    `never reached, a problem left unfinished, a missing summary or wrap-up and an ` +
    `absent closing question are consequences of the cut — do not mark the candidate ` +
    `down for any of them, for pace or for coverage, and do not offer finishing the ` +
    `round as a fix. Say plainly in the summary that the round was cut short and that ` +
    `this report covers only the part that was recorded.`
  );
}

export function buildEvaluatorPrompt(input: EvaluationInput): string {
  const dimensions = DELIVERY_DIMENSIONS.map(
    (d) =>
      `### ${d.id} — ${d.label}\n${d.question}\n` +
      `  1 = ${d.anchors[1]}\n  3 = ${d.anchors[3]}\n  5 = ${d.anchors[5]}` +
      (d.needsAudio && !input.hasAudio
        ? '\n  NOTE: no recording available for this session — judge from the transcript and say so in the assessment.'
        : ''),
  ).join('\n\n');

  const transcript = input.transcript
    .map((t) => `[${fmt(t.startMs)}] ${t.speaker === 'ai' ? 'INTERVIEWER' : 'CANDIDATE'}: ${t.text}`)
    .join('\n');

  const assigned = input.assignedQuestions ?? [];
  /**
   * Listed with their ids because the id is what must come back. The order is
   * the order the round ran them, so "problem two" here means the same thing it
   * means in the transcript, in the editor buffers and on the report card.
   */
  const assignedList = assigned
    .map((q, i) => `  ${i + 1}. ${q.id} — "${q.title}" (${q.difficulty})`)
    .join('\n');

  return `
You are an experienced interviewer writing up a candidate after a practice
interview. Your feedback is the entire product — it must be specific, honest,
and immediately actionable. Generic encouragement is worse than useless here.

## What you are given

${input.hasAudio
  ? `1. **The candidate's audio recording.** Listen to it. Hesitation, filler words, a voice that
   wobbles when guessing, an upward inflection turning a statement into a question — these exist
   in the audio and NOWHERE else. Do not infer them from the text.`
  : `1. No recording is available for this session — judge delivery from the transcript and the
   measured metrics only, and say plainly where you could not assess something.`}
2. The transcript, with timestamps.
3. Measured speech metrics — these are FACTS, already counted. Use them; do not re-count them
   or contradict them.
4. Reference material for the questions asked, which the candidate never saw.

## Round

- Mode: ${input.mode}
- Planned length: ${input.durationMinutes} minutes
- Actual length: ${input.actualMinutes === null ? 'unknown' : `${input.actualMinutes} minutes`}
- Calibration: ${input.difficulty}${styleLine(input.style)}${input.isDrill ? '\n- This is a short DRILL of one question, so its length and single topic are by design' : ''}${describeDeadWindows(input.deadWindows)}${describeGuardEvents(input.guardEvents)}${
    input.cutShort
      ? describeCutShort(input.cutShort, input.actualMinutes, input.durationMinutes)
      : input.actualMinutes !== null && input.actualMinutes < input.durationMinutes * 0.9
      ? `\n\n**This round ended ${input.durationMinutes - input.actualMinutes} minutes EARLY.** ` +
        `The candidate did not run out of time and cannot be marked down for pace, ` +
        `rushing or "running over" — there was time left. If the interviewer said ` +
        `otherwise, read the note below about its clock.`
      : ''
  }

${MODE_FOCUS[input.mode]}

## Measured speech metrics (already counted — treat as given)

${describeMetrics(input.metrics)}

## Reference material (the candidate did NOT see this)

${input.referenceMaterial || '(none available — judge on the merits of the reasoning)'}

${input.writtenContext ? `## What the candidate wrote\n\n${input.writtenContext}\n` : ''}${describeCodeChecks(input.codeChecks)}
## Transcript

${transcript}
${input.verbatimTranscript ? `
## Verbatim re-transcription of the candidate's audio

More accurate than the transcript above, and it preserves filler words and
false starts. Prefer THIS when quoting the candidate as evidence.

${input.verbatimTranscript}
` : ''}${describeComplexityClaims(input.transcript)}

## The interviewer is an AI, and it is not always right

You are scoring the CANDIDATE, never the interview. The interviewer in this
transcript is a language model, and the failures below happen often enough
that you must actively check for each of them before you score conduct:

- **It re-asks things already answered.** Before you mark a candidate down for
  impatience, resistance, poor listening or poor follow-up handling, go back and
  read what they had already said. If they had genuinely given the answer —
  including the derivation, if that is what was asked for — then being asked
  again is the interviewer's failure, not theirs. Saying so, even bluntly, is
  not unprofessional and must not be scored as such. Note it in the assessment
  and score the dimension on the rest of the round.
- **It stacks several questions into one turn.** Answering only part of such a
  turn is not evasion. Judge the part they answered.
- **It moves on to the next problem before this one is finished.** It reads the
  next statement while the candidate is still thinking, still coding, or has
  just said they are nearly done. A candidate who objects and stays on the
  unfinished problem is right to. Judge the unfinished problem on what they had
  reached when they were cut off, never on the fact that they did not finish.
- **It describes code that is not there.** "I see you've written the DFS
  function" when the editor held two lines. Nothing the interviewer says about
  the code is evidence about the code — the code is.
- **It announces the round is out of time when it is not.** The interviewer has
  no clock and its own sense of elapsed time runs at roughly twice the real
  rate, so it sometimes says "we're out of time", "we'll wrap up here" or
  "that's all the time we have" with most of the round still unused. **Check
  every claim about the clock against the planned and actual lengths above
  before you accept it.** If the round did not in fact run out of time, then:
  - do NOT say the candidate ran out of time, ran over, was rushed by the
    clock, or left themselves short — none of it happened;
  - do NOT dock concision, composure, pace or structure for it, and do not
    offer "keep pace with the clock" as a fix;
  - a candidate who kept talking, finished their walkthrough, or asked to carry
    on after a premature sign-off was doing the right thing, not ignoring the
    interviewer. Say plainly in the summary that the interviewer ended the
    round early in error.

  You may still judge how they SPENT the time they used — four minutes of
  clarification really is four minutes — but judge it against the round's real
  length, never against a deadline the interviewer invented.
- **It goes silent.** The interviewer sometimes stops replying altogether for
  minutes at a time while the candidate is still talking to it. In the
  recording this sounds like the candidate finishing an answer, waiting, then
  asking "Hello, am I audible?", "Can you hear me?" or "You are not
  responding" — and often repeating themselves or filling the gap because
  nothing came back. **None of that is a conduct problem and none of it may be
  scored as one.** Checking whether you are audible is the correct thing to do
  when a line goes dead. Do not mark them down for composure, professionalism,
  follow-up handling or confidence over it; do not describe them as rattled,
  frustrated, irritated or as criticising the interviewer; and do not read a
  long unanswered stretch as rambling or poor concision, because there was
  nobody to hand the turn back to. Score those dimensions on the parts of the
  round where the interviewer was actually present, and say plainly in the
  summary that the interviewer stopped responding.

- **Some of its questions are missing from the transcript entirely.** The
  transcription service occasionally returns nothing for a turn the interviewer
  actually spoke, and those turns appear as
  \`[${UNTRANSCRIBED_TURN_MARKER}: ...]\` at the point they happened. **Read
  each one as a real question you cannot see.** The candidate heard it and
  answered it, so an answer that follows one is a RESPONSE, never an
  unprompted monologue. Do not score structure, concision or listening down for
  it — on one measured round fifteen of the interviewer's twenty-nine questions
  went missing this way, and the candidate was marked down for a lack of
  roadmap on a round they were being steered through question by question.
  Where a marker leaves you genuinely unable to judge an answer, say so rather
  than guessing at what was asked.

If the candidate pushed back on genuine repetition, the honest report says the
interviewer repeated itself and that a human interviewer would not have — and
scores their conduct on how they handled it, not on the fact that they minded.

**This covers every field, not only the scores.** No \`topFixes\` entry and no
sentence of the summary may be about how the candidate reacted to any failure
above — no "stay composed when the interviewer goes quiet", no "you let the
repeated questions disrupt your focus". The candidate cannot fix the
interviewer. Spend every fix on something they can change.

## What to produce

### Per question
Pair every substantive question the interviewer asked with the answer given.
Merge follow-ups into the question they belong to rather than listing them
separately. Skip the greeting and the sign-off.

For each:
- **question** — what was asked, verbatim or lightly tidied
- **myAnswer** — a faithful summary of what the candidate actually said, not what they meant
- **idealAnswer** — what a strong answer would have contained. Concrete and specific to THIS
  question. This is the most valuable field in the report; make it something the candidate could
  study from.
- **whatWasGood** — specific things that genuinely worked. If nothing did, return an empty array
  rather than inventing praise.
- **whatWasMissing** — what was absent, wrong, or hand-waved
- **howToImprove** — one concrete rewrite instruction, e.g. "Lead with the approach and complexity
  in two sentences, then walk the code" — not "be more clear"
- **modelSolution** — for coding questions only: a complete, correct, idiomatic implementation${
    input.codeLanguage ? ` in **${input.codeLanguage}**, the language they were writing in` : ''
  }. Plain code, no markdown fences, no commentary. This sits next to whatever
  the candidate actually wrote, so it must actually run and must solve the
  stated problem. **Format it as real source** — literal newlines and real
  indentation, exactly as it would appear in a file. Never collapse it onto a
  single line or chain statements with semicolons: in an indentation-sensitive
  language that is not even valid code, and it renders as one unreadable line
  running off the side of the page. Null for non-coding questions.
- **modelSolutionLanguage** — the language of that solution
- **complexity** — for coding questions only, one entry per axis: \`time\`, \`space\`, and
  \`output\` (the size of the returned result). Omit the array entirely for non-coding
  questions. Each entry carries:
  - **stated** — the complexity the candidate CLAIMED, normalised to big-O. If they revised
    it during the round, give their FINAL claim.
    **If they never stated it, this is null.** Never infer it from their code, never
    back-fill it from what you know the answer to be. A fabricated claim is far worse than
    a blank here: the entire point of this field is to show the candidate what they
    actually said, and "not stated" is itself a useful finding.
  - **statedQuote** — their exact words making that claim, verbatim from the transcript.
    Null whenever \`stated\` is null. When they said it is measured from this quote
    afterwards, so quote the FINAL claim, not the first.
  - **actual** — the true cost of THE CODE THE CANDIDATE WROTE, not of the ideal solution.
    Analyse the code in "What the candidate wrote" as it actually stands. If their algorithm
    is suboptimal, this is the suboptimal figure — that is the point of the column.
  - **optimal** — the cost of the modelSolution you just produced.
  - **correct** — true when \`stated\` matches \`actual\`, false when it does not, null when
    nothing was stated. Judge the CLAIM against THEIR OWN code, never against \`optimal\`:
    a candidate who correctly analyses a suboptimal solution was right, and must be marked
    right.

  Equivalent notations agree — "n log n", "O(n log n)" and "order n log n" are the same
  claim, and a candidate speaking aloud will say the third. Do not mark someone wrong for
  saying it in words. If they gave a bound that is correct but loose (they said O(n^2) and
  it is O(n log n)), that is \`correct: false\` — but say so precisely in whatWasMissing.
- **score** — 0 to 10
- **verdict** — one of: ${VERDICTS.join(', ')}

When each question was asked is measured from the transcript after you return,
by matching your \`question\` text, so keep \`question\` close to the
interviewer's own words.

${assigned.length ? assignedSection(input.mode, assigned.length, assignedList) : ''}${focusSection(input.focus ?? [], !!input.isDrill)}### Delivery
Score EVERY dimension below, 1 to 5, against its anchors. Higher is always better.

**Every score must carry an evidenceQuote — a verbatim fragment of what the CANDIDATE said.**
Quote the candidate, never the interviewer. A score without evidence is generic coaching, which is
exactly what this report exists to avoid. The same quote may support more than one dimension.
Set evidenceQuote to null ONLY if the dimension genuinely never arose, and say so in the assessment.

Do not worry about evidenceAtMs. You have no word timestamps and cannot know it; it is measured
from the recording after you return, by locating your quote in the waveform. Give the QUOTE
accurately and in the candidate's own words — that is what makes the timestamp findable.

${dimensions}

### Overall
- **overallScore** — 0 to 100, weighing content and delivery together
- **overallVerdict** — would this round pass at the stated calibration?
- **summary** — 3 to 5 sentences. Lead with the single most important thing. Write to the
  candidate as "you". Be direct: if they would not pass, say so and say why.
- **topFixes** — exactly the 3 changes that would most improve the next round, ranked.
  Each must be an instruction, not an observation.

## Tone

Write as a fair, experienced interviewer who wants this person to improve — direct about problems,
specific about fixes, never harsh for its own sake and never softened into vagueness. Praise only
what earned it. This is rubric version ${RUBRIC_VERSION}.
`.trim();
}
