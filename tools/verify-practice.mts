/**
 * Offline verification suite for question bank integrity, random draw logic,
 * attempt derivation, drill moment extraction, and practice planning calculations.
 */
import {
  CONCEPT_TOPICS, CONCEPT_QUESTIONS,
  BEHAVIOURAL_COMPETENCIES, BEHAVIOURAL_QUESTIONS,
  HR_SCENARIOS,
} from '../apps/api/scripts/data/conversational-banks.mts';
import DSA_BANK from '../apps/api/scripts/data/question-bank.seed.json' with { type: 'json' };
import {
  cycleAttempts, cycleTally, drawOne, eligible, emptyPoolNote, isSpent, matchesRules,
  ruleMatches, DEFAULT_DRAW_RULES, SURPRISE_MODES,
  attemptsFromRounds, latestEvaluationBySession,
  type DrawCandidate, type DrawRules, type PracticeAttempt, type HandoutRound,
} from '../packages/shared/src/practice.js';
import { titlesAgree } from './title-match.mts';
import {
  COMMITMENT_CLOSE_STREAK, MAX_DRILL_FOCUS, commitmentProgress, deriveMoments, drillQuestionMatch,
  matchBankQuestion, questionAt, type MomentSource,
} from '../packages/shared/src/drills.js';
import {
  daysUntil, longestDayStreak, loopDecision, loopProgress, personalBests, readiness, weekOf,
  weeklyPlan, weeklyRecap, type PlanRound,
} from '../packages/shared/src/plan.js';
import {
  RESOLVE_INTERVALS_DAYS, isDue, resolveQueue, type ResolveAttempt,
} from '../packages/shared/src/resolve.js';
import { cutShortCause, endedCutShort } from '../apps/web/src/lib/roundEnd.ts';
import { micErrorMessage } from '../apps/web/src/lib/micError.ts';
import { sameComplexity, splitComplexity } from '../apps/web/src/lib/complexity.ts';
import { ALL_CONCEPTS, STUDY_GUIDES, conceptsOf } from '../apps/web/src/lib/study.ts';
import { STUDY_TABS } from '../apps/web/src/lib/studyModes.ts';
import { INTERVIEW_MODES } from '../packages/shared/src/modes.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The playbook is private and left out of the public repo; its checks run only where it exists. */
type Playbook = {
  BEATS: readonly string[];
  PATTERN_SCRIPTS: { pattern: string; example: string; trap: string; beats: Record<string, { ask: string; eg: string }> }[];
  PHRASES: { situation: string; when: string; instead?: string; say: string[] }[];
  QUESTION_TYPES: Record<(typeof INTERVIEW_MODES)[number], { type: string; cue: string; open: string; trap?: string; structure: string[] }[]>;
};
const PLAYBOOK_FILE = fileURLToPath(new URL('../apps/web/src/lib/playbook.ts', import.meta.url));
const playbook: Playbook | null = existsSync(PLAYBOOK_FILE) ? await import(PLAYBOOK_FILE) : null;

let passed = 0;
const failures: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) passed++;
  else failures.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};

const rules = (over: Partial<DrawRules> = {}): DrawRules => ({ ...DEFAULT_DRAW_RULES, ...over });

/** A DSA-shaped bank: difficulty plus several topics. */
const dsa: DrawCandidate[] = [
  { id: 'two-sum', facets: { difficulty: ['easy'], topic: ['arrays', 'hash-table'] } },
  { id: 'valid-parens', facets: { difficulty: ['easy'], topic: ['stack', 'string'] } },
  { id: 'word-ladder', facets: { difficulty: ['hard'], topic: ['graphs', 'bfs'] } },
  { id: 'coin-change', facets: { difficulty: ['medium'], topic: ['dp'] } },
  { id: 'course-schedule', facets: { difficulty: ['medium'], topic: ['graphs', 'dp'] } },
];

/** A concepts-shaped bank: difficulty plus exactly one topic. */
const concepts: DrawCandidate[] = [
  { id: 'nodejs-event-loop-phases', facets: { difficulty: ['medium'], topic: ['nodejs'] } },
  { id: 'nodejs-semver-lockfile', facets: { difficulty: ['easy'], topic: ['nodejs'] } },
  { id: 'kafka-partitions-ordering', facets: { difficulty: ['medium'], topic: ['kafka'] } },
  { id: 'react-controlled-inputs', facets: { difficulty: ['easy'], topic: ['react'] } },
];

/** A system design bank: one facet, and no verdicts will ever arrive. */
const design: DrawCandidate[] = [
  { id: 'tinyurl', facets: { level: ['mid'] } },
  { id: 'rate-limiter', facets: { level: ['senior'] } },
  { id: 'search-system', facets: { level: ['staff'] } },
];

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const attempt = (
  id: string,
  outcome: PracticeAttempt['outcome'],
  minutesAgo = 5,
): PracticeAttempt => ({ id, count: 1, lastAt: at(minutesAgo), outcome });

/**
 * The floor for one topic. Twelve is what the bank carries; the check is at
 * ten so a question can be removed without a red suite, and no lower, because
 * a topic you cannot get through in three rounds is the complaint this bank
 * was rebuilt to answer.
 */
const MIN_PER_TOPIC = 10;
/**
 * And per difficulty within a topic. The rules panel lets you ask for "easy,
 * Kafka" — if that pair is empty the button greys out with an explanation
 * nobody asked for. Two, so removing one question does not break it.
 */
const MIN_PER_DIFFICULTY = 2;
const MIN_PER_COMPETENCY = 4;

