/**
 * Seeds the entire question bank from the committed snapshot.
 * Offline, deterministic, idempotent — no LeetCode, no API quota.
 *
 *   pnpm --filter @orvia/api seed
 *
 * To refresh the snapshot after re-ingesting: pnpm --filter @orvia/api export-seed
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as raw } from 'drizzle-orm';
import {
  createDb,
  dsaQuestions,
  questionCollections,
  collections,
  systemDesignProblems,
} from '@orvia/db';

type Bank = {
  collections: (typeof collections.$inferInsert)[];
  questions: (typeof dsaQuestions.$inferInsert)[];
  links: (typeof questionCollections.$inferInsert)[];
  systemDesign: (typeof systemDesignProblems.$inferInsert)[];
};

async function main() {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'data', 'question-bank.seed.json');
  const bank = JSON.parse(await readFile(file, 'utf8')) as Bank;

  const { db, client } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia');

  // Order matters: collections and questions must exist before the links that
  // reference them.
  await db
    .insert(collections)
    .values(bank.collections)
    .onConflictDoUpdate({
      target: collections.id,
      set: {
        label: raw`excluded.label`,
        blurb: raw`excluded.blurb`,
        sourceType: raw`excluded.source_type`,
        sourceRef: raw`excluded.source_ref`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  for (let i = 0; i < bank.questions.length; i += 100) {
    await db
      .insert(dsaQuestions)
      .values(bank.questions.slice(i, i + 100))
      .onConflictDoUpdate({
        target: dsaQuestions.id,
        set: {
          title: raw`excluded.title`,
          difficulty: raw`excluded.difficulty`,
          topics: raw`excluded.topics`,
          prompt: raw`excluded.prompt`,
          codeSnippets: raw`excluded.code_snippets`,
          practiceUrl: raw`excluded.practice_url`,
          referenceSolution: raw`excluded.reference_solution`,
          optimalComplexity: raw`excluded.optimal_complexity`,
          keyInsights: raw`excluded.key_insights`,
          // Preserves the snapshot's authoritative fromTitleOnly value on update.
          fromTitleOnly: raw`excluded.from_title_only`,
          constraints: raw`excluded.constraints`,
        },
      });
  }

  /**
   * Updates `orderIdx` on conflict so link positions stay in sync
   * when earlier-numbered problems are added.
   */
  for (let i = 0; i < bank.links.length; i += 200) {
    await db
      .insert(questionCollections)
      .values(bank.links.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [questionCollections.collection, questionCollections.questionId],
        set: { orderIdx: raw`excluded.order_idx` },
      });
  }

  await db
    .insert(systemDesignProblems)
    .values(bank.systemDesign)
    .onConflictDoUpdate({
      target: systemDesignProblems.id,
      set: {
        title: raw`excluded.title`,
        level: raw`excluded.level`,
        prompt: raw`excluded.prompt`,
        rubricNotes: raw`excluded.rubric_notes`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  console.log(
    `seeded ${bank.questions.length} questions across ${bank.collections.length} collections ` +
      `(${bank.links.length} links), ${bank.systemDesign.length} system design problems`,
  );
  await client.end();
}

void main();
