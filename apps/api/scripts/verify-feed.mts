/**
 * Verifies the learning feed: bank consistency and card ranking/review rules.
 * Offline and hermetic — tests feed algorithms and ensures teaching cards
 * do not leak interview bank answers.
 *
 *   pnpm --filter @orvia/api verify:feed
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DAILY_CARD_GOAL,
  FEED_WEAVE,
  MAX_STRENGTH,
  RELEARN_MS,
  REVIEW_INTERVALS_DAYS,
  SEEN_COOLDOWN_MS,
  describeNextReview,
  learningCardSchema,
  rankFresh,
  scheduleReview,
  speakableCard,
  speechGroups,
  streakFrom,
  weave,
  type FeedQueueName,
} from '@orvia/shared';
import { DELIVERY_DIMENSION_IDS } from '@orvia/shared';
import { SKIP_COOLDOWN_MS, unfinishedVerdicts, weakDimensions } from '@orvia/shared';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pageQuerySchema } from '../src/feed/feed.query';
import { SpeechCacheService } from '../src/feed/speech-cache.service';
import { LEARNING_CARDS } from './data/learning-cards.mts';
import {
  CONCEPT_TOPICS,
  CONCEPT_QUESTIONS,
  BEHAVIOURAL_QUESTIONS,
  HR_SCENARIOS,
} from './data/conversational-banks.mts';

let pass = 0;
const fails: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++;
  else fails.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};

const DAY = 86_400_000;
const NOW = new Date('2026-09-22T09:00:00Z');

/** The LeetCode topic vocabulary, from the committed snapshot. */
async function dsaTopics(): Promise<Set<string>> {
  const path = join(import.meta.dirname, 'data', 'question-bank.seed.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as
    | { questions?: { topics?: string[] }[] }
    | { topics?: string[] }[];
  const rows = Array.isArray(raw) ? raw : (raw.questions ?? []);
  const out = new Set<string>();
  for (const r of rows) for (const t of r.topics ?? []) out.add(t);
  return out;
}

/** Normalised for comparison: the same sentence with different spacing is the same leak. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '').trim();

async function main() {
  console.log('\n\x1b[1mLearning feed verification\x1b[0m\n');

  const topics = await dsaTopics();
  const conceptTopicIds = new Set(CONCEPT_TOPICS.map((t) => t.id));
  const dimensionIds = new Set(DELIVERY_DIMENSION_IDS);

  /* ── 1. the bank parses ─────────────────────────────────────────────────── */
  console.log('\x1b[1m1. every card is valid\x1b[0m');
  {
    const bad: string[] = [];
    for (const card of LEARNING_CARDS) {
      const r = learningCardSchema.safeParse(card);
      if (!r.success) bad.push(`${card.id}: ${r.error.issues[0]?.message ?? 'invalid'}`);
    }
    check('every card satisfies learningCardSchema', bad.length === 0, bad.slice(0, 3).join(' | '));

    const ids = LEARNING_CARDS.map((c) => c.id);
    check('ids are unique', new Set(ids).size === ids.length);
    check(
      `the bank can fill a day (${LEARNING_CARDS.length} cards, goal ${DAILY_CARD_GOAL})`,
      LEARNING_CARDS.length >= DAILY_CARD_GOAL * 3,
      `${LEARNING_CARDS.length} cards`,
    );

    const quizzes = LEARNING_CARDS.filter((c) => c.kind === 'quiz');
    check('the bank has quizzes', quizzes.length >= 8, `${quizzes.length}`);
    check(
      'no quiz has its answer always in the same slot',
      new Set(quizzes.map((q) => q.answerIdx)).size >= 3,
      [...new Set(quizzes.map((q) => q.answerIdx))].join(','),
    );
  }

  /* ── 2. tags can actually match something ───────────────────────────────── */
  console.log('\n\x1b[1m2. tags are in a vocabulary that exists\x1b[0m');
  {
    /**
     * A Capitalised tag is claiming to be a LeetCode topic, so it must be one
     * verbatim. This is what catches "Union Find" for "Union-Find" and "Graph"
     * for "Graph Theory" — near misses that look right in the file and can
     * never match a row, so the card silently stops being personalised.
     */
    const mistyped: string[] = [];
    for (const c of LEARNING_CARDS) {
      for (const t of c.tags ?? []) {
        // Leading capital only. `followUpHandling` is a real delivery
        // dimension id and camelCase, so "contains a capital" would condemn it.
        if (/^[A-Z]/.test(t) && !topics.has(t)) mistyped.push(`${c.id}: "${t}"`);
      }
    }
    check('every capitalised tag is a real LeetCode topic', mistyped.length === 0, mistyped.slice(0, 3).join(' | '));

    const unreachable: string[] = [];
    for (const c of LEARNING_CARDS) {
      // System design has no topic vocabulary anywhere in the schema — a design
      // problem carries a level and nothing else — so those cards are reached
      // by the bank's order rather than by a weak-topic boost.
      if (c.track === 'system_design') continue;
      const matchable = (c.tags ?? []).some(
        (t) => topics.has(t) || conceptTopicIds.has(t) || dimensionIds.has(t),
      );
      if (!matchable) unreachable.push(c.id);
    }
    check(
      'every non-design card has at least one matchable tag',
      unreachable.length === 0,
      unreachable.slice(0, 4).join(', '),
    );
  }

  /* ── 3. the review ladder ───────────────────────────────────────────────── */
  console.log('\n\x1b[1m3. spaced repetition\x1b[0m');
  {
    let s = { strength: 0, dueAt: null as Date | null };
    const gaps: number[] = [];
    for (let i = 0; i <= MAX_STRENGTH + 2; i++) {
      s = scheduleReview(s, 'got_it', NOW);
      gaps.push(Math.round(((s.dueAt as Date).getTime() - NOW.getTime()) / DAY));
    }
    check('"knew it" lengthens the gap every time until the cap', gaps.slice(0, MAX_STRENGTH).every((g, i) => i === 0 || g > gaps[i - 1]!), gaps.join(','));
    check('strength caps rather than overflowing the ladder', s.strength === MAX_STRENGTH, `strength ${s.strength}`);
    check(
      'the last rung is the longest interval in the table',
      gaps.at(-1) === REVIEW_INTERVALS_DAYS[MAX_STRENGTH],
      `${gaps.at(-1)}d`,
    );

    const shaky = scheduleReview({ strength: MAX_STRENGTH, dueAt: new Date(NOW.getTime() + 30 * DAY) }, 'shaky', NOW);
    check('"show again" resets strength to zero', shaky.strength === 0);
    check(
      'a fumbled card comes back inside the same sitting',
      (shaky.dueAt as Date).getTime() - NOW.getTime() === RELEARN_MS,
      `${RELEARN_MS / 60_000} min`,
    );

    /**
     * Scrolling past a card marked shaky must not push its relearn time out
     * to the longer seen cooldown.
     */
    const soon = new Date(NOW.getTime() + RELEARN_MS);
    const afterSeen = scheduleReview({ strength: 0, dueAt: soon }, 'seen', NOW);
    check(
      'scrolling past does not push a near review out',
      (afterSeen.dueAt as Date).getTime() === soon.getTime(),
      new Date(afterSeen.dueAt as Date).toISOString(),
    );

    const far = new Date(NOW.getTime() + 30 * DAY);
    const seenFar = scheduleReview({ strength: 4, dueAt: far }, 'seen', NOW);
    check('scrolling past never pulls a far review forward', (seenFar.dueAt as Date).getTime() === far.getTime());
    check('scrolling past does not change strength', seenFar.strength === 4);

    /** A card never rated, and an overdue one, both take the plain cooldown. */
    const seenNew = scheduleReview({ strength: 0, dueAt: null }, 'seen', NOW);
    check(
      'an unrated card is quiet for the cooldown',
      (seenNew.dueAt as Date).getTime() === NOW.getTime() + SEEN_COOLDOWN_MS,
    );
    const overdue = new Date(NOW.getTime() - 5 * DAY);
    const seenOverdue = scheduleReview({ strength: 2, dueAt: overdue }, 'seen', NOW);
    check(
      'an overdue review scrolled past stops nagging',
      (seenOverdue.dueAt as Date).getTime() === NOW.getTime() + SEEN_COOLDOWN_MS,
      'kept out of the due queue without being marked known',
    );

    /**
     * The ladder is invisible unless the card says when it comes back, and a
     * reader who thinks "knew it" retires something will stop pressing it
     * honestly. Nothing is ever retired — the top rung is five weeks.
     */
    check('a fumbled card says it is back in minutes',
      describeNextReview(shaky.dueAt, NOW) === 'in 10 min', String(describeNextReview(shaky.dueAt, NOW)));
    check('a first "knew it" says tomorrow',
      describeNextReview(scheduleReview({ strength: 0, dueAt: null }, 'got_it', NOW).dueAt, NOW) === 'tomorrow');
    check('a middle rung reads in days',
      describeNextReview(new Date(NOW.getTime() + 9 * DAY), NOW) === 'in 9 days');
    check('the top rung is weeks, never never',
      describeNextReview(new Date(NOW.getTime() + 35 * DAY), NOW) === 'in 5 weeks');
    check('an unrated card promises nothing', describeNextReview(null, NOW) === null);

    const saved = scheduleReview({ strength: 3, dueAt: far }, 'save', NOW);
    check(
      'saving is not a claim about knowing it',
      saved.strength === 3 && (saved.dueAt as Date).getTime() === far.getTime(),
    );
    const skipped = scheduleReview({ strength: 3, dueAt: far }, 'skip', NOW);
    check('skipping keeps the strength it had', skipped.strength === 3);
    check('skipping pushes the card exactly the skip cooldown away, even a far review',
      (skipped.dueAt as Date).getTime() === NOW.getTime() + SKIP_COOLDOWN_MS);
  }

  /* ── 4. streaks ─────────────────────────────────────────────────────────── */
  console.log('\n\x1b[1m4. the streak\x1b[0m');
  {
    check('no days is no streak', streakFrom([], '2026-09-22') === 0);
    check(
      'three consecutive days ending today',
      streakFrom(['2026-09-20', '2026-09-21', '2026-09-22'], '2026-09-22') === 3,
    );
    check(
      'a run ending yesterday still counts — the day is not over',
      streakFrom(['2026-09-20', '2026-09-21'], '2026-09-22') === 2,
    );
    check(
      'a missed day ends the run',
      streakFrom(['2026-09-18', '2026-09-19', '2026-09-21'], '2026-09-22') === 1,
      'only the 21st',
    );
    check('two days missed is no streak', streakFrom(['2026-09-19'], '2026-09-22') === 0);
    check(
      'order and duplicates do not matter',
      streakFrom(['2026-09-22', '2026-09-20', '2026-09-22', '2026-09-21'], '2026-09-22') === 3,
    );
    check(
      'a run across a month boundary is unbroken',
      streakFrom(['2026-08-31', '2026-09-01'], '2026-09-01') === 2,
    );
    check('an unparseable day does not crash or invent a run', streakFrom(['not-a-day'], '2026-09-22') === 0);
  }

  /* ── 5. the weave ───────────────────────────────────────────────────────── */
  console.log('\n\x1b[1m5. how a page is interleaved\x1b[0m');
  {
    const q = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const full: Record<FeedQueueName, string[]> = {
      due: q('due', 20),
      new: q('new', 40),
      drill: q('drill', 10),
      fix: q('fix', 10),
    };

    const bar = weave(full, FEED_WEAVE.length);
    check(
      'one bar of the weave follows the declared pattern',
      bar.every((item, i) => item.startsWith(FEED_WEAVE[i]!)),
      bar.join(' '),
    );

    const page = weave(full, 24);
    check('no card is emitted twice', new Set(page).size === page.length);
    check('a full request is filled', page.length === 24);
    check(
      'new material dominates, as intended',
      page.filter((c) => c.startsWith('new')).length > page.length / 3,
      `${page.filter((c) => c.startsWith('new')).length} of ${page.length}`,
    );

    /**
     * The case that matters most, because it is every new account: no history
     * at all. It has to read as an unbroken run of teaching cards, not as a
     * page with three holes in it.
     */
    const fresh: Record<FeedQueueName, string[]> = { due: [], new: q('new', 12), drill: [], fix: [] };
    const first = weave(fresh, 8);
    check('a brand-new account gets a full page of lessons', first.length === 8);
    check('and no gaps', first.every((c) => c.startsWith('new')));

    const nearlyEmpty: Record<FeedQueueName, string[]> = { due: ['d0'], new: [], drill: [], fix: ['f0'] };
    const short = weave(nearlyEmpty, 10);
    check('an exhausted feed returns what exists and stops', short.length === 2, short.join(','));
  }

  /* ── 6. no answer keys ──────────────────────────────────────────────────── */
  console.log('\n\x1b[1m6. the feed never carries the evaluator\'s half\x1b[0m');
  {
    /**
     * Collected by KEY NAME from the conversational banks, so a new
     * evaluator-only field added there is covered here without this list being
     * updated — the failure mode is someone pasting from the file, and they
     * will paste whatever is in it.
     */
    const SECRET_KEYS = new Set([
      'expectedPoints',
      'commonMistakes',
      'strongAnswer',
      'rubricNotes',
      'beats',
    ]);
    const secrets: string[] = [];
    const walk = (node: unknown, inSecret: boolean) => {
      if (typeof node === 'string') {
        if (inSecret && node.length > 40) secrets.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const x of node) walk(x, inSecret);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, inSecret || SECRET_KEYS.has(k));
      }
    };
    walk([CONCEPT_QUESTIONS, BEHAVIOURAL_QUESTIONS, HR_SCENARIOS], false);
    check('there is answer material to leak', secrets.length > 50, `${secrets.length} strings`);

    const cardText = LEARNING_CARDS.map((c) =>
      norm([c.title, c.body, c.takeaway, c.explanation ?? '', ...(c.choices ?? [])].join(' ')),
    );
    const leaked: string[] = [];
    for (const secret of secrets) {
      const needle = norm(secret);
      const i = cardText.findIndex((t) => t.includes(needle));
      if (i >= 0) leaked.push(`${LEARNING_CARDS[i]!.id} ← "${secret.slice(0, 50)}…"`);
    }
    check('no card repeats a sentence from an answer key', leaked.length === 0, leaked.slice(0, 2).join(' | '));

    /**
     * The other direction: the feed must not quote a bank QUESTION's prompt
     * either. A concept question read on a card is a question spent — the round
     * that was going to ask it is now a recap.
     */
    const prompts = CONCEPT_QUESTIONS.map((q) => norm(q.prompt)).filter((p) => p.length > 40);
    const quoted = prompts.filter((p) => cardText.some((t) => t.includes(p)));
    check('no card repeats a bank question verbatim', quoted.length === 0, quoted.slice(0, 1).join(''));
  }

  /* ── 7. the weak-topic boost ────────────────────────────────────────────── */
  console.log('\n\x1b[1m7. what your own rounds pull forward\x1b[0m');
  {
    const cards = [
      { key: 'a', tags: ['Array'] },
      { key: 'b', tags: ['Dynamic Programming'] },
      { key: 'c', tags: ['Graph Theory', 'Dynamic Programming'] },
      { key: 'd', tags: [] as string[] },
      { key: 'e', tags: ['structure'] },
    ];

    const ranked = rankFresh(cards, ['Dynamic Programming'], 7);
    const front = ranked.slice(0, 2).map((c) => c.key).sort();
    check('cards tagged with a weak topic come first', front.join('') === 'bc', ranked.map((c) => c.key).join(''));

    const lower = rankFresh(cards, ['dynamic programming'], 7);
    check(
      'matching ignores case, because the two sources disagree on it',
      lower.slice(0, 2).map((c) => c.key).sort().join('') === 'bc',
    );

    const dim = rankFresh(cards, ['structure'], 7);
    check('a weak delivery dimension pulls a craft card forward', dim[0]!.key === 'e');

    const again = rankFresh(cards, ['Dynamic Programming'], 7);
    check(
      'the same seed gives exactly the same order',
      again.map((c) => c.key).join('') === ranked.map((c) => c.key).join(''),
    );

    /**
     * Over a spread of seeds the order must actually vary. A jitter that
     * happened to be constant would make every open of the feed identical,
     * which is the difference between a feed and a list — and it would be
     * invisible, because each individual page would look correct.
     */
    const orders = new Set(
      Array.from({ length: 20 }, (_, s) => rankFresh(cards, [], s).map((c) => c.key).join('')),
    );
    check('different seeds draw a different feed', orders.size > 3, `${orders.size} orders in 20 seeds`);

    const none = rankFresh(cards, [], 3);
    check('with no history nothing is dropped', none.length === cards.length);
  }

  /* ── 8. reading it aloud ────────────────────────────────────────────────── */
  console.log('\n\x1b[1m8. what a voice says\x1b[0m');
  {
    const state = { timesSeen: 0, saved: false, strength: 0, dueAt: null };

    const quizCard = LEARNING_CARDS.find((c) => c.kind === 'quiz')!;
    const quiz = speakableCard({
      kind: 'quiz',
      key: 'k',
      state,
      becauseOf: null,
      card: learningCardSchema.parse(quizCard) as never,
    });
    const pauseAt = quiz.findIndex((s) => 'pause' in s);
    const said = (i: number) => (quiz[i] && 'say' in quiz[i]! ? (quiz[i] as { say: string }).say : '');
    check('a quiz is asked before it is answered', pauseAt > 0, `pause at ${pauseAt}`);
    check(
      'the answer comes only after the silence',
      quiz.slice(0, pauseAt).every((s) => !('say' in s) || !s.say.startsWith('The answer')),
    );
    check('and it is given afterwards', said(pauseAt + 1).startsWith('The answer is'), said(pauseAt + 1));
    check('the options are numbered in words', said(2).startsWith('Option one'), said(2));

    const withCode = LEARNING_CARDS.find((c) => c.kind === 'pattern' && c.code)!;
    const lesson = speakableCard({
      kind: 'pattern',
      key: 'k',
      state,
      becauseOf: null,
      card: learningCardSchema.parse(withCode) as never,
    });
    const spokenText = lesson.map((s) => ('say' in s ? s.say : '')).join(' ');
    /**
     * Code read aloud character by character is unlistenable, and it is the one
     * thing a synthesiser cannot degrade gracefully on — so the card says there
     * is code and stops.
     */
    check('code is never dictated', !spokenText.includes('def ') && !spokenText.includes('  '),
      spokenText.slice(0, 40));
    check('but the listener is told it exists', spokenText.includes('code example on screen'));
    check('and the takeaway is the last thing said',
      spokenText.trimEnd().endsWith(withCode.takeaway.replace(/\s*—\s*/g, ', ').replace(/["“”]/g, '')) ||
        spokenText.includes('Remember:'));

    const drill = speakableCard({
      kind: 'drill',
      key: 'd',
      state,
      track: 'dsa',
      questionId: 'two-sum',
      title: 'Two Sum',
      prompt: 'Given an array, find two numbers that add to a target.',
      difficulty: 'easy',
      tags: [],
      practice: { mode: 'dsa', questionId: 'two-sum' },
    });
    const gap = drill.find((s) => 'pause' in s) as { pause: number } | undefined;
    check('a drill leaves real time to answer out loud',
      !!gap && gap.pause >= 30_000, `${(gap?.pause ?? 0) / 1000}s`);

    const complexity = speakableCard({
      kind: 'lesson',
      key: 'k',
      state,
      becauseOf: null,
      card: learningCardSchema.parse({
        id: 'speech-fixture', kind: 'lesson', track: 'dsa', title: 'Cost',
        body: 'This is O(n log n) time — and O(1) space.',
        takeaway: 'Say it first.', tags: ['Array'],
      }) as never,
    });
    const text = complexity.map((s) => ('say' in s ? s.say : '')).join(' ');
    check('complexity is read as words, not brackets', text.includes('order n log n'), text);
    check('an em dash becomes a pause rather than a word', !text.includes('—'));

    /**
     * Emphasis capitals are the biggest single cause of a synthesiser sounding
     * like a machine: it either spells them out or barks them. Real acronyms
     * must survive, because saying the letters is correct for those.
     */
    const caps = speakableCard({
      kind: 'lesson',
      key: 'k',
      state,
      becauseOf: null,
      card: learningCardSchema.parse({
        id: 'caps-fixture', kind: 'lesson', track: 'concepts', title: 'Caps',
        body: 'You must NEVER block the loop. The SQS visibility timeout and the JWT both matter. Measure p99, not the mean.',
        takeaway: 'Say it plainly.', tags: ['nodejs'],
      }) as never,
    })
      .map((x) => ('say' in x ? x.say : ''))
      .join(' ');

    check('emphasis capitals are spoken as ordinary words', caps.includes('never block'), caps.slice(0, 60));
    check('real acronyms keep their letters', caps.includes('SQS') && caps.includes('JWT'));
    check('percentiles are read as numbers', caps.includes('p ninety nine'));
    check('every spoken segment ends on a falling tone',
      speakableCard({
        kind: 'fix', key: 'f', state, sessionId: 's', mode: 'dsa',
        fix: 'State the complexity first', dimension: null, score: null,
        evidenceQuote: null, at: NOW.toISOString(),
      }).every((x) => !('say' in x) || /[.!?]$/.test(x.say)));
  }

  /* ── 9. what gets pre-generated ─────────────────────────────────────────── */
  console.log('\n\x1b[1m9. narration splits into files at the pauses\x1b[0m');
  {
    const state = { timesSeen: 0, saved: false, strength: 0, dueAt: null };
    const asCard = (raw: unknown) =>
      ({ kind: 'lesson', key: 'k', state, becauseOf: null, card: learningCardSchema.parse(raw) }) as never;

    const lesson = speechGroups(
      speakableCard(asCard(LEARNING_CARDS.find((c) => c.kind === 'lesson')!)),
    );
    check('a lesson is one uninterrupted file', lesson.length === 1, `${lesson.length} group(s)`);
    check('with no trailing silence', lesson[0]?.pauseAfterMs === 0);

    const quiz = speechGroups(
      speakableCard({
        ...(asCard(LEARNING_CARDS.find((c) => c.kind === 'quiz')!) as object),
        kind: 'quiz',
      } as never),
    );
    check('a quiz is two files with the thinking gap between', quiz.length === 2, `${quiz.length}`);
    check('the gap is on the question, not the answer',
      (quiz[0]?.pauseAfterMs ?? 0) > 0 && quiz[1]?.pauseAfterMs === 0,
      `${quiz[0]?.pauseAfterMs}ms then ${quiz[1]?.pauseAfterMs}ms`);
    check('the answer is not in the first file', !quiz[0]?.text.includes('The answer is'));

    const drill = speechGroups(
      speakableCard({
        kind: 'drill', key: 'd', state, track: 'dsa', questionId: 'two-sum',
        title: 'Two Sum', prompt: 'Find two numbers that add to a target.',
        difficulty: 'easy', tags: [], practice: { mode: 'dsa', questionId: 'two-sum' },
      }),
    );
    check('a drill is one file followed by time to answer', drill.length === 1);
    check('and that time is real', (drill[0]?.pauseAfterMs ?? 0) >= 30_000,
      `${(drill[0]?.pauseAfterMs ?? 0) / 1000}s`);

    /**
     * An empty group would mean generating a file with nothing in it, which
     * fails at synthesis rather than at render — hours into a batch.
     */
    const everyCard = LEARNING_CARDS.map((c) => speechGroups(speakableCard(asCard(c)))).flat();
    check('no card produces an empty clip', everyCard.every((g) => g.text.trim().length > 0),
      `${everyCard.length} clips across the bank`);
    check('every clip is short enough to synthesise in one call',
      everyCard.every((g) => g.text.length < 4_000),
      `longest ${Math.max(...everyCard.map((g) => g.text.length))} chars`);
  }

  /* ── 9. personal signals ───────────────────────────────────────────────── */
  console.log('\n\x1b[1m9. personal signals\x1b[0m');
  {
    // Evaluations newest round first: e2 is the April round, e1 the March one.
    const outcomes = [
      { evaluationId: 'e2', questionId: 'two-sum', outcome: 'solved' },
      { evaluationId: 'e1', questionId: 'two-sum', outcome: 'unsolved' },
      { evaluationId: 'e1', questionId: 'coin-change', outcome: 'partial' },
      { evaluationId: 'e2', questionId: 'word-ladder', outcome: 'not_reached' },
      { evaluationId: 'e1', questionId: 'word-ladder', outcome: 'unsolved' },
    ];
    const recalls = unfinishedVerdicts(['e2', 'e1'], outcomes).map((r) => r.questionId);
    check('a problem solved since it was fumbled is not a recall',
      !recalls.includes('two-sum'), recalls.join());
    check('an older unfinished problem nothing newer touched is one',
      recalls.join() === 'coin-change', recalls.join());
    check('a newer not_reached decides too', !recalls.includes('word-ladder'));

    const dims = weakDimensions(['e3', 'e2', 'e1'], [
      { evaluationId: 'e3', dimension: 'structure', score: 5, assessment: 'Crisp and ordered.', evidenceQuote: 'first, second' },
      { evaluationId: 'e2', dimension: 'structure', score: 2, assessment: 'Jumped between ideas.', evidenceQuote: 'um so also' },
      { evaluationId: 'e1', dimension: 'structure', score: 2, assessment: 'Rambled.', evidenceQuote: null },
      { evaluationId: 'e3', dimension: 'pace', score: 4, assessment: 'Fine.', evidenceQuote: null },
    ]);
    const structure = dims.find((d) => d.dimension === 'structure');
    check('a weak dimension is decided by the mean',
      structure?.mean === 3 && !dims.some((d) => d.dimension === 'pace'),
      dims.map((d) => `${d.dimension}=${d.mean}`).join());
    check('and its words come from the newest round that scored it weak, not the newest round',
      structure?.assessment === 'Jumped between ideas.' && structure.evaluationId === 'e2' &&
        structure.evidenceQuote === 'um so also',
      `${structure?.assessment} (${structure?.evaluationId})`);
  }

  /* ── 10. the page query ─────────────────────────────────────────────────── */
  console.log('\n\x1b[1m10. the page query\x1b[0m');
  check('narrated=false is false', pageQuerySchema.parse({ narrated: 'false' }).narrated === false);
  check('narrated=true is true', pageQuerySchema.parse({ narrated: 'true' }).narrated === true);
  check('narrated absent is absent', pageQuerySchema.parse({}).narrated === undefined);

  /* ── 11. the narration cache on disk ────────────────────────────────────── */
  console.log('\n\x1b[1m11. the narration cache on disk\x1b[0m');
  {
    const dir = await mkdtemp(join(tmpdir(), 'orvia-speech-'));
    const root = join(dir, 'speech');
    await mkdir(join(root, 'Kore'), { recursive: true });
    await writeFile(join(root, 'Kore', 'a.m4a'), 'x');
    await writeFile(join(root, 'Kore.json'), JSON.stringify({ voice: 'Kore', model: 'm', entries: { 'card:x': [{ file: 'a.m4a', pauseAfterMs: 0 }] } }));
    await writeFile(join(root, 'Puck.json'), '{"voice": "Puck", "entr');
    await writeFile(join(dir, 'secret.txt'), 'x');
    const cache = new SpeechCacheService({ DATA_DIR: dir } as never);
    const voices = await cache.voices();
    check('one truncated manifest costs only its own voice',
      voices.length === 1 && voices[0]!.voice === 'Kore' && voices[0]!.cards === 1,
      JSON.stringify(voices));
    check('a real clip resolves', (await cache.resolveFile('Kore', 'a.m4a')) === join(root, 'Kore', 'a.m4a'));
    check('".." as the voice resolves to nothing', (await cache.resolveFile('..', 'secret.txt')) === null);
    check('a traversal in the file resolves to nothing',
      (await cache.resolveFile('Kore', '../../secret.txt')) === null);
    await rm(dir, { recursive: true, force: true });
  }

  /* ── summary ────────────────────────────────────────────────────────────── */
  console.log(
    `\n${fails.length === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fails.length} failed\x1b[0m\n`,
  );
  if (fails.length) {
    for (const f of fails) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
    process.exit(1);
  }
}

void main();
