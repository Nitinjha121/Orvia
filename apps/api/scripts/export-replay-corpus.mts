/**
 * Exports every recorded round as a replay corpus for `replay-guards.mts`.
 *
 * Read-only: SELECTs against the database in `.env`, which is the real one —
 * the corpus is the real rounds, and that is the point. It holds transcripts,
 * so it is written under `data/`, which is gitignored and never committed.
 *
 *   pnpm --filter @orvia/api replay:export
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, eq, inArray } from 'drizzle-orm';
import { createDb, sessions, turns, contextSnapshots, dsaQuestions } from '@orvia/db';
import type { ReplayRound } from './replay-corpus';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay', 'corpus.json');

async function main() {
  const { db, client } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia');

  const rows = await db.select().from(sessions).orderBy(asc(sessions.startedAt));
  const ids = new Set<string>();
  for (const r of rows) {
    const cfg = r.config as { questionIds?: string[] };
    if (r.mode === 'dsa') for (const id of cfg.questionIds ?? []) ids.add(id);
  }
  const bank = ids.size
    ? await db.select().from(dsaQuestions).where(inArray(dsaQuestions.id, [...ids]))
    : [];
  const byId = new Map(bank.map((q) => [q.id, q]));

  const rounds: ReplayRound[] = [];
  for (const s of rows) {
    const t = await db
      .select({ speaker: turns.speaker, text: turns.text, startMs: turns.startMs, interrupted: turns.interrupted })
      .from(turns)
      .where(eq(turns.sessionId, s.id))
      .orderBy(asc(turns.idx));
    if (t.length < 2) continue;
    const ctx = await db
      .select({ kind: contextSnapshots.kind, content: contextSnapshots.content, atMs: contextSnapshots.atMs })
      .from(contextSnapshots)
      .where(eq(contextSnapshots.sessionId, s.id))
      .orderBy(asc(contextSnapshots.atMs));

    const cfg = s.config as { questionIds?: string[] };
    // In the candidate's selection order, as `SessionService.create` builds them.
    const qids = s.mode === 'dsa' ? (cfg.questionIds ?? []).filter((id) => byId.has(id)) : [];
    rounds.push({
      id: s.id,
      mode: s.mode,
      kind: s.kind,
      startedAt: s.startedAt.toISOString(),
      config: s.config,
      options: s.options,
      questions: qids.map((id) => {
        const q = byId.get(id)!;
        return {
          id: q.id,
          title: q.title,
          difficulty: q.difficulty,
          prompt: q.prompt,
          constraints: (q.constraints as string[] | null) ?? null,
        };
      }),
      starters: Object.fromEntries(
        qids.map((id) => [
          id,
          Object.values((byId.get(id)!.codeSnippets as Record<string, unknown> | null) ?? {}).filter(
            (v): v is string => typeof v === 'string',
          ),
        ]),
      ),
      turns: t.map((x) => ({ ...x, speaker: x.speaker as 'ai' | 'user' })),
      context: ctx.map((x) => ({ ...x, kind: x.kind as 'code' | 'design' })),
      guardEvents: (s.guardEvents as unknown[] | null) ?? [],
    });
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ exportedAt: new Date().toISOString(), rounds }));
  console.log(`wrote ${OUT}: ${rounds.length} rounds, ${rounds.reduce((n, r) => n + r.turns.length, 0)} turns`);
  await client.end();
}

void main();
