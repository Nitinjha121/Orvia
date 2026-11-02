/**
 * Seeds the learning feed bank. Offline, deterministic, and idempotent.
 * Validates cards against `learningCardSchema` before writing and prunes deleted cards.
 *
 *   pnpm --filter @orvia/api seed:learning
 */
import 'dotenv/config';
import { notInArray, sql as raw } from 'drizzle-orm';
import { createDb, learningCards } from '@orvia/db';
import { learningCardSchema } from '@orvia/shared';
import { LEARNING_CARDS } from './data/learning-cards.mts';

async function main() {
  /**
   * Validated before the connection is opened, so a bad card cannot half-write
   * the bank. `z.treeifyError` is not used: one card, one line, is what you
   * want when the file is two thousand lines long.
   */
  const parsed = LEARNING_CARDS.map((card) => {
    const result = learningCardSchema.safeParse(card);
    if (!result.success) {
      const why = result.error.issues.map((i) => `${i.path.join('.') || '(card)'}: ${i.message}`);
      throw new Error(`learning card "${card.id}" is invalid — ${why.join('; ')}`);
    }
    return result.data;
  });

  const ids = new Set<string>();
  for (const c of parsed) {
    // A duplicate id silently overwrites the earlier card AND merges two
    // reading histories into one, which is invisible until someone's review
    // ladder behaves oddly on a card they have never seen.
    if (ids.has(c.id)) throw new Error(`duplicate learning card id "${c.id}"`);
    ids.add(c.id);
  }

  const { db, client } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia',
  );

  await db
    .insert(learningCards)
    .values(
      /**
       * Position comes from the order in the file, like the conversational
       * banks: the file IS the running order, and a number written beside each
       * entry could only drift from it. It is a weak signal in the feed anyway
       * — the weak-topic boost and the jitter both outrank it.
       */
      parsed.map((c, i) => ({
        id: c.id,
        kind: c.kind,
        track: c.track,
        title: c.title,
        body: c.body,
        takeaway: c.takeaway,
        code: c.code ?? null,
        codeLanguage: c.codeLanguage ?? null,
        tags: c.tags,
        difficulty: c.difficulty,
        choices: c.choices ?? null,
        answerIdx: c.answerIdx ?? null,
        explanation: c.explanation ?? null,
        orderIdx: i,
      })),
    )
    .onConflictDoUpdate({
      target: learningCards.id,
      set: {
        kind: raw`excluded.kind`,
        track: raw`excluded.track`,
        title: raw`excluded.title`,
        body: raw`excluded.body`,
        takeaway: raw`excluded.takeaway`,
        code: raw`excluded.code`,
        codeLanguage: raw`excluded.code_language`,
        tags: raw`excluded.tags`,
        difficulty: raw`excluded.difficulty`,
        choices: raw`excluded.choices`,
        answerIdx: raw`excluded.answer_idx`,
        explanation: raw`excluded.explanation`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  const pruned = await db
    .delete(learningCards)
    .where(notInArray(learningCards.id, [...ids]))
    .returning({ id: learningCards.id });

  const byTrack = new Map<string, number>();
  for (const c of parsed) byTrack.set(c.track, (byTrack.get(c.track) ?? 0) + 1);
  const breakdown = [...byTrack.entries()].map(([t, n]) => `${t} ${n}`).join(', ');

  console.log(`seeded ${parsed.length} learning cards (${breakdown})`);
  if (pruned.length) {
    console.log(`pruned ${pruned.length} stale card(s): ${pruned.map((r) => r.id).join(', ')}`);
  }

  await client.end();
}

void main();