/** Read aloud, so: no markdown, no code, no symbols, and numbers as words. */
const UNSPEAKABLE = /[`*_#|{}<>[\]]|\d/;

async function main() {
  console.log('\n\x1b[1mOrvia — the question banks and the random draw, offline\x1b[0m\n');

  /* 0. the bank behind the draw ------------------------------------------- */
  console.log('\x1b[1m0. the bank is big enough to draw from\x1b[0m');

  const byTopic = new Map<string, typeof CONCEPT_QUESTIONS>();
  for (const q of CONCEPT_QUESTIONS) {
    byTopic.set(q.topic, [...(byTopic.get(q.topic) ?? []), q]);
  }

  const ids = CONCEPT_QUESTIONS.map((q) => q.id);
  check('concept question ids are unique', new Set(ids).size === ids.length,
    `${ids.length} questions`);
  check('every question belongs to a topic that exists',
    CONCEPT_QUESTIONS.every((q) => CONCEPT_TOPICS.some((t) => t.id === q.topic)));
  check('every topic has questions', byTopic.size === CONCEPT_TOPICS.length,
    `${byTopic.size} of ${CONCEPT_TOPICS.length} topics populated`);

  const thin = CONCEPT_TOPICS.filter((t) => (byTopic.get(t.id) ?? []).length < MIN_PER_TOPIC);
  check(`every topic carries at least ${MIN_PER_TOPIC} questions`, thin.length === 0,
    thin.length
      ? thin.map((t) => `${t.id}=${(byTopic.get(t.id) ?? []).length}`).join(', ')
      : CONCEPT_TOPICS.map((t) => `${t.id}=${(byTopic.get(t.id) ?? []).length}`).join(' '));

  const gaps: string[] = [];
  for (const t of CONCEPT_TOPICS) {
    for (const d of ['easy', 'medium', 'hard'] as const) {
      const n = (byTopic.get(t.id) ?? []).filter((q) => q.difficulty === d).length;
      if (n < MIN_PER_DIFFICULTY) gaps.push(`${t.id}/${d}=${n}`);
    }
  }
  check(`and at least ${MIN_PER_DIFFICULTY} at each difficulty, so a difficulty rule never empties a topic`,
    gaps.length === 0, gaps.join(', ') || 'every topic spans easy, medium and hard');

  const unspeakable = CONCEPT_QUESTIONS.filter((q) => UNSPEAKABLE.test(q.prompt));
  check('every prompt is speakable — no markdown, no code, no digits',
    unspeakable.length === 0, unspeakable.map((q) => q.id).join(', '));
  const thinContent = CONCEPT_QUESTIONS.filter(
    (q) => q.probes.length < 3 || q.expectedPoints.length < 4 || q.commonMistakes.length < 2,
  );
  check('every question carries probes for the interviewer and answers for the evaluator',
    thinContent.length === 0, thinContent.map((q) => q.id).join(', '));

  const behaviouralThin = BEHAVIOURAL_COMPETENCIES.filter(
    (c) => BEHAVIOURAL_QUESTIONS.filter((q) => q.competency === c.id).length < MIN_PER_COMPETENCY,
  );
  check(`every competency carries at least ${MIN_PER_COMPETENCY} questions`,
    behaviouralThin.length === 0, behaviouralThin.map((c) => c.id).join(', '));
  check('behavioural ids are unique and their competencies exist',
    new Set(BEHAVIOURAL_QUESTIONS.map((q) => q.id)).size === BEHAVIOURAL_QUESTIONS.length &&
      BEHAVIOURAL_QUESTIONS.every((q) => BEHAVIOURAL_COMPETENCIES.some((c) => c.id === q.competency)));
  check('every HR scenario has ordered beats with a pressure line',
    HR_SCENARIOS.length > 0 &&
      HR_SCENARIOS.every((s) => s.beats.length >= 3 && s.beats.every((b) => b.ask && b.pressure)),
    `${HR_SCENARIOS.length} scenarios`);

  console.log('');

  /* 0b. the DSA bank's starter code ---------------------------------------- */
  /**
   * Checked against the COMMITTED SNAPSHOT rather than the database, for the
   * same reason section 0 reads the conversational banks from their file: the
   * snapshot is what a fresh clone gets, and a database that happens to be
   * right locally proves nothing about it.
   *
   * What this is really guarding is a wipe. The paid-only problems' skeletons
   * do not come from LeetCode — it publishes none for them — they come from
   * LintCode through `pnpm scrape:premium`, into a committed file that
   * `ingest` reads at startup. An ingest that cannot read that file produces
   * empty snippet maps, and before this the upsert would have written them
   * straight over the good ones and `export-seed` would have committed the
   * loss. That is not hypothetical: it is exactly how 42 problems nearly lost
   * their reference solutions, and the only reason it was recoverable was git.
   *
   * A problem reverting to `def solve(): pass` is quieter than that was, which
   * is worse. It looks like a question nobody got round to rather than a
   * question something broke.
   */
  console.log('\x1b[1m0b. every DSA problem opens on a real skeleton\x1b[0m');

  type BankQuestion = {
    id: string;
    codeSnippets: Record<string, string> | null;
    practiceUrl: string | null;
  };
  const bank = DSA_BANK.questions as BankQuestion[];
  const langsOf = (q: BankQuestion) => Object.keys(q.codeSnippets ?? {});

  /**
   * `robot-room-cleaner` is the one genuine hole in the bank and is named
   * here rather than counted, so that it staying broken is a deliberate fact
   * in the source instead of a number nobody questions. It is paid-only on
   * LeetCode, published by neither NeetCode nor LintCode without a login, and
   * is the last problem whose statement is still a model reconstruction.
   */
  const NO_SOURCE = new Set(['robot-room-cleaner']);

  const stubbed = bank.filter((q) => !NO_SOURCE.has(q.id) && !langsOf(q).length);
  check('every problem carries starter code',
    stubbed.length === 0,
    stubbed.length
      ? stubbed.map((q) => q.id).join(', ')
      : `${bank.length - NO_SOURCE.size} of ${bank.length}, known gap: ${[...NO_SOURCE].join(', ')}`);

  // Python is the floor because it is the default language and the one every
  // source publishes. A problem with snippets but not that one would open on
  // the generic stub for most people.
  const noPython = bank.filter((q) => !NO_SOURCE.has(q.id) && !langsOf(q).includes('python'));
  check('including Python, which the editor opens on by default',
    noPython.length === 0, noPython.map((q) => q.id).join(', '));

  /**
   * The link and the code are ONE fact, checked in both directions.
   *
   * A LintCode skeleton takes LintCode's own types — `List<Interval>` where
   * LeetCode would say `int[][]` — so it compiles against LintCode's judge and
   * nowhere else. Shipping it without the link leaves the candidate holding a
   * signature they cannot run; shipping the link without it would point at a
   * judge for code they did not get.
   */
  const premium = bank.filter((q) => q.practiceUrl);
  check('the paid-only problems say where their code runs',
    premium.length > 0 && premium.every((q) => langsOf(q).length > 0),
    `${premium.length} with a practice URL`);
  check('and every practice URL is a LintCode problem page',
    premium.every((q) => /^https:\/\/www\.lintcode\.com\/problem\/[a-z0-9-]+\/$/.test(q.practiceUrl!)),
    premium.find((q) => !/^https:\/\/www\.lintcode\.com\/problem\/[a-z0-9-]+\/$/.test(q.practiceUrl!))?.id ?? 'all well-formed');

  /**
   * Each link must name its OWN problem.
   *
   * This is the wrong-page failure the scraper refuses at source, pinned again
   * here because the two guards protect different things. There, a mismatched
   * title stops a bad row being written; here, a mismatched SLUG catches a URL
   * that got attached to the wrong question somewhere between the scrape and
   * the snapshot — a join, a sort, a hand edit. Sending a candidate to a judge
   * for a different problem is the same cost either way, and it is silent:
   * the page loads, it is just not their question.
   */
  const misaimed = premium.filter((q) => q.practiceUrl !== `https://www.lintcode.com/problem/${q.id}/`);
  check('and each link points at that same problem, not another one',
    misaimed.length === 0,
    misaimed.length ? misaimed.map((q) => `${q.id} -> ${q.practiceUrl}`).join(', ') : 'all 16 self-consistent');

  // The scraper's own guard. It accepted containment until this check, and
  // "Meeting Rooms" is contained in "Meeting Rooms II".
  const sequels: [string, string][] = [
    ['Meeting Rooms', 'Meeting Rooms II'],
    ['Word Break', 'Word Break II'],
    ['House Robber', 'House Robber II'],
  ];
  const leaked = sequels.filter(([a, b]) => titlesAgree(a, b) || titlesAgree(b, a));
  check('the title guard refuses a sequel for its original, in both directions',
    leaked.length === 0, leaked.map(([a, b]) => `${a} ~ ${b}`).join(', ') || 'all refused');
  const decorated: [string, string][] = [
    ['Meeting Rooms II', '919 · Meeting Rooms II'],
    ['Find Leaves of Binary Tree', '650 · Find Leaves of Binary Tree Medium'],
    ['Alien Dictionary', 'LintCode 892. Alien Dictionary Hard'],
    ['Two Sum II - Input Array Is Sorted', 'two sum ii input array is sorted'],
    ['01 Matrix', '01 Matrix'],
  ];
  const lost = decorated.filter(([a, b]) => !titlesAgree(a, b));
  check('and still accepts the same title under the decoration the sites add',
    lost.length === 0, lost.map(([a, b]) => `${a} vs ${b}`).join(', ') || `${decorated.length} accepted`);
  check('a leading number is decoration only behind a separator',
    !titlesAgree('Matrix', '01 Matrix') && !titlesAgree('Sum', '3Sum'));

  console.log('');

  /* 1. the rules ---------------------------------------------------------- */
  console.log('\x1b[1m1. what the rules allow\x1b[0m');

  check('no rules means the whole list', ruleMatches(dsa, rules()).length === dsa.length,
    `${ruleMatches(dsa, rules()).length} of ${dsa.length}`);
  check('an empty facet is no constraint, not "nothing allowed"',
    ruleMatches(dsa, rules({ facets: { difficulty: [], topic: [] } })).length === dsa.length);

  check('one difficulty narrows to it',
    ruleMatches(dsa, rules({ facets: { difficulty: ['easy'] } })).map((c) => c.id).join() ===
      'two-sum,valid-parens');

  // ANY-of within a facet. All-of would return course-schedule alone, and
  // "graphs plus dynamic programming" is a request to see MORE, not less.
  const anyOf = ruleMatches(dsa, rules({ facets: { topic: ['graphs', 'dp'] } })).map((c) => c.id);
  check('two topics widen the draw rather than narrowing it',
    anyOf.join() === 'word-ladder,coin-change,course-schedule', anyOf.join());

  // ALL-of across facets: difficulty and topic are independent questions.
  const across = ruleMatches(dsa, rules({ facets: { difficulty: ['medium'], topic: ['graphs'] } }));
  check('facets combine with AND', across.map((c) => c.id).join() === 'course-schedule');

  check('an unknown facet value matches nothing',
    ruleMatches(dsa, rules({ facets: { difficulty: ['trivial'] } })).length === 0);
  check('a facet the candidate does not carry excludes it',
    !matchesRules(design[0]!, rules({ facets: { difficulty: ['easy'] } })),
    'a design problem has a level, not a difficulty');
  check('a single-facet bank filters on its own facet',
    ruleMatches(design, rules({ facets: { level: ['mid', 'staff'] } })).map((c) => c.id).join() ===
      'tinyurl,search-system');

  /* 2. spent, and the verdict that decides it ----------------------------- */
  console.log('\n\x1b[1m2. what counts as spent\x1b[0m');

  const cycle = cycleAttempts(
    [
      attempt('two-sum', 'solved'),
      attempt('valid-parens', 'partial'),
      attempt('coin-change', 'unsolved'),
      attempt('word-ladder', null),
      attempt('course-schedule', 'not_reached'),
    ],
    null,
  );

  check('a solved question is spent', isSpent(cycle, 'two-sum', true));
  check('a partial solve is NOT spent', !isSpent(cycle, 'valid-parens', true),
    'a brute force never improved is unfinished business');
  check('an unsolved question is NOT spent', !isSpent(cycle, 'coin-change', true));
  check('no verdict yet IS spent', isSpent(cycle, 'word-ladder', true),
    'no report is not the same as a failed one');
  check('a question the round never reached is NOT spent',
    !isSpent(cycle, 'course-schedule', true));
  check('a question never asked at all is not spent', !isSpent(cycle, 'nothing', true));

  check('with "keep asking" off, being asked is enough',
    ['two-sum', 'valid-parens', 'coin-change', 'word-ladder', 'course-schedule']
      .every((id) => isSpent(cycle, id, false)));

  const pool = eligible(dsa, rules(), cycle).map((c) => c.id);
  check('the pool keeps exactly the unfinished business',
    pool.join() === 'valid-parens,coin-change,course-schedule', pool.join());
  check('with repeats allowed, nothing is excluded',
    eligible(dsa, rules({ avoidRepeats: false }), cycle).length === dsa.length);
  check('rules and repeats compose',
    eligible(dsa, rules({ facets: { difficulty: ['easy'] } }), cycle).map((c) => c.id).join() ===
      'valid-parens');

  /* 2b. which evaluation speaks for a round ------------------------------- */
  console.log('\n\x1b[1m2b. which evaluation speaks for a round\x1b[0m');
  {
    // What `PracticeRotationService.attempted` does with the rows it reads:
    // pick each round's latest COMPLETE evaluation, then fold rounds into
    // attempts. A re-run INSERTS a row, so one round can have several.
    const spentAfter = (
      evals: { id: string; sessionId: string; status: string; createdAt: string }[],
      verdictsByEval: Record<string, Record<string, 'solved' | 'partial' | 'unsolved' | 'not_reached'>>,
    ) => {
      const latest = latestEvaluationBySession(evals);
      const e = latest.get('s1');
      const round: HandoutRound = {
        startedAt: at(30),
        ids: ['two-sum'],
        reachedIdx: 0,
        verdicts: e ? new Map(Object.entries(verdictsByEval[e.id] ?? {})) : null,
      };
      const attempts = attemptsFromRounds([round]);
      return {
        outcome: attempts[0]?.outcome,
        spent: isSpent(cycleAttempts(attempts, null), 'two-sum', true),
      };
    };

    const failedRerun = spentAfter(
      [
        { id: 'e1', sessionId: 's1', status: 'complete', createdAt: at(20) },
        { id: 'e2', sessionId: 's1', status: 'failed', createdAt: at(5) },
      ],
      { e1: { 'two-sum': 'unsolved' } },
    );
    check('a failed re-run does not retire a question the last report left unsolved',
      failedRerun.outcome === 'unsolved' && failedRerun.spent === false, JSON.stringify(failedRerun));

    const runningRerun = spentAfter(
      [
        { id: 'e1', sessionId: 's1', status: 'complete', createdAt: at(20) },
        { id: 'e2', sessionId: 's1', status: 'transcribing', createdAt: at(1) },
      ],
      { e1: { 'two-sum': 'unsolved' } },
    );
    check('nor does one still running',
      runningRerun.outcome === 'unsolved' && runningRerun.spent === false, JSON.stringify(runningRerun));

    const rerunSolved = spentAfter(
      [
        { id: 'e1', sessionId: 's1', status: 'complete', createdAt: at(20) },
        { id: 'e2', sessionId: 's1', status: 'complete', createdAt: at(5) },
      ],
      { e1: { 'two-sum': 'unsolved' }, e2: { 'two-sum': 'solved' } },
    );
    check('a completed re-run does change the verdict',
      rerunSolved.outcome === 'solved' && rerunSolved.spent === true, JSON.stringify(rerunSolved));

    const pending = spentAfter([{ id: 'e1', sessionId: 's1', status: 'pending', createdAt: at(1) }], {});
    check('a round with no completed evaluation stays retired',
      pending.outcome === null && pending.spent === true, JSON.stringify(pending));
    const none = spentAfter([], {});
    check('and so does one with no evaluation at all',
      none.outcome === null && none.spent === true, JSON.stringify(none));

    // Latest ROUND wins: solved in March, fumbled in April.
    const two = attemptsFromRounds([
      { startedAt: at(60), ids: ['two-sum'], reachedIdx: 0, verdicts: new Map([['two-sum', 'solved']]) },
      { startedAt: at(10), ids: ['two-sum'], reachedIdx: 0, verdicts: new Map([['two-sum', 'unsolved']]) },
    ]);
    check('the latest round wins, whatever order the rows arrive in',
      two.length === 1 && two[0]!.outcome === 'unsolved' && two[0]!.count === 2,
      JSON.stringify(two));

    const unreached = attemptsFromRounds([
      { startedAt: at(10), ids: ['a', 'b', 'c'], reachedIdx: 0, verdicts: null },
      { startedAt: at(5), ids: ['d'], reachedIdx: 0, verdicts: new Map([['d', 'not_reached']]) },
    ]);
    check('a position the round never reached, or a not_reached verdict, is no handout',
      unreached.map((a) => a.id).join() === 'a', unreached.map((a) => a.id).join());
  }

  /* 3. the cycle marker --------------------------------------------------- */
  console.log('\n\x1b[1m3. the cycle marker\x1b[0m');

  const older = [attempt('two-sum', 'solved', 120), attempt('coin-change', 'solved', 1)];
  const since = cycleAttempts(older, at(60));
  check('an attempt from before the cycle is history, not a repeat',
    !since.has('two-sum') && since.has('coin-change'), [...since.keys()].join());
  check('resetting the cycle restores the whole pool',
    eligible(dsa, rules(), cycleAttempts(older, new Date().toISOString())).length === dsa.length);

  // A corrupt marker must not silently mark the whole bank unused.
  check('an unparseable cycle marker counts everything',
    cycleAttempts(older, 'not-a-date').size === 2);
  check('an unparseable attempt timestamp is dropped rather than counted',
    cycleAttempts([{ id: 'x', count: 1, lastAt: 'nonsense', outcome: 'solved' }], null).size === 0);

  /* 4. the counter -------------------------------------------------------- */
  console.log('\n\x1b[1m4. the counter\x1b[0m');

  const tally = cycleTally(dsa, cycle);
  check('solved is counted separately from asked', tally.solved === 1, JSON.stringify(tally));
  check('partial and unsolved are "to retry"', tally.retry === 2);
  check('a missing report is "awaiting"', tally.pending === 1);
  check('not_reached is not counted as asked at all', tally.asked === 4,
    'the interviewer never got to it');
  check('a question outside the list is not counted',
    cycleTally(concepts, cycle).asked === 0);

  /* 5. the empty-pool advice ---------------------------------------------- */
  console.log('\n\x1b[1m5. why the draw is empty\x1b[0m');

  const note = (over: Parameters<typeof emptyPoolNote>[0], r = rules(), unit = 'question') =>
    emptyPoolNote(over, r, unit);

  check('a non-empty pool says nothing',
    note({ total: 5, ruleMatches: 5, eligible: 5, pool: 3, pending: 0 }) === null);
  check('a bank that has not loaded says nothing',
    note({ total: 0, ruleMatches: 0, eligible: 0, pool: 0, pending: 0 }) === null);
  check('rules that match nothing say so',
    note({ total: 5, ruleMatches: 0, eligible: 0, pool: 0, pending: 0 })?.includes('matches your rules') === true);
  check('everything already picked is different advice',
    note({ total: 5, ruleMatches: 5, eligible: 2, pool: 0, pending: 0 })?.includes('already picked') === true,
    'resetting the cycle would not add a thing');
  check('a pending report is promised back',
    note({ total: 5, ruleMatches: 5, eligible: 0, pool: 0, pending: 2 })?.includes('2 more will come back') === true);
  check('otherwise it offers the reset',
    note({ total: 5, ruleMatches: 5, eligible: 0, pool: 0, pending: 0 })?.includes('Reset the cycle') === true);
  check('the noun follows the mode',
    note({ total: 3, ruleMatches: 0, eligible: 0, pool: 0, pending: 0 }, rules(), 'problem')
      ?.includes('No problem in this list') === true);
  check('with "keep asking" off, a pending report is not promised back',
    note({ total: 5, ruleMatches: 5, eligible: 0, pool: 0, pending: 2 }, rules({ repeatUnsolved: false }))
      ?.includes('Reset the cycle') === true);

  /* 6. the draw itself ---------------------------------------------------- */
  console.log('\n\x1b[1m6. the draw\x1b[0m');

  check('an empty pool draws nothing', drawOne([]) === undefined);
  check('the draw is injectable for a test', drawOne(dsa, () => 0)?.id === 'two-sum');
  check('and cannot run off the end', drawOne(dsa, () => 0.999999)?.id === 'course-schedule');

  // The rotation's whole promise. One draw proves nothing; the distribution does.
  const remaining = eligible(dsa, rules(), cycle);
  const draws = Array.from({ length: 2000 }, () => drawOne(remaining)!.id);
  check('2000 draws never return a spent question',
    !draws.includes('two-sum') && !draws.includes('word-ladder'),
    `${new Set(draws).size} distinct drawn`);
  check('and every eligible one does come up',
    new Set(draws).size === remaining.length, `${new Set(draws).size} of ${remaining.length}`);

  /* 7. the same rules, all three modes ------------------------------------ */
  console.log('\n\x1b[1m7. every mode that draws\x1b[0m');

  check('three modes have a draw', SURPRISE_MODES.join() === 'dsa,concepts,system_design',
    SURPRISE_MODES.join());

  // Concepts: a draw spans topics, so the cycle is one across the whole bank.
  const conceptCycle = cycleAttempts([attempt('nodejs-event-loop-phases', 'solved')], null);
  const conceptPool = eligible(concepts, rules(), conceptCycle).map((c) => c.id);
  check('a solved concept question leaves the rotation',
    !conceptPool.includes('nodejs-event-loop-phases'), conceptPool.join());
  check('and its topic-mates stay', conceptPool.includes('nodejs-semver-lockfile'));
  check('a topic rule narrows the draw to that topic',
    eligible(concepts, rules({ facets: { topic: ['kafka'] } }), conceptCycle)
      .map((c) => c.id).join() === 'kafka-partitions-ordering');

  /**
   * System design records no per-problem verdict — the round is one open-ended
   * design, scored by phase. So every handout arrives with a null outcome, and
   * the default rules have to retire it anyway or the draw would offer the same
   * problem for ever.
   */
  const designCycle = cycleAttempts([attempt('tinyurl', null)], null);
  const designPool = eligible(design, rules(), designCycle).map((c) => c.id);
  check('a design problem with no verdict is still retired',
    !designPool.includes('tinyurl'), designPool.join());
  check('the rest of the bank remains', designPool.length === design.length - 1);
  check('an exhausted design bank offers the reset, not a report that is never coming',
    emptyPoolNote(
      { total: 3, ruleMatches: 3, eligible: 0, pool: 0, pending: 3 },
      rules(),
      'problem',
      false,
    )?.includes('Reset the cycle') === true,
    'the same counts WITH verdicts would promise them back');
  check('and with verdicts they are promised back',
    emptyPoolNote(
      { total: 3, ruleMatches: 3, eligible: 0, pool: 0, pending: 3 },
      rules(),
      'question',
    )?.includes('3 more will come back') === true);

  /* 8. the browser's stored rules ---------------------------------------- */
  console.log('\n\x1b[1m8. what localStorage carries between visits\x1b[0m');

  /**
   * Storage held ONE rule set and cycle keys that were bare collection ids,
   * because DSA was the only mode with a draw. Three modes need three rule
   * sets and namespaced cycles — and a migration, because dropping the old
   * blob would silently reset both the rules someone chose and the line that
   * decides which questions they have already worked through.
   */
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  store.set('orvia.practice.v1', JSON.stringify({
    cycles: { neetcode150: at(1440), blind75: at(60) },
    rules: { difficulties: ['hard'], topics: ['graphs'], avoidRepeats: true, repeatUnsolved: false },
  }));

  const web = await import('../apps/web/src/lib/practice.js');

  const migrated = web.loadRules('dsa');
  check('v1 rules survive as the DSA rules',
    migrated.facets.difficulty?.join() === 'hard' && migrated.facets.topic?.join() === 'graphs',
    JSON.stringify(migrated.facets));
  check('and so do the flags someone deliberately turned off',
    migrated.repeatUnsolved === false && migrated.avoidRepeats === true);
  check('v1 cycle markers are namespaced to DSA, not lost',
    web.cycleStart('dsa:neetcode150') !== null && web.cycleStart('neetcode150') === null);
  check('a mode that had no rules yet gets the defaults',
    JSON.stringify(web.loadRules('concepts')) === JSON.stringify(DEFAULT_DRAW_RULES));

  web.saveRules('concepts', rules({ facets: { topic: ['kafka'] } }));
  check('saving one mode does not touch another',
    web.loadRules('concepts').facets.topic?.join() === 'kafka' &&
      web.loadRules('dsa').facets.topic?.join() === 'graphs');

  const started = web.resetCycle('concepts');
  check('a reset writes a marker for that scope alone',
    web.cycleStart('concepts') === started && web.cycleStart('system_design') === null);
  web.resetCycle('resolve:dsa');
  web.clearCycle('resolve:dsa');
  check('undoing the re-solve reset clears its marker and no other',
    web.cycleStart('resolve:dsa') === null && web.cycleStart('concepts') === started);

  store.set('orvia.practice.v2', 'not json at all');
  check('a corrupt blob degrades to defaults rather than breaking setup',
    JSON.stringify(web.loadRules('dsa')) === JSON.stringify(DEFAULT_DRAW_RULES));

  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => { throw new Error('storage disabled'); },
    setItem: () => { throw new Error('storage disabled'); },
  };
  check('storage being disabled outright is survivable',
    JSON.stringify(web.loadRules('dsa')) === JSON.stringify(DEFAULT_DRAW_RULES) &&
      web.cycleStart('dsa:neetcode150') === null);
  web.saveRules('dsa', rules());
  check('and writing to it does not throw', true);

  moments();
  commitments();
  planRules();
  loopRules();
  roundEnds();
  guides();
  resolveRules();

  report();
}

