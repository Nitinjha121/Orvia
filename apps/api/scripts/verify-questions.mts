/**
 * Verifies multi-question rounds: question tracking, transitions between problems,
 * and scope guards preventing restarting or hallucinating problems.
 * Checks against real question text from the committed bank.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QuestionTracker, type TrackedQuestion } from '../src/interview/question-tracker';
import { QuestionScopeGuard } from '../src/interview/question-scope-guard';
import { buildInterviewerPrompt } from '../src/interview/prompts/interviewer.prompt';
import { extractConstraints, keepConstraints } from './leetcode.mts';

let pass = 0;
const fails: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++;
  else fails.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};

/** The committed snapshot, so this runs offline like `seed` does. */
async function bank(): Promise<Map<string, TrackedQuestion>> {
  const path = join(import.meta.dirname, 'data', 'question-bank.seed.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as
    | { questions?: { id: string; title: string; prompt: string }[] }
    | { id: string; title: string; prompt: string }[];
  const rows = Array.isArray(raw) ? raw : (raw.questions ?? []);
  return new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, prompt: r.prompt }]));
}

type BankRow = {
  id: string;
  practiceUrl?: string | null;
  fromTitleOnly?: boolean;
  constraints?: string[] | null;
};

async function bankRows(): Promise<BankRow[]> {
  const path = join(import.meta.dirname, 'data', 'question-bank.seed.json');
  return (JSON.parse(await readFile(path, 'utf8')) as { questions: BankRow[] }).questions;
}

function need(b: Map<string, TrackedQuestion>, id: string): TrackedQuestion {
  const q = b.get(id);
  if (!q) throw new Error(`question "${id}" is not in the committed bank`);
  return q;
}

