/**
 * Seeds question banks for conversational rounds (concepts, behavioural, HR).
 * Offline, deterministic, and idempotent. Prunes deleted items from the database.
 *
 *   pnpm --filter @orvia/api seed:conversational
 */
import 'dotenv/config';
import { notInArray, sql as raw } from 'drizzle-orm';
import {
  createDb,
  conceptTopics,
  conceptQuestions,
  behaviouralCompetencies,
  behaviouralQuestions,
  hrScenarios,
} from '@orvia/db';
import {
  CONCEPT_TOPICS,
  CONCEPT_QUESTIONS,
  BEHAVIOURAL_COMPETENCIES,
  BEHAVIOURAL_QUESTIONS,
  HR_SCENARIOS,
} from './data/conversational-banks.mts';

async function main() {
  const { db, client } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia',
  );

  /**
   * Position within a topic, derived from the order in the file rather than
   * carried as a field. The file IS the running order — a number written beside
   * each entry would only ever drift from it.
   */
  const seenInTopic = new Map<string, number>();
  const nextIdx = (key: string) => {
    const n = seenInTopic.get(key) ?? 0;
    seenInTopic.set(key, n + 1);
    return n;
  };

  /* ── concepts ────────────────────────────────────────────────────────────── */

  await db
    .insert(conceptTopics)
    .values(CONCEPT_TOPICS.map((t, i) => ({ ...t, orderIdx: i })))
    .onConflictDoUpdate({
      target: conceptTopics.id,
      set: {
        label: raw`excluded.label`,
        blurb: raw`excluded.blurb`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  await db
    .insert(conceptQuestions)
    .values(
      CONCEPT_QUESTIONS.map((q) => ({ ...q, orderIdx: nextIdx(`c:${q.topic}`) })),
    )
    .onConflictDoUpdate({
      target: conceptQuestions.id,
      set: {
        topic: raw`excluded.topic`,
        title: raw`excluded.title`,
        difficulty: raw`excluded.difficulty`,
        prompt: raw`excluded.prompt`,
        probes: raw`excluded.probes`,
        expectedPoints: raw`excluded.expected_points`,
        commonMistakes: raw`excluded.common_mistakes`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  /* ── behavioural ─────────────────────────────────────────────────────────── */

  await db
    .insert(behaviouralCompetencies)
    .values(BEHAVIOURAL_COMPETENCIES.map((c, i) => ({ ...c, orderIdx: i })))
    .onConflictDoUpdate({
      target: behaviouralCompetencies.id,
      set: {
        label: raw`excluded.label`,
        blurb: raw`excluded.blurb`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  await db
    .insert(behaviouralQuestions)
    .values(
      BEHAVIOURAL_QUESTIONS.map((q) => ({ ...q, orderIdx: nextIdx(`b:${q.competency}`) })),
    )
    .onConflictDoUpdate({
      target: behaviouralQuestions.id,
      set: {
        competency: raw`excluded.competency`,
        title: raw`excluded.title`,
        prompt: raw`excluded.prompt`,
        probes: raw`excluded.probes`,
        strongAnswer: raw`excluded.strong_answer`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  /* ── HR ──────────────────────────────────────────────────────────────────── */

  await db
    .insert(hrScenarios)
    .values(HR_SCENARIOS.map((s, i) => ({ ...s, orderIdx: i })))
    .onConflictDoUpdate({
      target: hrScenarios.id,
      set: {
        title: raw`excluded.title`,
        blurb: raw`excluded.blurb`,
        stage: raw`excluded.stage`,
        persona: raw`excluded.persona`,
        beats: raw`excluded.beats`,
        rubricNotes: raw`excluded.rubric_notes`,
        orderIdx: raw`excluded.order_idx`,
      },
    });

  /* ── prune anything the file no longer carries ───────────────────────────── */

  // Children first: a topic row cannot go while its questions still point at it.
  const pruned = {
    conceptQuestions: await db
      .delete(conceptQuestions)
      .where(notInArray(conceptQuestions.id, CONCEPT_QUESTIONS.map((q) => q.id)))
      .returning({ id: conceptQuestions.id }),
    conceptTopics: await db
      .delete(conceptTopics)
      .where(notInArray(conceptTopics.id, CONCEPT_TOPICS.map((t) => t.id)))
      .returning({ id: conceptTopics.id }),
    behaviouralQuestions: await db
      .delete(behaviouralQuestions)
      .where(notInArray(behaviouralQuestions.id, BEHAVIOURAL_QUESTIONS.map((q) => q.id)))
      .returning({ id: behaviouralQuestions.id }),
    behaviouralCompetencies: await db
      .delete(behaviouralCompetencies)
      .where(
        notInArray(behaviouralCompetencies.id, BEHAVIOURAL_COMPETENCIES.map((c) => c.id)),
      )
      .returning({ id: behaviouralCompetencies.id }),
    hrScenarios: await db
      .delete(hrScenarios)
      .where(notInArray(hrScenarios.id, HR_SCENARIOS.map((s) => s.id)))
      .returning({ id: hrScenarios.id }),
  };

  console.log(
    `seeded ${CONCEPT_QUESTIONS.length} concept questions across ${CONCEPT_TOPICS.length} topics, ` +
      `${BEHAVIOURAL_QUESTIONS.length} behavioural questions across ` +
      `${BEHAVIOURAL_COMPETENCIES.length} competencies, ` +
      `${HR_SCENARIOS.length} HR scenarios`,
  );

  const removed = Object.entries(pruned).filter(([, rows]) => rows.length);
  for (const [table, rows] of removed) {
    console.log(`pruned ${rows.length} stale row(s) from ${table}: ${rows.map((r) => r.id).join(', ')}`);
  }

  await client.end();
}

void main();