/* ── 9. the moments a report offers for a retry ────────────────────────────── */

function moments() {
  console.log('\n\x1b[1m9. moments worth retrying, and which question a drill puts\x1b[0m');

  const q = (id: string, question: string, score: number, startMs: number | null, missing: string[] = []) => ({
    id, question, score, verdict: (score >= 8 ? 'pass' : 'borderline') as 'pass' | 'borderline',
    whatWasMissing: missing, howToImprove: `Improve ${id}`, startMs,
  });
  const d = (dimension: string, score: number, evidenceAtMs: number | null, evidenceQuote: string | null = 'um so I think') => ({
    dimension, score, assessment: `${dimension} was weak`, evidenceQuote, evidenceAtMs,
  });
  const src = (over: Partial<MomentSource>): MomentSource => ({
    mode: 'behavioural', questions: [], delivery: [], bank: [], ...over,
  });

  const one = deriveMoments(src({
    questions: [q('a', 'Tell me about a conflict', 4, 0, ['no outcome', 'no personal action', 'no metric', 'no reflection']), q('b', 'Why this company', 9, 60_000)],
    delivery: [d('concision', 2, 70_000), d('clarity', 4, 10_000), d('fluency', 3, 5_000, null)],
  }));
  check('a question at 7/10 or below is offered, one above is not',
    one.some((m) => m.id === 'q:a') && !one.some((m) => m.id === 'q:b'));
  check('a delivery dimension at 3/5 or below WITH a quote is offered; without a quote it is not',
    one.some((m) => m.id === 'd:concision') && !one.some((m) => m.id === 'd:fluency') && !one.some((m) => m.id === 'd:clarity'));
  check(`a drill carries at most ${MAX_DRILL_FOCUS} weaknesses`,
    one.find((m) => m.id === 'q:a')!.focus.length === MAX_DRILL_FOCUS);
  check('weakest first, on the fraction of its own scale',
    one[0]!.id === 'q:a' && one[1]!.id === 'd:concision', one.map((m) => m.id).join(', '));
  const conc = one.find((m) => m.id === 'd:concision')!;
  check('a delivery moment puts the question being answered when the quote was said',
    conc.question === 'Why this company', String(conc.question));
  check('...and its focus is the dimension\'s own top anchor', conc.focus[0]!.startsWith('Concision:'));

  const bare = deriveMoments(src({ questions: [q('a', 'Q', 5, 0, [])] }));
  check('a question with nothing listed as missing falls back to its rewrite instruction',
    JSON.stringify(bare[0]!.focus) === '["Improve a"]');

  const unplaced = deriveMoments(src({ questions: [q('a', 'Q', 9, 30_000)], delivery: [d('confidence', 2, 10_000)] }));
  check('a quote said before any question was asked cannot be drilled, and says why',
    unplaced[0]!.question === null && !!unplaced[0]!.unavailable);

  const bank = [{ id: 'meeting-rooms', title: 'Meeting Rooms' }, { id: 'meeting-rooms-ii', title: 'Meeting Rooms II' }, { id: 'two-sum', title: 'Two Sum' }];
  check('one bank question matches whatever the report called it', matchBankQuestion('anything at all', [bank[2]!]) === 'two-sum');
  check('a title contained in a longer one resolves to the longer', matchBankQuestion('Solve Meeting Rooms II with a heap', bank) === 'meeting-rooms-ii');
  check('...and the shorter still resolves on its own', matchBankQuestion('Meeting Rooms: can one person attend all?', bank) === 'meeting-rooms');
  check('two unrelated titles in one question are ambiguous, so null rather than a guess',
    matchBankQuestion('Compare Two Sum with Meeting Rooms', bank) === null);
  check('a title matches on whole words only', matchBankQuestion('Two Summaries of the design', bank) === null);

  const stated = [
    { id: 'coin-change', title: 'Coin Change', statement: 'You are given an integer array coins representing coins of different denominations and an integer amount representing a total amount of money. Return the fewest number of coins that you need to make up that amount. If that amount of money cannot be made up by any combination of the coins, return -1.' },
    { id: 'design-add-and-search-words-data-structure', title: 'Design Add and Search Words Data Structure', statement: 'Design a data structure that supports adding new words and finding if a string matches any previously added string. Implement the WordDictionary class.' },
  ];
  check('a question written as the spoken statement, never naming the title, matches its problem',
    matchBankQuestion('You are given an integer array coins representing coins of different denominations and an integer amount. Return the fewest number of coins, or minus one. What\'s your approach going to be?', stated) === 'coin-change' &&
      matchBankQuestion('Design a data structure that supports adding new words and finding if a string matches any previously added word. What\'s your approach going to be?', stated) === 'design-add-and-search-words-data-structure');
  check('...a follow-up sharing few words with any statement still matches nothing',
    matchBankQuestion('What is the time complexity of your approach?', stated) === null);
  check('...and a question as close to two statements as to one is ambiguous, so null',
    matchBankQuestion('Return the fewest coins or design a data structure for words', [
      { id: 'a', title: 'Coin Change', statement: 'Return the fewest coins' },
      { id: 'b', title: 'Word Dictionary', statement: 'Design a data structure for words' },
    ]) === null);

  const dsa = deriveMoments(src({
    mode: 'dsa', bank,
    questions: [q('x', 'Explain your approach to Two Sum', 3, 0), q('y', 'What is the space complexity?', 5, 60_000)],
  }));
  check('a DSA question matched to its problem narrows the drill to that problem',
    dsa.find((m) => m.id === 'q:x')!.questionId === 'two-sum' && !dsa.find((m) => m.id === 'q:x')!.unavailable);
  check('a DSA question that matches no problem cannot be drilled — the editor needs one',
    dsa.find((m) => m.id === 'q:y')!.questionId === null && !!dsa.find((m) => m.id === 'q:y')!.unavailable);
  const design = deriveMoments(src({ mode: 'system_design', questions: [q('z', 'How would you shard it?', 4, 0)] }));
  check('a mode with no bank drills by the question text alone', design[0]!.questionId === null && !design[0]!.unavailable);

  check('the question being answered is the last one asked at or before the quote',
    questionAt([{ startMs: 0 }, { startMs: 50 }, { startMs: 100 }], 99)?.startMs === 50 &&
      questionAt([{ startMs: 10 }], 5) === null && questionAt([{ startMs: 0 }], null) === null);

  const drillQs = [{ question: 'Could you clarify the input size?' }, { question: 'Walk me through the complexity of your hash map approach' }];
  check('a drill\'s "after" is the report question sharing most words with what was put',
    drillQuestionMatch('What is the complexity of the hash map approach', drillQs) === drillQs[1]);
  check('...with no shared words there is no honest "after"', drillQuestionMatch('Zebra quantum', drillQs) === null);
}

