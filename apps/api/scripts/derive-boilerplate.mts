/**
 * Derives the `BOILERPLATE` stoplist in `src/interview/question-tracker.ts`.
 *
 * Matches distinctive word pairs across problem statements to identify transitions,
 * filtering out generic phrases while ensuring each problem retains enough unique
 * pairs to be detectable.
 *
 *   pnpm --filter @orvia/api derive:boilerplate
 *   pnpm --filter @orvia/api derive:boilerplate 8    (a different percentage)
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Kept in step with `question-tracker.ts` by hand — it is one number. */
const MIN_HITS = 4;
const DEFAULT_PERCENT = 5;

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function bigrams(text: string): Set<string> {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
  return out;
}

async function main() {
  const percent = Number(process.argv[2] ?? DEFAULT_PERCENT);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    throw new Error(`percentage must be between 0 and 100, got "${process.argv[2]}"`);
  }

  const file = join(dirname(fileURLToPath(import.meta.url)), 'data', 'question-bank.seed.json');
  const bank = JSON.parse(await readFile(file, 'utf8')) as {
    questions: { id: string; title: string; prompt: string }[];
  };

  const sets = bank.questions.map((q) => ({ id: q.id, grams: bigrams(`${q.title} ${q.prompt}`) }));
  const df = new Map<string, number>();
  for (const { grams } of sets) for (const g of grams) df.set(g, (df.get(g) ?? 0) + 1);

  const threshold = Math.max(2, Math.round((bank.questions.length * percent) / 100));
  const stop = [...df].filter(([, n]) => n >= threshold).map(([g]) => g).sort();
  const stopSet = new Set(stop);

  console.log(
    `${bank.questions.length} prompts · a pair in >= ${percent}% (${threshold} prompts) ` +
      `is boilerplate · ${stop.length} of ${df.size} pairs stoplisted\n`,
  );

  // Wrapped by ITEM. A bigram contains a space, so any wrapper that breaks on
  // whitespace will happily split one across two lines and produce an
  // unterminated string literal.
  const lines: string[] = [];
  let cur = '  ';
  for (const g of stop) {
    const item = `'${g}',`;
    if (cur.length + item.length + 1 > 96) {
      lines.push(cur.trimEnd());
      cur = '  ';
    }
    cur += `${item} `;
  }
  if (cur.trim()) lines.push(cur.trimEnd());

  console.log('const BOILERPLATE = new Set([');
  for (const l of lines) console.log(l);
  console.log(']);\n');

  /**
   * The check in the direction that actually costs something. A stoplist that
   * is too aggressive strips a problem of everything that identifies it, and
   * the round then never follows the interviewer onto it.
   */
  const kept = sets
    .map(({ id, grams }) => ({ id, n: [...grams].filter((g) => !stopSet.has(g)).length }))
    .sort((a, b) => a.n - b.n);
  const worst = kept.slice(0, 5);
  const median = kept[Math.floor(kept.length / 2)]!.n;

  console.log(`Distinctive pairs left per prompt: min ${worst[0]!.n}, median ${median}`);
  console.log(`Thinnest problems (MIN_HITS is ${MIN_HITS}):`);
  for (const k of worst) console.log(`  ${String(k.n).padStart(3)}  ${k.id}`);
  const unusable = kept.filter((k) => k.n < MIN_HITS);
  if (unusable.length) {
    console.log(
      `\n! ${unusable.length} problem(s) fall below MIN_HITS and could no longer be ` +
        `identified from their statement: ${unusable.map((k) => k.id).join(', ')}`,
    );
    console.log('! Lower the percentage.');
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