async function main() {
  console.log('\n\x1b[1mMulti-question round verification\x1b[0m\n');
  const b = await bank();

  const twoSum = need(b, 'two-sum');
  const validParens = need(b, 'valid-parentheses');
  const palindrome = need(b, 'palindrome-partitioning');

  /* ── 1. a single-question round never moves ─────────────────────────────── */
  console.log('\x1b[1m1. single-question rounds are inert\x1b[0m');
  {
    const t = new QuestionTracker([twoSum]);
    check('index starts at 0', t.index === 0);
    check(
      'reading the only problem aloud does not "advance"',
      t.observe(twoSum.prompt) === null,
    );
    check('select() refuses an out-of-range index', t.select(1) === false);
    check('select() refuses the index already current', t.select(0) === false);
  }

  /* ── 2. the announcement moves the round ────────────────────────────────── */
  console.log('\n\x1b[1m2. the interviewer announcing the next question\x1b[0m');
  {
    const t = new QuestionTracker([twoSum, validParens, palindrome]);
    check('opening on question one stays on question one', t.observe(
      `Hello. This round will focus on data structures and algorithms. ${twoSum.prompt} What's your approach?`,
    ) === null, `idx ${t.index}`);

    const moved = t.observe("Right, that's enough on that one. Let's move on to question two.");
    check('"let\'s move on to question two" advances to index 1', moved === 1, `got ${moved}`);
    check('tracker reports the new current question', t.current?.id === validParens.id,
      t.current?.title ?? '(none)');

    const again = t.observe('So, question two. What is your approach here?');
    check('repeating the same announcement does not advance again', again === null, `idx ${t.index}`);

    const third = t.observe('Good. Now, the third problem.');
    check('"the third problem" advances to index 2', third === 2, `got ${third}`);
  }

  /* ── 3. digits are not spoken, words are ────────────────────────────────── */
  console.log('\n\x1b[1m3. ordinals as spoken words\x1b[0m');
  {
    const t = new QuestionTracker([twoSum, validParens]);
    check('"question 2" as a digit does not advance (never appears in speech)',
      t.observe('Now question 2.') === null);
    check('"the second question" advances', t.observe('Now, the second question.') === 1);
  }
  {
    // An ordinal before "problem" is also how a flaw in the code is described.
    // Each of these moved the round when the ordinal alone was an announcement.
    for (const remark of [
      "There's a second problem with that loop.",
      'Now there is a second problem with the pointer, it never resets.',
      'That fixes it, but let me point out a second problem in the base case.',
      'And the second problem is that you never reset the pointer.',
    ]) {
      const t = new QuestionTracker([twoSum, validParens]);
      check(`a remark about the code does not advance: "${remark.slice(0, 36)}..."`,
        t.observe(remark) === null, `idx ${t.index}`);
    }
    const t = new QuestionTracker([twoSum, validParens]);
    check('"let\'s look at the second problem" advances',
      t.observe("Okay, let's look at the second problem.") === 1);
    // Announcements that name the ordinal without "move" — each advanced when
    // the ordinal alone was enough, and must still.
    for (const line of [
      "We'll now turn to the second problem.",
      "Here's the second question.",
      'For the second question, you are given a string of brackets.',
      'Great. The second problem is about brackets.',
      'Alright, second question.',
      'Our second problem today is about brackets.',
    ]) {
      const a = new QuestionTracker([twoSum, validParens]);
      check(`announces the move: "${line.slice(0, 36)}"`, a.observe(line) === 1, `idx ${a.index}`);
    }
  }

  /* ── 4. reading the statement aloud, with no number ─────────────────────── */
  console.log('\n\x1b[1m4. the statement read aloud without a number\x1b[0m');
  {
    const t = new QuestionTracker([twoSum, palindrome]);
    const moved = t.observe(palindrome.prompt);
    check("question two's own statement advances the round", moved === 1, `got ${moved}`);
  }

  /* ── 5. what must NOT move the round ────────────────────────────────────── */
  console.log('\n\x1b[1m5. things that must not move the round\x1b[0m');
  {
    const t = new QuestionTracker([twoSum, validParens]);
    check('a follow-up on the current question does not advance',
      t.observe('And what about the time complexity of that approach?') === null);
    check('shared problem-statement boilerplate does not advance',
      t.observe('Given a string s, return the answer. You may assume the input is valid.') === null,
      `idx ${t.index}`);
    check('a generic nudge does not advance', t.observe('Take your time.') === null);
    check('the candidate\'s own words are never fed in — AI-only by construction',
      t.observe('') === null);
  }
  {
    // Backwards reference. The interviewer looking back at question one while
    // the round is on question two must not drag it back — going back is a
    // deliberate act the candidate performs.
    const t = new QuestionTracker([twoSum, validParens]);
    t.observe("Let's move on to question two.");
    const back = t.observe(
      `Earlier, on the first problem, you said this. ${twoSum.prompt}`,
    );
    check('a backwards reference does not move the round back', back === null, `idx ${t.index}`);
    check('the round is still on question two', t.index === 1);
  }

  /* ── 6. near-duplicate questions in one round ───────────────────────────── */
  console.log('\n\x1b[1m6. two similar questions in the same round\x1b[0m');
  {
    /**
     * The same problem twice. Nothing spoken can distinguish them, so the
     * honest answer is to not move on statement text alone — only the explicit
     * number can decide it.
     */
    const clone: TrackedQuestion = { ...twoSum, id: 'two-sum-clone', title: 'Two Sum' };
    const t = new QuestionTracker([twoSum, clone]);
    check('identical statements do not advance on text alone',
      t.observe(twoSum.prompt) === null, `idx ${t.index}`);
    check('the explicit number still advances', t.observe('Now, question two.') === 1);
  }

  /* ── 7. manual selection, both directions ───────────────────────────────── */
  console.log('\n\x1b[1m7. the candidate switching by hand\x1b[0m');
  {
    const t = new QuestionTracker([twoSum, validParens, palindrome]);
    check('forward selection works', t.select(2) === true && t.index === 2);
    check('BACKWARD selection works — the detector never does this',
      t.select(0) === true && t.index === 0);
    check('indexOfId finds a round question', t.indexOfId(palindrome.id) === 2);
    check('indexOfId returns -1 for a stale id', t.indexOfId('not-in-this-round') === -1);
    check('byId resolves a title', t.byId(validParens.id)?.title === validParens.title);
  }

  /* ── 8. fragments, not whole turns ──────────────────────────────────────── */
  console.log('\n\x1b[1m8. arriving as fragments\x1b[0m');
  {
    /**
     * Output transcription arrives in fragments and `finished` is never set, so
     * the detector has to work on pieces. Nothing may fire until enough has
     * accumulated to identify the question.
     */
    const t = new QuestionTracker([twoSum, validParens]);
    const pieces = ['Right,', " let's", ' move', ' on to', ' question', ' two.'];
    const results = pieces.map((p) => t.observe(p));
    check('no fragment advances early', results.slice(0, -1).every((r) => r === null),
      JSON.stringify(results));
    check('the fragment completing the phrase advances', results.at(-1) === 1);
  }

  /* ── 9. the interviewer inventing a problem ─────────────────────────────── */
  console.log('\n\x1b[1m9. a problem that is not in the round\x1b[0m');
  {
    /**
     * In a round with one question finished early, the interviewer should not
     * introduce unassigned problems when extra time remains.
     */
    const powerOfTwo = need(b, 'power-of-two');
    const INVENTED =
      "Right, let's move on. Given an array of integers, return true if any value " +
      'appears more than once, and return false if every element is distinct. ' +
      "What's your approach for this?";
    const EXCUSE =
      "We have some more time, so we're moving on to the next question. " +
      'How would you determine if an array contains duplicates?';

    const g = new QuestionScopeGuard([powerOfTwo]);
    const caught = g.observe(INVENTED, 0);
    check('the invented problem is caught on the turn it is asked', !!caught,
      caught ? caught.reason : 'not caught');
    check('caught by its SHAPE, not by an announcement it never made',
      caught?.reason === 'stated_foreign_problem',
      'the turn announced only "let\'s move on"');
    check('the "we have some more time" excuse is caught too',
      new QuestionScopeGuard([powerOfTwo]).observe(EXCUSE, 0)?.reason === 'announced_next');

    // Everything the interviewer legitimately said in that same round.
    const g2 = new QuestionScopeGuard([powerOfTwo]);
    const innocent = [
      'Understood. Before you write the code, could you tell me what you expect the ' +
        'time and space complexity to be for that approach?',
      'Okay. Go ahead and start coding your solution.',
      'Right. And how would you handle that?',
      'Take your time. What are you concluding about the binary representation?',
      "Let's move on to the complexity of that approach.",
      'Understood. Now that you have this implemented, can you walk me through how it ' +
        'would handle an input of negative eight?',
      powerOfTwo.prompt,
    ];
    check('nothing it legitimately said fires the guard',
      innocent.every((t) => g2.observe(t, 0) === null));

    // A changed constraint on the SAME problem is what the prompt asks for
    // when time is left, and it keeps the problem's own vocabulary.
    check('a constraint variation on the same problem does not fire',
      new QuestionScopeGuard([powerOfTwo]).observe(
        'Given an integer n, suppose we wanted a power of four rather than a power of ' +
          'two. Return true in that case. How would your approach change?',
        0,
      ) === null);

    /**
     * The safety property: every check requires the round to be on its LAST
     * question, so a real transition in a multi-question round is untouchable.
     */
    const twoQ = new QuestionScopeGuard([twoSum, validParens]);
    check('a genuine move to question two does not fire',
      twoQ.observe("Right, let's move on to question two. " + validParens.prompt, 0) === null);
    check('but inventing a third one, on the last question, does',
      twoQ.observe(INVENTED, 1)?.reason === 'stated_foreign_problem');

    // One turn must not be counted twice — the boundary hook can be reached
    // more than once for the same accumulated text.
    const dup = new QuestionScopeGuard([powerOfTwo]);
    check('the same turn is only ruled on once',
      dup.observe(INVENTED, 0)?.count === 1 && dup.observe(INVENTED, 0) === null);
  }

  /* ── 10. the interviewer restarting the round ───────────────────────────── */
  console.log('\n\x1b[1m10. a problem the round already finished\x1b[0m');
  {
    /**
     * When questions are finished early with time remaining, the interviewer
     * must not cycle back and re-read previously finished questions.
     */
    const binarySearch = need(b, 'binary-search');
    const cloneGraph = need(b, 'clone-graph');
    const spiral = need(b, 'spiral-matrix');
    const round = [binarySearch, cloneGraph, spiral];

    const REREAD_Q2 =
      "Right, let's move on to question two. Given a reference of a node in a " +
      'connected undirected graph, return a deep copy, a clone, of the graph. Each ' +
      'node in the graph contains a value, an integer, and a list of its neighbors. ' +
      'The given node will always be the first node with value one. How would you ' +
      'approach solving this?';
    const REREAD_Q1 =
      "Right, let's move on to question one. Given an array of integers nums which " +
      'is sorted in ascending order, and an integer target, write a function to ' +
      'search target in nums. If target exists, then return its index. Otherwise, ' +
      'return negative one. You must write an algorithm with O of log n runtime ' +
      'complexity.';
    const APOLOGY =
      'My apologies. Given a reference of a node in a connected undirected graph, ' +
      'return a deep copy clone of the graph. Each node in the graph contains a ' +
      'value and a list of its neighbors. You must return the copy of the given ' +
      "node as a reference to the cloned graph. What's your approach for cloning " +
      'this graph?';

    for (const [name, turn] of [
      ['question two, re-read while on question three', REREAD_Q2],
      ['question one, re-read after that', REREAD_Q1],
      ['and question two again, after the candidate said it was done', APOLOGY],
    ] as const) {
      const g = new QuestionScopeGuard(round);
      const v = g.observe(turn, 2);
      check(`caught: ${name}`, v?.reason === 'restated_finished_problem',
        v ? v.reason : 'not caught — restating finished problem');
    }

    check('the note can name the problem it just re-read',
      new QuestionScopeGuard(round).observe(REREAD_Q1, 2)?.question?.id === binarySearch.id);

    /**
     * NOT gated on being the last question. Going back to question two while
     * on question three of five is the identical failure, and the invention
     * checks' "no question after this one" gate would hide it.
     */
    check('going backward fires even with questions still ahead',
      new QuestionScopeGuard(round).observe(REREAD_Q1, 1)?.reason ===
        'restated_finished_problem');

    /* ── what must NOT fire ──────────────────────────────────────────────── */

    // Reading a problem out for the FIRST time is the whole job.
    const fwd = new QuestionScopeGuard(round);
    check('the opening statement of question one does not fire',
      fwd.observe(`Hello. Let's start with question one. ${binarySearch.prompt}`, 0) === null);
    check('a genuine move to question two does not fire',
      fwd.observe(`Right, let's move on to question two. ${cloneGraph.prompt}`, 0) === null);
    check('a genuine move to question three does not fire',
      fwd.observe(`Right, let's move on to question three. ${spiral.prompt}`, 1) === null);

    /**
     * Re-reading the CURRENT problem is left alone: the candidate asks "sorry,
     * could you repeat the question?" and they are owed an answer.
     */
    check('re-reading the problem they are working on does not fire',
      new QuestionScopeGuard(round).observe(`Of course. ${spiral.prompt}`, 2) === null);

    /**
     * The one case this must never touch. Going back into a finished problem
     * to push FURTHER on it is exactly what "go DEEPER, never wider" asks for
     * when the material runs out early — and it is what the interviewer should
     * have done instead of any of the three turns above.
     */
    const deeper = new QuestionScopeGuard(round);
    const legitimate = [
      'Earlier, on the clone graph, you used a hash map keyed by node value. What ' +
        'would change if two nodes could share a value?',
      'Going back to your binary search for a moment — you computed the midpoint as ' +
        'left plus right over two. Is there anything you would change about that?',
      'You said the spiral solution was constant space. Does that still hold if we ' +
        'had to return the result reversed?',
      'Let me ask about the first problem again. Why did you choose to return minus ' +
        'one rather than raising an error?',
    ];
    check('referring back to a finished problem to go deeper never fires',
      legitimate.every((t) => deeper.observe(t, 2) === null),
      legitimate.map((t) => deeper.observe(t, 2)?.reason ?? '-').join(', '));

    /**
     * A changed constraint on a FINISHED problem is still deepening, and it is
     * the case `MIN_REREAD_HITS` is set to clear: the measurement under it puts
     * a constraint variation at 3 distinctive hits against the real re-reads'
     * 26 to 32.
     */
    check('a constraint variation on a finished problem does not fire',
      new QuestionScopeGuard(round).observe(
        'Suppose that sorted array had been rotated at some unknown pivot. Would you ' +
          'still find the target in log n, and what would you change?',
        2,
      ) === null);
  }

  /* ── 11. the interviewer restarting the question it is already on ───────── */
  console.log('\n\x1b[1m11. the current question, introduced twice\x1b[0m');
  {
    /**
     * Catches re-announcing and re-introducing the current question while
     * already actively working on it.
     */
    const uniquePaths = need(b, 'unique-paths');
    const trie = need(b, 'implement-trie-prefix-tree');
    const partition = need(b, 'partition-labels');
    const round = [uniquePaths, trie, partition];

    const INTRO_Q3 =
      "Right, let's move on to question three. You're given a string s. We want to " +
      'partition the string into as many parts as possible so that each letter appears ' +
      'in at most one part. Return a list of integers representing the size of these ' +
      'parts.';
    const BETWEEN = 'Okay. What are you thinking?';

    const g = new QuestionScopeGuard(round);
    check('introducing question three for the FIRST time is the job, not a fault',
      g.observe(INTRO_Q3, 2) === null);
    g.observe(BETWEEN, 2);
    const second = g.observe(INTRO_Q3, 2);
    check('announcing the same move a second time is caught',
      second?.reason === 'reintroduced_current_problem',
      second ? second.reason : 'not caught — reintroducing current problem');
    check('the note can name the problem it restarted',
      second?.question?.id === partition.id);

    /**
     * The case this must never touch. "Sorry, could you repeat the question?"
     * is owed a straight re-read, and that re-read is the SAME STATEMENT — so
     * what separates it is only that it announces no move. Deliberately not
     * keyed on the ordinal: the interviewer says "question three" here too.
     */
    const asked = new QuestionScopeGuard(round);
    asked.observe(INTRO_Q3, 2);
    asked.observe(BETWEEN, 2);
    check('re-reading it because the candidate asked does not fire',
      asked.observe(`Sure. Question three. ${partition.prompt}`, 2) === null,
      'a repeat on request announces no move');

    /**
     * And the first introduction of every question in order stays silent —
     * a whole healthy round must pass through this untouched.
     */
    const healthy = new QuestionScopeGuard(round);
    const verdicts = [
      healthy.observe(`Let's start with question one. ${uniquePaths.prompt}`, 0),
      healthy.observe('Understood. Go ahead and start coding when you are ready.', 0),
      healthy.observe(`Right, let's move on to question two. ${trie.prompt}`, 1),
      healthy.observe('What will the node class contain?', 1),
      healthy.observe(`Right, let's move on to question three. ${partition.prompt}`, 2),
      healthy.observe('And what would be the time and space complexity for that?', 2),
    ];
    check('a healthy three-question round never fires',
      verdicts.every((v) => v === null),
      JSON.stringify(verdicts.map((v) => v?.reason ?? null)));
  }

  /* ── 12. constraints: kept, carried, and handed to the interviewer ──────── */
  // Without constraints from problem statements, the interviewer may hallucinate
  // incorrect bounds when asked by the candidate.
  console.log('\n\x1b[1m12. constraints come from LeetCode, not the interviewer\x1b[0m');
  {
    const fixture =
      '<p>Return the intervals.</p><p><strong>Example 1:</strong></p><pre>x</pre>' +
      '<p><strong>Constraints:</strong></p>\n<ul>\n' +
      '\t<li><code>0 &lt;= intervals.length &lt;= 10<sup>4</sup></code></li>\n' +
      '\t<li><code>0 &lt;= start<sub>i</sub> &lt;= end<sub>i</sub> &lt;= 10<sup>5</sup></code></li>\n' +
      '\t<li><code>intervals</code> is sorted by <code>start<sub>i</sub></code> in <strong>ascending</strong> order.</li>\n' +
      '\t<li><code>-10<sup>9</sup> &le; x &ge; 1</code></li>\n' +
      '</ul>\n<p><strong>Follow up:</strong></p><ul><li>not a constraint</li></ul>';
    const got = extractConstraints(fixture);
    check('the Constraints list is extracted line by line, <sup> as ^ and <sub> as _',
      JSON.stringify(got) === JSON.stringify([
        '0 <= intervals.length <= 10^4',
        '0 <= start_i <= end_i <= 10^5',
        'intervals is sorted by start_i in ascending order.',
        '-10^9 <= x >= 1',
      ]),
      JSON.stringify(got));
    check('a statement with no Constraints heading yields null, not a guess',
      extractConstraints('<p>No list here.</p><ul><li>1 &lt;= n</li></ul>') === null);
    check('a Constraints heading with no list yields null',
      extractConstraints('<p><strong>Constraints:</strong> n is small.</p>') === null);
    check('no content (paid-only) yields null', extractConstraints(null) === null);

    check('a fetched list replaces the stored one', keepConstraints(['a'], ['b'])?.[0] === 'a');
    check('a failed or empty fetch keeps the stored list',
      keepConstraints(null, ['b'])?.[0] === 'b' && keepConstraints([], ['b'])?.[0] === 'b' &&
        keepConstraints(undefined, ['b'])?.[0] === 'b');
    check('nothing on either side stays null', keepConstraints(null, undefined) === null);

    const ingestSrc = await readFile(join(import.meta.dirname, 'ingest-questions.mts'), 'utf8');
    const seedSrc = await readFile(join(import.meta.dirname, 'seed.ts'), 'utf8');
    check('the ingest upsert never writes an empty list over a real one',
      /constraints: raw`case when coalesce\(jsonb_array_length\(excluded\.constraints\), 0\) > 0\s+then excluded\.constraints else dsa_questions\.constraints end`/
        .test(ingestSrc));
    check('seed replays the snapshot faithfully, uncoalesced',
      /constraints: raw`excluded\.constraints`/.test(seedSrc));

    const rows = await bankRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines = (id: string) => byId.get(id)?.constraints ?? [];
    for (const id of ['jump-game', 'partition-equal-subset-sum', 'insert-interval', 'merge-intervals', 'pacific-atlantic-water-flow']) {
      check(`the committed bank carries constraints for ${id}`, lines(id).length > 0);
    }
    check('insert-interval says newInterval always has two elements',
      lines('insert-interval').includes('newInterval.length == 2'), JSON.stringify(lines('insert-interval')));
    check('partition-equal-subset-sum says values start at one',
      lines('partition-equal-subset-sum').includes('1 <= nums[i] <= 100'));
    const free = rows.filter((r) => !r.practiceUrl && !r.fromTitleOnly);
    const bare = free.filter((r) => !r.constraints?.length).map((r) => r.id);
    check('every problem with a LeetCode statement carries its constraints',
      bare.length === 0, bare.join(', '));

    const prompt = buildInterviewerPrompt({
      config: { mode: 'dsa', language: 'python', codeEditor: true, questionIds: ['insert-interval', 'x'] } as never,
      options: { durationMinutes: 50, difficulty: 'standard', persona: 'neutral', voice: 'Charon' },
      questions: [
        { id: 'insert-interval', title: 'Insert Interval', difficulty: 'medium', prompt: 'Insert it.',
          constraints: lines('insert-interval') },
        { id: 'x', title: 'X', difficulty: 'easy', prompt: 'Do x.', constraints: null },
      ],
    });
    check('the interviewer is given each problem\'s constraints',
      prompt.includes('- newInterval.length == 2') && /not part of the statement/.test(prompt));
    check('...told when a problem has none, so "unspecified" is a real answer',
      /Constraints: none are listed for this problem\./.test(prompt));
    check('...and told to answer only from them, never inventing a range or an empty input',
      /Constraints come from the list under each problem and nowhere else/.test(prompt) &&
        /say it is not specified/.test(prompt) && /Never\s+invent a range/.test(prompt));
  }

  console.log(
    `\n\x1b[1m${pass} passed${fails.length ? `, \x1b[31m${fails.length} failed\x1b[0m` : ''}\x1b[0m`,
  );
  if (fails.length) {
    console.log(fails.map((f) => `  \x1b[31m✗\x1b[0m ${f}`).join('\n'));
    process.exit(1);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