/* ── 10. commitments ──────────────────────────────────────────────────────── */

function commitments() {
  console.log('\n\x1b[1m10. when a commitment is met\x1b[0m');
  check(`applied ${COMMITMENT_CLOSE_STREAK} rounds running closes it`,
    commitmentProgress(['applied', 'applied']).status === 'closed');
  check('a round that gave it no chance neither counts nor breaks the run',
    commitmentProgress(['applied', 'no_chance', 'applied']).status === 'closed' &&
      commitmentProgress(['no_chance', 'no_chance']).chances === 0);
  check('partly resets the run — half a fix is the habit coming back',
    commitmentProgress(['applied', 'partly', 'applied']).status === 'open' &&
      commitmentProgress(['applied', 'partly', 'applied']).streak === 1);
  check('once closed it stays closed, whatever a later check says',
    commitmentProgress(['applied', 'applied', 'not_applied']).status === 'closed');
  check('nothing yet is open with no streak', commitmentProgress([]).status === 'open' && commitmentProgress([]).streak === 0);
}

/* ── 11. readiness, the week, the recap, the records ──────────────────────── */

const round = (over: Partial<PlanRound>): PlanRound => ({
  sessionId: `s${Math.random().toString(36).slice(2, 8)}`, mode: 'dsa', kind: 'round', dayKey: '2026-09-28',
  startedAt: '2026-09-28T10:00:00.000Z', durationMs: 1_800_000, overallScore: 60, overallVerdict: 'borderline',
  rubricVersion: '1.5.0', fillerRate: 3, wordCount: 1200, delivery: {}, bestEvidence: null, solved: [], ...over,
});

