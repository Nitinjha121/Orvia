/**
 * Backfills `constraints` into the committed seed snapshot directly from LeetCode.
 *
 * Uses `fetchDetail` with retries. Paid-only problems return no content and stay null.
 *
 *   pnpm --filter @orvia/api constraints:fetch
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDetail, keepConstraints, sleep } from './leetcode.mts';

const SEED = join(dirname(fileURLToPath(import.meta.url)), 'data', 'question-bank.seed.json');
const CONCURRENCY = 4;

type Row = { id: string; practiceUrl?: string | null; constraints?: string[] | null };

async function main() {
  const bank = JSON.parse(await readFile(SEED, 'utf8')) as { questions: Row[] };
  const failed: string[] = [];
  let filled = 0;
  let none = 0;
  let cursor = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const q = bank.questions[cursor++];
        if (!q) return;
        try {
          const d = await fetchDetail(q.id);
          q.constraints = keepConstraints(d.constraints, q.constraints);
          if (q.constraints) filled++;
          else none++;
        } catch (e) {
          failed.push(`${q.id}: ${(e as Error).message}`);
          q.constraints = q.constraints ?? null;
        }
        await sleep(250);
      }
    }),
  );

  await writeFile(SEED, JSON.stringify(bank, null, 2));
  console.log(`${filled}/${bank.questions.length} questions carry constraints, ${none} have none upstream`);
  if (failed.length) {
    console.log(`${failed.length} failed — re-run to retry:\n  ${failed.join('\n  ')}`);
    process.exit(1);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
