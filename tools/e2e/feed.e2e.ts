/**
 * End-to-end suite for the learning feed API, testing card retrieval,
 * rating and review schedules, seed stability, day tracking, and history integration.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { assertTestDatabase, assertTestApi } from './guard';
import { SEEN_COOLDOWN_MS } from '../../packages/shared/src/feed.js';
import { isDue, resolveQueue, type ResolveHistory } from '../../packages/shared/src/resolve.js';
import { shiftDay } from '../../packages/shared/src/plan.js';

const API = process.env.E2E_API ?? 'http://localhost:8787';
const DB_URL = assertTestDatabase(
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test',
);

let passed = 0;
const failures: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) passed++;
  else failures.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};

const DAY = 86_400_000;
const dayKeyOf = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

type FeedCard = {
  key: string;
  kind: string;
  state: { timesSeen: number; saved: boolean; strength: number; dueAt: string | null };
  [k: string]: unknown;
};
type FeedPage = {
  cards: FeedCard[];
  nextOffset: number | null;
  meta: { todayCount: number; streak: number; dueCount: number; goal: number };
};

async function main() {
  console.log('\n\x1b[1mLearning feed — end to end\x1b[0m\n');
  await assertTestApi(API);

  const sql = postgres(DB_URL, { max: 2 });
  const email = `feed-e2e-${Date.now()}@example.test`;

  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'feed-e2e-password-1234', name: 'Feed E2E' }),
  });
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('account created', reg.ok && cookie.startsWith('orvia_session='), email);
  if (!cookie) {
    await sql.end();
    return report();
  }
  const userId = ((await reg.json()) as { id: string }).id;

  const feed = (q: string) =>
    fetch(`${API}/api/feed?${q}`, { headers: { cookie } }).then((r) => r.json() as Promise<FeedPage>);

  const act = (cardKey: string, action: string, extra: Record<string, unknown> = {}) =>
    fetch(`${API}/api/feed/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ cardKey, action, dayKey: dayKeyOf(), ...extra }),
    }).then((r) => r.json() as Promise<FeedCard['state']>);

  const today = dayKeyOf();

  try {
    /* ── 1. the shape of a page ─────────────────────────────────────────────── */
    console.log('\x1b[1m1. a page of feed\x1b[0m');
    const p1 = await feed(`limit=8&seed=101&day=${today}`);

    check('a page comes back with cards', Array.isArray(p1.cards) && p1.cards.length > 0,
      `${p1.cards.length} cards`);
    check('every card carries a key, a kind and its own state',
      p1.cards.every((c) => !!c.key && !!c.kind && !!c.state));
    check('the stat card is pinned to the top of page one', p1.cards[0]?.kind === 'stat',
      p1.cards[0]?.kind);
    check('the requested limit is respected beside it', p1.cards.length === 9,
      `${p1.cards.length}`);
    check('meta reports the daily goal', p1.meta.goal > 0 && p1.meta.todayCount === 0,
      `${p1.meta.todayCount}/${p1.meta.goal}`);
    check('there is a next page', p1.nextOffset === 8, String(p1.nextOffset));

    const p2 = await feed(`limit=8&offset=8&seed=101&day=${today}`);
    check('page two carries no stat card', p2.cards.every((c) => c.kind !== 'stat'));
    const overlap = p2.cards.filter((c) => p1.cards.some((x) => x.key === c.key));
    check('page two repeats nothing from page one', overlap.length === 0,
      overlap.map((c) => c.key).join(', '));

    /* ── 2. the same seed replays the same feed ─────────────────────────────── */
    console.log('\n\x1b[1m2. seeded ordering\x1b[0m');
    const again = await feed(`limit=8&seed=101&day=${today}`);
    check('the same seed gives exactly the same page',
      again.cards.map((c) => c.key).join() === p1.cards.map((c) => c.key).join());

    const orders = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const p = await feed(`limit=8&seed=${seed}&day=${today}`);
      orders.add(p.cards.map((c) => c.key).join());
    }
    check('a different seed draws a different feed', orders.size >= 4,
      `${orders.size} distinct orders in 6 seeds`);

    /* ── 3. nothing here is an answer key ───────────────────────────────────── */
    console.log('\n\x1b[1m3. the endpoint never serves the evaluator\'s half\x1b[0m');
    {
      const wide: FeedCard[] = [];
      for (let off = 0; off < 120; off += 30) {
        wide.push(...(await feed(`limit=30&offset=${off}&seed=77&day=${today}`)).cards);
      }
      const blob = JSON.stringify(wide);

      const forbidden = ['expectedPoints', 'commonMistakes', 'strongAnswer', 'rubricNotes',
        'probes', 'beats', 'referenceSolution', 'keyInsights'];
      const leakedField = forbidden.filter((f) => blob.includes(`"${f}"`));
      check('no evaluator-only FIELD appears in any card', leakedField.length === 0,
        leakedField.join(', '));

      /**
       * And not by value either. A field renamed on the way out would pass the
       * check above while shipping the same sentences — so this asks the
       * database for real answer material and looks for it in what was served.
       */
      const keys = await sql<{ text: string }[]>`
        select jsonb_array_elements_text(expected_points) as text
        from concept_questions limit 200`;
      const long = keys.map((r) => r.text).filter((t) => t.length > 60).slice(0, 60);
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
      const flat = norm(blob);
      const leakedText = long.filter((t) => flat.includes(norm(t)));
      check('no answer-key SENTENCE appears in any card', leakedText.length === 0,
        `checked ${long.length} · ${leakedText[0]?.slice(0, 50) ?? ''}`);

      const drills = wide.filter((c) => c.kind === 'drill');
      check('the page contains drills to check', drills.length > 0, `${drills.length}`);
      check('a drill carries a prompt and a practice target only',
        drills.every((d) => typeof d.prompt === 'string' && !!d.practice && !('probes' in d)));
    }

    /* ── 4. rating a card schedules it ──────────────────────────────────────── */
    console.log('\n\x1b[1m4. the review ladder, through the API\x1b[0m');
    const fresh = await feed(`limit=12&seed=303&day=${today}`);
    const teaching = fresh.cards.filter((c) => c.key.startsWith('card:'));
    const known = teaching[0]!;
    const fumbled = teaching[1]!;
    const scrolled = teaching[2]!;

    const s1 = await act(known.key, 'got_it');
    check('"knew it" sets strength to one', s1.strength === 1, String(s1.strength));
    const gap1 = Date.parse(s1.dueAt!) - Date.now();
    check('and schedules it about a day out', gap1 > 0.9 * DAY && gap1 < 1.1 * DAY,
      `${Math.round(gap1 / 3_600_000)}h`);

    const s2 = await act(known.key, 'got_it');
    check('a second "knew it" pushes it further out', Date.parse(s2.dueAt!) - Date.now() > gap1,
      `strength ${s2.strength}`);

    const s3 = await act(fumbled.key, 'shaky');
    check('"show again" drops strength to zero', s3.strength === 0);
    const gap3 = Date.parse(s3.dueAt!) - Date.now();
    check('and brings it back inside the hour', gap3 > 0 && gap3 < 3_600_000,
      `${Math.round(gap3 / 60_000)} min`);

    /**
     * A subsequent `seen` interaction must not overwrite an existing scheduled review,
     * ensuring explicit ratings take precedence over scroll events.
     */
    const s4 = await act(fumbled.key, 'seen');
    check('scrolling past does not move an existing review', s4.dueAt === s3.dueAt,
      `${s3.dueAt} -> ${s4.dueAt}`);

    // The server stamps `now` somewhere inside this request, on the same clock.
    const sentAt = Date.now();
    const s5 = await act(scrolled.key, 'seen');
    const answeredAt = Date.now();
    check('a card only scrolled past keeps strength zero', s5.strength === 0);
    const due5 = Date.parse(s5.dueAt!);
    check('and is due exactly one cooldown after the scroll',
      due5 >= sentAt + SEEN_COOLDOWN_MS - 1_000 && due5 <= answeredAt + SEEN_COOLDOWN_MS + 1_000,
      `${due5 - sentAt - SEEN_COOLDOWN_MS}ms off`);

    /* ── 5. a rated card stops being served ─────────────────────────────────── */
    console.log('\n\x1b[1m5. what you rated does not come back\x1b[0m');
    {
      const after = await feed(`limit=30&seed=303&day=${today}`);
      const keys = new Set(after.cards.map((c) => c.key));
      check('the card you knew is gone from the feed', !keys.has(known.key), known.key);
      check('the card you scrolled past is gone too', !keys.has(scrolled.key));
      check('the feed refilled rather than shrinking', after.cards.length === 31,
        `${after.cards.length}`);
    }

    /* ── 6. the day counter and the streak ──────────────────────────────────── */
    console.log('\n\x1b[1m6. the day counter counts cards, not presses\x1b[0m');
    {
      const m = (await feed(`limit=1&seed=1&day=${today}`)).meta;
      // Two cards were RATED (got_it twice on one, shaky on another). `seen`
      // must not count, or a streak could be built by scrolling.
      check('rating the same card twice counts once', m.todayCount === 2,
        `${m.todayCount} today`);
      check('a day with a rating is a streak of one', m.streak === 1, String(m.streak));

      await sql`
        insert into feed_events (user_id, card_key, action, day_key)
        values (${userId}, 'card:backdated', 'got_it', ${dayKeyOf(-1)})`;
      const m2 = (await feed(`limit=1&seed=1&day=${today}`)).meta;
      check('yesterday plus today is a streak of two', m2.streak === 2, String(m2.streak));

      const m3 = (await feed(`limit=1&seed=1&day=${dayKeyOf(-3)}`)).meta;
      check('the counter follows the day the CLIENT says it is', m3.todayCount === 0,
        `${m3.todayCount} on ${dayKeyOf(-3)}`);
    }

    /* ── 7. saving ──────────────────────────────────────────────────────────── */
    console.log('\n\x1b[1m7. saved cards survive the card being derived\x1b[0m');
    {
      const saveMe = (await feed(`limit=12&seed=909&day=${today}`)).cards.find(
        (c) => c.kind !== 'stat',
      )!;
      const st = await act(saveMe.key, 'save', {
        snapshot: { ...saveMe, state: { ...saveMe.state, saved: true } },
      });
      check('saving marks the card saved', st.saved === true);

      const saved = await fetch(`${API}/api/feed/saved`, { headers: { cookie } }).then(
        (r) => r.json() as Promise<{ key: string; card: FeedCard }[]>,
      );
      check('it appears in the saved list', saved.some((s) => s.key === saveMe.key),
        saved.map((s) => s.key).join(', '));
      check('the snapshot renders as a saved card',
        saved.find((s) => s.key === saveMe.key)?.card.state.saved === true);

      await act(saveMe.key, 'unsave');
      const after = await fetch(`${API}/api/feed/saved`, { headers: { cookie } }).then(
        (r) => r.json() as Promise<{ key: string }[]>,
      );
      check('unsaving removes it', !after.some((s) => s.key === saveMe.key));
    }

    /* ── 8. your own history becomes cards ──────────────────────────────────── */
    console.log('\n\x1b[1m8. unfinished problems and your own reports\x1b[0m');
    {
      /**
       * Seed a finished session with both an unsolved and a solved question to verify
       * that the feed surfaces only unsolved questions for review.
       */
      const [session] = await sql<{ id: string }[]>`
        insert into sessions (user_id, mode, status, config, options, model, voice,
                              started_at, ended_at, duration_ms)
        values (${userId}, 'dsa', 'completed',
                ${sql.json({ mode: 'dsa', questionIds: ['two-sum', 'valid-parentheses'] })},
                ${sql.json({ durationMinutes: 30 })}, 'test-model', 'Charon',
                now() - interval '2 hours', now() - interval '1 hour', 1800000)
        returning id`;

      const [evaluation] = await sql<{ id: string }[]>`
        insert into evaluations (session_id, status, model, rubric_version, overall_score,
                                 overall_verdict, summary, top_fixes, completed_at)
        values (${session!.id}, 'complete', 'test-model', '1.4.0', 61, 'borderline',
                'A test round.',
                ${sql.json(['State the complexity before you write the code, not after.'])},
                now())
        returning id`;

      await sql`
        insert into question_outcomes (evaluation_id, question_id, idx, outcome, reason, evidence_quote)
        values (${evaluation!.id}, 'two-sum', 0, 'unsolved',
                'Never reached the hash map approach.', 'I think we sort it first?'),
               (${evaluation!.id}, 'valid-parentheses', 1, 'solved',
                'Clean stack solution with the right edge cases.', 'push on open, pop on close')`;

      await sql`
        insert into delivery_scores (evaluation_id, dimension, score, assessment, evidence_quote)
        values (${evaluation!.id}, 'structure', 2,
                'Answers arrived as a stream with no stated plan.', 'so yeah, um, maybe we could')`;

      const withHistory = await feed(`limit=30&seed=505&day=${today}`);
      const recalls = withHistory.cards.filter((c) => c.kind === 'recall');
      const fixes = withHistory.cards.filter((c) => c.kind === 'fix');

      check('an unsolved problem comes back as a recall',
        recalls.some((c) => c.questionId === 'two-sum'),
        recalls.map((c) => String(c.questionId)).join(', ') || 'none');
      check('a SOLVED problem does not',
        !recalls.some((c) => c.questionId === 'valid-parentheses'));
      check('the recall carries the evaluator\'s own reason verbatim',
        recalls.some((c) => String(c.reason).includes('hash map')));
      check('and knows how it went', recalls.every((c) => c.outcome === 'unsolved' || c.outcome === 'partial'));

      check('the report\'s top fix becomes a card',
        fixes.some((c) => String(c.fix).includes('complexity')),
        fixes.map((c) => String(c.fix).slice(0, 30)).join(' | ') || 'none');
      check('a low delivery dimension becomes a card with its evidence',
        fixes.some((c) => c.dimension === 'structure' && String(c.evidenceQuote).includes('um')));

      const stat = withHistory.cards.find((c) => c.kind === 'stat');
      const weak = (stat?.weakTopics as string[]) ?? [];
      check('the stat card names what the feed is leaning towards',
        weak.includes('structure') || weak.some((t) => /hash|array/i.test(t)),
        weak.join(', ') || 'none');
      check('and counts the round', (stat?.roundsThisWeek as number) >= 1,
        String(stat?.roundsThisWeek));
    }

    /* ── 9. the feed ends ───────────────────────────────────────────────────── */
    console.log('\n\x1b[1m9. it ends, and it never repeats itself\x1b[0m');
    {
      const seen = new Set<string>();
      let offset = 0;
      let pages = 0;
      let duplicate = '';
      for (;;) {
        const page = await feed(`limit=30&offset=${offset}&seed=606&day=${today}`);
        for (const c of page.cards) {
          if (c.kind === 'stat') continue;
          if (seen.has(c.key)) duplicate ||= c.key;
          seen.add(c.key);
        }
        pages++;
        if (page.nextOffset === null || pages > 25) break;
        offset = page.nextOffset;
      }
      check('the whole feed contains no card twice', duplicate === '', duplicate);
      check('and it reaches an end rather than looping', pages <= 25, `${pages} pages`);
      check('with real material in it', seen.size > 100, `${seen.size} distinct cards`);
    }

    /* ── 10. the re-solve queue reads the same history ─────────────────────── */
    console.log('\n\x1b[1m10. the re-solve queue, and the rotation it shares a query with\x1b[0m');
    {
      type Eval = { status: string; outcomes?: [string, string, string][]; minutesAfter?: number };
      const round = async (o: {
        daysAgo: number; ids: string[]; evals: Eval[]; kind?: string; durationMs?: number; reached?: number;
      }) => {
        const [s] = await sql<{ id: string }[]>`
          insert into sessions (user_id, mode, status, config, options, model, voice, kind,
                                started_at, ended_at, duration_ms, current_question_idx)
          values (${userId}, 'dsa', 'completed', ${sql.json({ mode: 'dsa', questionIds: o.ids })},
                  ${sql.json({ durationMinutes: 30 })}, 'test-model', 'Charon', ${o.kind ?? 'round'},
                  now() - ${`${o.daysAgo} days`}::interval, now() - ${`${o.daysAgo} days`}::interval + interval '30 minutes',
                  ${o.durationMs ?? 1_800_000}, ${o.reached ?? o.ids.length - 1})
          returning id`;
        for (const e of o.evals) {
          const [ev] = await sql<{ id: string }[]>`
            insert into evaluations (session_id, status, model, rubric_version, created_at)
            values (${s!.id}, ${e.status}, 'test-model', '1.4.0',
                    now() - ${`${o.daysAgo} days`}::interval + ${`${30 + (e.minutesAfter ?? 0)} minutes`}::interval)
            returning id`;
          for (const [i, [q, outcome, reason]] of (e.outcomes ?? []).entries()) {
            await sql`insert into question_outcomes (evaluation_id, question_id, idx, outcome, reason)
                      values (${ev!.id}, ${q}, ${i}, ${outcome}, ${reason})`;
          }
        }
        return s!.id;
      };

      const r1 = await round({ daysAgo: 10, ids: ['merge-intervals', 'two-sum'], evals: [{ status: 'complete', outcomes: [
        ['merge-intervals', 'partial', 'Missed the overlap at equal ends.'], ['two-sum', 'solved', 'Hash map, first try.']] }] });
      const r2 = await round({ daysAgo: 5, ids: ['merge-intervals'], evals: [{ status: 'complete', outcomes: [
        ['merge-intervals', 'solved', 'Sorted and merged cleanly.']] }] });
      // A complete report and a NEWER re-run that failed: the complete one speaks.
      const r3 = await round({ daysAgo: 4, ids: ['spiral-matrix'], evals: [
        { status: 'complete', outcomes: [['spiral-matrix', 'unsolved', 'Lost track of the boundaries.']] },
        { status: 'failed', minutesAfter: 60 }] });
      // Its re-solve, report still being written.
      const r4 = await round({ daysAgo: 0, ids: ['spiral-matrix'], evals: [{ status: 'evaluating' }] });
      // None of these may count.
      await round({ daysAgo: 1, ids: ['spiral-matrix'], kind: 'drill', evals: [{ status: 'complete', outcomes: [
        ['spiral-matrix', 'solved', 'Drilled after reading the answer.']] }] });
      await round({ daysAgo: 1, ids: ['car-fleet'], durationMs: 30_000, evals: [{ status: 'complete', outcomes: [
        ['car-fleet', 'unsolved', 'Hung up after thirty seconds.']] }] });
      const r7 = await round({ daysAgo: 2, ids: ['course-schedule'], evals: [{ status: 'failed' }] });

      const res = await fetch(`${API}/api/questions/resolve`, { headers: { cookie } });
      const body = (await res.json()) as ResolveHistory;
      check('GET /api/questions/resolve answers', res.ok, String(res.status));
      const anon = await fetch(`${API}/api/questions/resolve`);
      check('and refuses without an account', anon.status === 401, String(anon.status));

      const of = (q: string) => body.attempts.filter((a) => a.questionId === q)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      check('every verdict on merge-intervals, from both rounds',
        of('merge-intervals').map((a) => `${a.sessionId === r1 ? 'r1' : a.sessionId === r2 ? 'r2' : '?'}:${a.outcome}`).join()
          === 'r1:partial,r2:solved', JSON.stringify(of('merge-intervals')));
      check('with the evaluator\'s reason verbatim',
        of('merge-intervals')[0]?.reason === 'Missed the overlap at equal ends.');
      check('a failed re-run does not hide the complete report before it',
        of('spiral-matrix').some((a) => a.sessionId === r3 && a.outcome === 'unsolved'));
      check('a round whose report is still running is sent as pending',
        of('spiral-matrix').some((a) => a.sessionId === r4 && a.outcome === null));
      check('a drill is not a re-solve',
        !of('spiral-matrix').some((a) => a.outcome === 'solved'), JSON.stringify(of('spiral-matrix')));
      check('a round under a minute is not an attempt', of('car-fleet').length === 0);
      check('a round whose only evaluation FAILED is left out, not pending for ever',
        !body.attempts.some((a) => a.sessionId === r7));
      check('titles are joined from the bank',
        body.questions.find((q) => q.id === 'merge-intervals')?.title === 'Merge Intervals',
        JSON.stringify(body.questions.find((q) => q.id === 'merge-intervals')));

      const queue = resolveQueue(body.attempts.map((a) => ({ ...a, dayKey: a.startedAt.slice(0, 10) })));
      const item = (q: string) => queue.find((i) => i.questionId === q);
      check('merge-intervals: one solve since the miss, due a week from it',
        item('merge-intervals')?.step === 1 && item('merge-intervals')?.dueKey === shiftDay(dayKeyOf(-5), 7),
        JSON.stringify(item('merge-intervals')));
      check('spiral-matrix waits on its report rather than reading due',
        item('spiral-matrix')?.pending === true && !isDue(item('spiral-matrix')!, today));
      check('a problem solved the first time never enters (section 8\'s valid-parentheses)',
        !item('valid-parentheses'));
      check('solved, then missed later (two-sum, via section 8): back at step 0 on the newer miss',
        item('two-sum')?.step === 0 && item('two-sum')?.miss.outcome === 'unsolved'
          && item('two-sum')?.history.map((h) => h.outcome).join() === 'solved,unsolved',
        JSON.stringify(item('two-sum')));

      // The rotation now shares this query: its answer must not have moved.
      const att = (await fetch(`${API}/api/questions/attempted?mode=dsa`, { headers: { cookie } })
        .then((r) => r.json())) as { id: string; count: number; outcome: string | null }[];
      const a = (q: string) => att.find((x) => x.id === q);
      check('rotation: latest round wins for merge-intervals', a('merge-intervals')?.outcome === 'solved' && a('merge-intervals')?.count === 2);
      check('rotation: a running report holds spiral-matrix as spent', a('spiral-matrix')?.outcome === null && a('spiral-matrix')?.count === 2,
        JSON.stringify(a('spiral-matrix')));
      check('rotation: drills and sub-minute rounds still do not count', !a('car-fleet'));
      check('rotation: a failed-only round still spends its question', a('course-schedule')?.outcome === null);
    }
  } finally {
    // Its own account only, by email — the same contract as `test:assignment`.
    // Everything else cascades from the user row.
    await sql`delete from users where email = ${email}`;
    await sql.end();
  }

  return report();
}

function report() {
  const total = passed + failures.length;
  console.log(
    `\n${failures.length === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${total} checks passed\x1b[0m\n`,
  );
  if (failures.length) {
    for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
    process.exit(1);
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