function planRules() {
  console.log('\n\x1b[1m11. readiness, the week, the recap and personal bests\x1b[0m');

  check('the week starts on Monday', weekOf('2026-09-30') === '2026-09-28' && weekOf('2026-09-28') === '2026-09-28' &&
    weekOf('2026-10-04') === '2026-09-28' && weekOf('2026-10-05') === '2026-10-05');
  check('days to go counts calendar days, and goes negative after',
    daysUntil('2026-10-12', '2026-09-30') === 12 && daysUntil('2026-09-29', '2026-09-30') === -1 && daysUntil('nope', '2026-09-30') === null);

  const r = readiness([
    round({ overallScore: 90, startedAt: '2026-09-01T00:00:00Z' }),
    round({ mode: 'hr', overallScore: 80 }),
    round({ mode: 'hr', overallScore: 72, startedAt: '2026-09-29T00:00:00Z' }),
    round({ mode: 'behavioural', overallScore: 95, kind: 'drill' }),
  ]);
  const by = (m: string) => r.find((x) => x.mode === m)!;
  check('one good round is not "ready" — that needs two at the bar', by('dsa').band === 'close' && by('dsa').score === 90);
  check('two rounds averaging 70 or more are', by('hr').band === 'ready' && by('hr').score === 76);
  check('a drill is never evidence of readiness', by('behavioural').band === 'not_started');
  check('readiness averages only the last three rounds',
    readiness([30, 30, 90, 90, 90].map((s, i) => round({ overallScore: s, startedAt: `2026-09-0${i + 1}T00:00:00Z` })))
      .find((x) => x.mode === 'dsa')!.score === 90);

  const week = weeklyPlan(r, ['dsa', 'hr', 'system_design'], 4, [round({ mode: 'system_design', dayKey: '2026-09-29' })], '2026-09-30');
  check('a mode never tried comes first in the week', week[0]!.mode === 'system_design', week.map((w) => w.mode).join(','));
  check('every target mode gets a round before any gets two, and no mode more than half',
    week.every((w) => w.planned >= 1 && w.planned <= 2) && week.reduce((a, w) => a + w.planned, 0) === 4);
  check('rounds already done this week are counted against the plan', week.find((w) => w.mode === 'system_design')!.done === 1);

  const recap = weeklyRecap([
    round({ dayKey: '2026-09-29', overallScore: 70, fillerRate: 2, delivery: { concision: 4 },
            bestEvidence: { dimension: 'clarity', score: 4, quote: 'first', atMs: 1 }, startedAt: '2026-09-29T10:00:00Z' }),
    round({ dayKey: '2026-09-30', overallScore: 80, fillerRate: 4, delivery: { concision: 4 },
            bestEvidence: { dimension: 'clarity', score: 4, quote: 'second', atMs: 2 }, startedAt: '2026-09-30T10:00:00Z' }),
    round({ dayKey: '2026-09-30', kind: 'drill', overallScore: 100 }),
    round({ dayKey: '2026-09-22', overallScore: 50, delivery: { concision: 2 } }),
    round({ dayKey: '2026-09-15', overallScore: 40, delivery: { concision: 2 } }),
  ], [{ dayKey: '2026-09-29', result: 'applied' }, { dayKey: '2026-09-30', result: 'no_chance' }, { dayKey: '2026-09-30', result: 'partly' }], '2026-09-30');
  check('this week counts its rounds and its drills separately', recap.rounds === 2 && recap.drills === 1);
  check('a drill\'s score never enters the week\'s average', recap.meanScore === 75 && recap.lastWeekMeanScore === 50);
  check('the most improved dimension is measured against the four weeks before', recap.mostImproved?.dimension === 'concision' && recap.mostImproved.delta === 2);
  check('fixes count only the checks that had a chance', recap.fixesApplied === 1 && recap.fixesChecked === 2);
  check('a tie for best moment goes to the newer round', recap.best?.quote === 'second');

  const bests = personalBests([
    round({ overallScore: 70, rubricVersion: '1.4.0', overallVerdict: 'strong_pass', dayKey: '2026-09-01' }),
    round({ overallScore: 65, overallVerdict: 'pass', dayKey: '2026-09-02', solved: [{ id: 'lru', title: 'LRU Cache', difficulty: 'Medium' }] }),
    round({ overallScore: 65, overallVerdict: 'strong_pass', dayKey: '2026-09-03', fillerRate: 1, wordCount: 100,
            solved: [{ id: 'wl', title: 'Word Ladder', difficulty: 'Hard' }, { id: 'ts', title: 'Two Sum', difficulty: 'Easy' }] }),
    round({ kind: 'drill', overallScore: 99, dayKey: '2026-09-04', fillerRate: 0, wordCount: 900 }),
    round({ dayKey: '2026-09-04', fillerRate: 1.5, wordCount: 400, overallScore: null }),
  ], '1.5.0');
  const best = (id: string) => bests.find((b) => b.id === id);
  check('a best score counts only the current rubric, and a drill never', best('best-score:dsa')?.value === '65');
  check('...and the record belongs to the round that FIRST reached it', best('best-score:dsa')?.dayKey === '2026-09-02');
  check('the first strong pass is under the current rubric', best('first-strong-pass')?.dayKey === '2026-09-03');
  check('a filler record needs enough words to mean anything', best('lowest-filler')?.value === '1.5 per 100 words');
  check('the first Hard problem solved is named', best('first-hard')?.value === 'Word Ladder');
  check('most problems in one round needs at least two', best('most-solved')?.value === '2');
  check('a run of days with a round is a record from two days', best('longest-streak')?.value === '4 days' &&
    longestDayStreak(['2026-09-01', '2026-09-03']).days === 1);
}

