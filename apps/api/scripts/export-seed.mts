/**
 * Snapshots the question bank out of Postgres into a committed seed file.
 *
 * `ingest` depends on LeetCode being reachable and (for enrichment) on API
 * quota. `seed` must not depend on either — a fresh clone should get the full
 * bank offline, deterministically, in one command.
 */
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc } from 'drizzle-orm';
import { createDb, dsaQuestions, questionCollections, collections, systemDesignProblems } from '@orvia/db';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'question-bank.seed.json');

async function main() {
  const { db, client } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia');

  const bank = {
    generatedAt: new Date().toISOString(),
    collections: await db.select().from(collections).orderBy(asc(collections.orderIdx)),
    questions: await db.select().from(dsaQuestions).orderBy(asc(dsaQuestions.id)),
    links: await db.select().from(questionCollections).orderBy(asc(questionCollections.collection), asc(questionCollections.orderIdx)),
    systemDesign: await db.select().from(systemDesignProblems).orderBy(asc(systemDesignProblems.orderIdx)),
  };

  await writeFile(OUT, JSON.stringify(bank, null, 2));
  console.log(
    `wrote ${OUT}\n  ${bank.questions.length} questions, ${bank.links.length} links across ` +
      `${bank.collections.length} collections, ${bank.systemDesign.length} system design problems`,
  );
  await client.end();
}

void main();