/* ── 12. onsite loops ─────────────────────────────────────────────────────── */

function loopRules() {
  console.log('\n\x1b[1m12. onsite loops: which round fills a stage, and the decision\x1b[0m');
  const stages = [{ mode: 'dsa' as const, minutes: 45 }, { mode: 'behavioural' as const, minutes: 30 }];
  const lr = (stage: number, over: object) => ({
    sessionId: `r${stage}${Math.random()}`, stage, mode: stage === 0 ? 'dsa' as const : 'behavioural' as const,
    status: 'completed', durationMs: 600_000, startedAt: '2026-09-30T10:00:00Z', verdict: null, score: null,
    evaluationStatus: null, ...over,
  });
  const p = loopProgress(stages, [lr(0, { durationMs: 20_000 })], 60_000);
  check('a stage round that died inside the handout floor leaves the stage open', p.next === 0 && p.filled[0] === null);
  const p2 = loopProgress(stages, [lr(0, { startedAt: '2026-09-30T09:00:00Z', verdict: 'fail' }), lr(0, { startedAt: '2026-09-30T11:00:00Z', verdict: 'pass' })], 60_000);
  check('the latest qualifying round fills a stage, so a stage can be run again', p2.filled[0]?.verdict === 'pass' && p2.next === 1);
  check('a round in the wrong mode never fills a stage',
    loopProgress(stages, [{ ...lr(1, {}), mode: 'dsa' }], 60_000).filled[1] === null);
  check('every stage filled means nothing is next',
    loopProgress(stages, [lr(0, {}), lr(1, {})], 60_000).next === null);
  const cut = lr(0, { status: 'aborted', durationMs: 94_000, startedAt: '2026-09-30T09:00:00Z' });
  const p3 = loopProgress(stages, [cut], 60_000);
  check('a round cut short with no report leaves its stage open and next', p3.filled[0] === null && p3.next === 0);
  const p4 = loopProgress(stages, [{ ...cut, evaluationStatus: 'pending' }], 60_000);
  check('a round cut short that was sent for scoring fills its stage', p4.filled[0]?.status === 'aborted' && p4.next === 1);
  const p5 = loopProgress(stages, [lr(0, { status: 'completed' })], 60_000);
  check('a completed round fills its stage before its report lands', p5.filled[0]?.status === 'completed' && p5.next === 1);
  const retake = lr(0, { startedAt: '2026-09-30T10:00:00Z' });
  const p6 = loopProgress(stages, [cut, retake], 60_000);
  check('a retake after a cut-short round fills the stage', p6.filled[0]?.sessionId === retake.sessionId && p6.next === 1);
  const done = lr(0, { startedAt: '2026-09-30T08:00:00Z' });
  check('a later unscored cut-short attempt does not displace the round that filled the stage',
    loopProgress(stages, [done, cut], 60_000).filled[0]?.sessionId === done.sessionId);

  check('a missing report keeps the loop pending', loopDecision(['pass', null]).decision === 'pending');
  check('one fail sinks the loop', loopDecision(['strong_pass', 'strong_pass', 'fail']).decision === 'no_hire');
  check('two borderlines lean no', loopDecision(['pass', 'borderline', 'borderline']).decision === 'lean_no');
  check('one borderline carried by passes is a hire', loopDecision(['pass', 'borderline', 'strong_pass']).decision === 'hire');
  check('strong passes in half the rounds with no doubts is a strong hire',
    loopDecision(['strong_pass', 'pass']).decision === 'strong_hire' && loopDecision(['strong_pass', 'pass', 'pass']).decision === 'hire');
  check('every decision says why', loopDecision(['pass', 'pass']).reasons.length > 0);
}

function roundEnds() {
  console.log('\n\x1b[1m13. how a round ended, and why the microphone would not open\x1b[0m');
  check('only an ended or timed-out round reads as finished',
    !endedCutShort('user_ended') && !endedCutShort('time_up'));
  check('every other end reason reads as cut short, including one nobody has named yet',
    ['connection_closed', 'no_confirmation', 'error: upstream', 'api_shutdown: the API stopped', '', null, undefined, 'something_new']
      .every((r) => endedCutShort(r)));
  check('a restart and a server error are told apart from a dropped connection',
    new Set(['connection_closed', 'api_shutdown: x', 'error: x', 'no_confirmation'].map(cutShortCause)).size === 4);

  const names = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'];
  const msgs = names.map((name) => micErrorMessage({ name, message: 'raw' }));
  check('each way the microphone fails gets its own advice', new Set(msgs).size === names.length);
  check('a refused microphone says how to allow it', /Allow/.test(msgs[0]!));
  check('an unknown failure still carries the browser\'s own words',
    micErrorMessage({ name: 'WeirdError', message: 'Not supported' }).includes('Not supported'));
}

/* ── 14. the study guide and the playbook's answer templates ─────────────── */

function guides() {
  console.log('\n\x1b[1m14. the study guide and the playbook\'s answer templates\x1b[0m');

  const ids = ALL_CONCEPTS.map((c) => c.id);
  check('every concept id is unique across every guide, because one list of ticks covers them all',
    new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(','));
  // The links on the playbook and the setup screen come from STUDY_TABS, so a
  // mode listed there with no guide behind it would link to the wrong tab.
  const tabModes = Object.keys(STUDY_TABS).sort().join(',');
  check('there is exactly one guide for every mode the links point at, and no other',
    STUDY_GUIDES.map((g) => g.mode).sort().join(',') === tabModes, tabModes);
  check('no group in any guide is empty', STUDY_GUIDES.every((g) => g.groups.every((x) => x.concepts.length > 0)));
  const incomplete = ALL_CONCEPTS.filter((c) =>
    !c.title || !c.what || !c.does || !c.say || !c.check.q || !c.check.a ||
    c.reachWhen.length === 0 || c.tradeoffs.length === 0);
  check('every concept says what it is, when it comes up, what to watch for, and how to check yourself',
    incomplete.length === 0, incomplete.map((c) => c.id).join(','));
  // Related links scroll within the page on screen, so one into another guide would go nowhere.
  const dangling = STUDY_GUIDES.flatMap((g) => {
    const here = new Set(conceptsOf(g).map((c) => c.id));
    return conceptsOf(g).flatMap((c) =>
      (c.related ?? []).filter((r) => !here.has(r) || r === c.id).map((r) => `${c.id}→${r}`));
  });
  check('every related link lands on another concept in the same guide', dangling.length === 0, dangling.join(','));
  // A "core" set that is most of the guide is no longer the ten-minute refresh it promises.
  const cores = STUDY_GUIDES.map((g) => {
    const all = conceptsOf(g);
    return { mode: g.mode, core: all.filter((c) => c.core).length, of: all.length };
  });
  check('each core set is a short refresh, not the whole guide',
    cores.every((c) => c.core >= 4 && c.core <= c.of / 2),
    cores.map((c) => `${c.mode} ${c.core}/${c.of}`).join(', '));

  if (playbook) {
    const { BEATS, PATTERN_SCRIPTS, PHRASES, QUESTION_TYPES } = playbook;
    const missing = INTERVIEW_MODES.filter((m) => (QUESTION_TYPES[m]?.length ?? 0) < 3);
    check('every mode has at least three question types', missing.length === 0, missing.join(','));
    const thin = INTERVIEW_MODES.flatMap((m) =>
      QUESTION_TYPES[m].filter((t) => t.structure.length < 2 || !t.open || !t.cue).map((t) => `${m}:${t.type}`));
    check('every question type has a structure, a cue and an opening sentence', thin.length === 0, thin.join(' | '));
    const dupTypes = INTERVIEW_MODES.filter((m) =>
      new Set(QUESTION_TYPES[m].map((t) => t.type)).size !== QUESTION_TYPES[m].length);
    check('no mode lists the same question type twice', dupTypes.length === 0, dupTypes.join(','));
    const halfBeat = PATTERN_SCRIPTS.flatMap((p) =>
      BEATS.filter((b) => !p.beats[b]?.ask || !p.beats[b]?.eg).map((b) => `${p.pattern}:${b}`));
    check('every pattern script answers all five beats with a question and a worked line',
      halfBeat.length === 0 && PATTERN_SCRIPTS.every((p) => p.example && p.trap), halfBeat.join(' | '));
    check('no pattern is scripted twice',
      new Set(PATTERN_SCRIPTS.map((p) => p.pattern)).size === PATTERN_SCRIPTS.length);
    check('every phrase group has more than one way to say it', PHRASES.every((g) => g.say.length >= 2));
    check('there are phrases for pausing, for being stuck and for not knowing',
      ['paus', 'stuck', 'do not know'].every((w) => PHRASES.some((g) => g.situation.toLowerCase().includes(w))));
  }

  /**
   * The same leak `verify:feed` §6 refuses for the feed, applied to the two
   * static guides: neither may repeat an evaluator-only sentence or a bank
   * prompt. A concept guide that quoted a bank's answer key would spend the
   * question, and the browser ships all of this to anyone signed in.
   */
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const SECRET_KEYS = new Set(['expectedPoints', 'commonMistakes', 'strongAnswer', 'rubricNotes', 'beats']);
  const secrets: string[] = [];
  const walk = (node: unknown, inSecret: boolean) => {
    if (typeof node === 'string') {
      if (inSecret && node.length > 40) secrets.push(node);
    } else if (Array.isArray(node)) {
      for (const x of node) walk(x, inSecret);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, inSecret || SECRET_KEYS.has(k));
    }
  };
  walk([CONCEPT_QUESTIONS, BEHAVIOURAL_QUESTIONS, HR_SCENARIOS, DSA_BANK.systemDesign], false);
  check('there is answer material to leak', secrets.length > 50, `${secrets.length} strings`);

  const guideText = [
    ...ALL_CONCEPTS.map((c) => [c.title, c.what, c.does, c.say, c.check.q, c.check.a, c.numbers ?? '',
      ...c.reachWhen, ...c.tradeoffs].join(' ')),
    ...(playbook ? [
      ...playbook.PHRASES.map((g) => [g.situation, g.when, g.instead ?? '', ...g.say].join(' ')),
      ...INTERVIEW_MODES.flatMap((m) => playbook.QUESTION_TYPES[m].map((t) =>
        [t.type, t.cue, t.open, t.trap ?? '', ...t.structure].join(' '))),
      ...playbook.PATTERN_SCRIPTS.map((p) =>
        [p.pattern, p.example, p.trap, ...playbook.BEATS.flatMap((b) => [p.beats[b]!.ask, p.beats[b]!.eg])].join(' ')),
    ] : []),
  ].map(norm);
  const leaked = secrets.filter((x) => guideText.some((t) => t.includes(norm(x))));
  check('neither guide repeats a sentence from an answer key', leaked.length === 0,
    leaked.slice(0, 1).map((x) => x.slice(0, 60)).join(''));
  const prompts = [...CONCEPT_QUESTIONS.map((q) => q.prompt), ...DSA_BANK.systemDesign.map((p) => p.prompt)]
    .map(norm).filter((p) => p.length > 40);
  const quoted = prompts.filter((p) => guideText.some((t) => t.includes(p)));
  check('neither guide repeats a bank question verbatim', quoted.length === 0, quoted.slice(0, 1).join(''));
}

/* ── 15. the re-solve queue ────────────────────────────────────────────────── */

function resolveRules() {
  console.log('\n\x1b[1m15. the re-solve queue: when a missed problem comes back\x1b[0m');

  let n = 0;
  const at = (
    questionId: string, dayKey: string, outcome: ResolveAttempt['outcome'], reason: string | null = null,
  ) => ({ questionId, dayKey, outcome, reason, sessionId: `s${++n}`, startedAt: `${dayKey}T10:00:${String(n).padStart(2, '0')}Z` });
  const one = (xs: ReturnType<typeof at>[]) => resolveQueue(xs).find((i) => i.questionId === 'merge-intervals');

  check('the ladder is 3, 7, 21 days', JSON.stringify(RESOLVE_INTERVALS_DAYS) === '[3,7,21]');

  const missed = one([at('merge-intervals', '2026-09-11', 'partial', 'missed the overlap at equal ends')]);
  check('a partial is due three days later, at step 0, with its reason',
    missed?.step === 0 && missed.dueKey === '2026-09-14' && missed.miss.reason === 'missed the overlap at equal ends',
    JSON.stringify(missed));
  check('so is an unsolved', one([at('merge-intervals', '2026-09-11', 'unsolved')])?.dueKey === '2026-09-14');
  check('a problem solved the first time never enters',
    resolveQueue([at('merge-intervals', '2026-09-11', 'solved')]).length === 0);

  const once = one([at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-15', 'solved')]);
  check('one solve after a miss: step 1, due a week from the SOLVE',
    once?.step === 1 && once.dueKey === '2026-09-22');
  const twice = one([
    at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-15', 'solved'),
    at('merge-intervals', '2026-09-22', 'solved'),
  ]);
  check('two solves: step 2, due three weeks on', twice?.step === 2 && twice.dueKey === '2026-10-13');
  check('three solves: mastered, and it leaves the queue', one([
    at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-15', 'solved'),
    at('merge-intervals', '2026-09-22', 'solved'), at('merge-intervals', '2026-10-13', 'solved'),
  ]) === undefined);

  const relapse = one([
    at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-15', 'solved'),
    at('merge-intervals', '2026-09-22', 'solved'), at('merge-intervals', '2026-09-25', 'partial', 'again'),
  ]);
  check('a miss at step 2 drops it back to step 0, due three days from the new miss',
    relapse?.step === 0 && relapse.dueKey === '2026-09-28' && relapse.miss.reason === 'again');
  check('and its history keeps every verdict, oldest first',
    relapse?.history.map((h) => h.outcome).join() === 'partial,solved,solved,partial');
  check('a miss after mastering puts it back', one([
    at('merge-intervals', '2026-09-01', 'partial'), at('merge-intervals', '2026-09-02', 'solved'),
    at('merge-intervals', '2026-09-03', 'solved'), at('merge-intervals', '2026-09-04', 'solved'),
    at('merge-intervals', '2026-10-01', 'unsolved'),
  ])?.dueKey === '2026-10-04');

  const unreached = one([at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-13', 'not_reached')]);
  check('not_reached neither advances nor resets it', unreached?.step === 0 && unreached.dueKey === '2026-09-14');

  const waiting = one([at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-20', null)]);
  check('a re-solve whose report is not in yet is pending, and not due',
    waiting?.pending === true && !isDue(waiting, '2026-09-20') && waiting.dueKey === '2026-09-14');
  check('a pending first attempt does not enter the queue', resolveQueue([at('merge-intervals', '2026-09-11', null)]).length === 0);

  const shuffled = [at('merge-intervals', '2026-09-11', 'partial'), at('merge-intervals', '2026-09-15', 'solved')].reverse();
  check('order of arrival does not matter: it folds by startedAt', one(shuffled)?.step === 1);

  const sameDay = one([at('merge-intervals', '2026-09-11', 'solved'), at('merge-intervals', '2026-09-11', 'partial')]);
  check('two rounds on one day fold in the order they started', sameDay?.step === 0);

  check('due ON its day, not only after', isDue(missed!, '2026-09-14') && !isDue(missed!, '2026-09-13'));
  check('across a month end', one([at('merge-intervals', '2026-09-29', 'partial')])?.dueKey === '2026-10-02');

  const history = [
    at('merge-intervals', '2026-09-11', 'partial'), at('car-fleet', '2026-09-20', 'unsolved'),
    at('merge-intervals', '2026-10-02', 'solved'),
  ];
  check('start over hides every round before it',
    resolveQueue(history, '2026-10-03T00:00:00Z').length === 0 && resolveQueue(history).length === 2);
  check('a solve after the reset, with its miss before it, starts nothing (no miss since)',
    resolveQueue(history, '2026-10-01T00:00:00Z').length === 0);
  const after = resolveQueue([...history, at('car-fleet', '2026-10-04', 'partial', 'after')], '2026-10-03T00:00:00Z');
  check('a miss after the reset enters as fresh, on its own date',
    after.length === 1 && after[0]!.questionId === 'car-fleet' && after[0]!.dueKey === '2026-10-07'
      && after[0]!.history.length === 1);
  check('an unparseable marker counts everything rather than emptying the queue',
    resolveQueue(history, 'not a date').length === 2);
  check('no marker counts everything', resolveQueue(history, null).length === 2);

  const q = resolveQueue([
    at('car-fleet', '2026-09-28', 'unsolved'), at('merge-intervals', '2026-09-11', 'partial'),
    at('spiral-matrix', '2026-09-20', 'partial'),
  ]);
  check('the queue is soonest due first', q.map((i) => i.questionId).join() === 'merge-intervals,spiral-matrix,car-fleet',
    q.map((i) => i.questionId).join());

  console.log('\n\x1b[1m16. complexity figures in the report\x1b[0m');
  const split = splitComplexity('O(S * n) where S is amount and n is number of coins');
  check('a gloss is split off the bound', split.head === 'O(S * n)' && split.rest === 'where S is amount and n is number of coins',
    JSON.stringify(split));
  check('nested parentheses stay in the head', splitComplexity('O(n log(n)), sorted').head === 'O(n log(n))');
  check('a bare bound has no rest', splitComplexity('O(1)').rest === '');
  check('text that is not a bound is all head', splitComplexity('linear').head === 'linear');
  check('a glossed bound equals the bare one', sameComplexity('O(S * n) where S is amount', 'O(n*S)'));
  check('a different bound still differs', !sameComplexity('O(S) where S is amount', 'O(S * n)'));
  check('a second bound in the gloss is part of the claim',
    !sameComplexity('O(M) for addWord and O(26^D * M) for search', 'O(M) for addWord and O(M) for search'));
  check('a trailing where-clause does not make two bounds differ', sameComplexity(
    'O(M) for addWord and O(26^D * M) for search where D is number of dots', 'O(M) for addWord and O(26^D * M) for search'));
}

function report(): never {
  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} CHECKS PASSED\x1b[0m — one rotation, three modes.\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  console.log('');
  process.exit(1);
}

void main();
