import { Injectable, Inject } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import {
  dsaQuestions,
  questionCollections,
  collections as collectionsTable,
  systemDesignProblems,
  conceptTopics,
  conceptQuestions,
  behaviouralCompetencies,
  behaviouralQuestions,
  hrScenarios,
  type Database,
} from '@orvia/db';
import { DEFAULT_COLLECTION } from '@orvia/shared';
import { DB } from '../db/db.module';

/**
 * Read-only catalogue queries for the question banks.
 * Redacts evaluation criteria (reference solutions, rubrics, probe questions, and beats)
 * while returning starter skeletons and prompts for practice.
 */
@Injectable()
export class QuestionBankService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Read from the DB, so adding a category never needs a UI change. */
  collections() {
    return this.db
      .select({
        id: collectionsTable.id,
        label: collectionsTable.label,
        blurb: collectionsTable.blurb,
        count: sql<number>`count(${questionCollections.questionId})::int`,
      })
      .from(collectionsTable)
      .leftJoin(questionCollections, eq(questionCollections.collection, collectionsTable.id))
      .groupBy(
        collectionsTable.id,
        collectionsTable.label,
        collectionsTable.blurb,
        collectionsTable.orderIdx,
      )
      .orderBy(asc(collectionsTable.orderIdx));
  }

  /** The bank for one curated list, in that list's own order. */
  listDsa(collection?: string) {
    return this.db
      .select({
        id: dsaQuestions.id,
        title: dsaQuestions.title,
        difficulty: dsaQuestions.difficulty,
        topics: dsaQuestions.topics,
        prompt: dsaQuestions.prompt,
        codeSnippets: dsaQuestions.codeSnippets,
        // Travels WITH the snippets, never separately. For a paid-only problem
        // the skeleton is LintCode's and only compiles against LintCode's
        // judge, so the editor has to be able to say where that is.
        practiceUrl: dsaQuestions.practiceUrl,
        leetcodeId: dsaQuestions.leetcodeId,
        url: dsaQuestions.url,
        orderIdx: questionCollections.orderIdx,
      })
      .from(questionCollections)
      .innerJoin(dsaQuestions, eq(dsaQuestions.id, questionCollections.questionId))
      .where(eq(questionCollections.collection, collection ?? DEFAULT_COLLECTION))
      .orderBy(asc(questionCollections.orderIdx));
  }

  /**
   * The topics a concepts round can be drawn from, with a question count so the
   * rail can say how big each one is. Same shape as `collections` because the
   * setup screen treats them the same way — lists are the rail.
   */
  conceptTopics() {
    return this.db
      .select({
        id: conceptTopics.id,
        label: conceptTopics.label,
        blurb: conceptTopics.blurb,
        count: sql<number>`count(${conceptQuestions.id})::int`,
      })
      .from(conceptTopics)
      .leftJoin(conceptQuestions, eq(conceptQuestions.topic, conceptTopics.id))
      .groupBy(conceptTopics.id, conceptTopics.label, conceptTopics.blurb, conceptTopics.orderIdx)
      .orderBy(asc(conceptTopics.orderIdx));
  }

  /** One topic's questions, in the bank's own order. */
  listConcepts(topic?: string) {
    const base = this.db
      .select({
        id: conceptQuestions.id,
        topic: conceptQuestions.topic,
        title: conceptQuestions.title,
        difficulty: conceptQuestions.difficulty,
        prompt: conceptQuestions.prompt,
        orderIdx: conceptQuestions.orderIdx,
      })
      .from(conceptQuestions);

    return topic
      ? base.where(eq(conceptQuestions.topic, topic)).orderBy(asc(conceptQuestions.orderIdx))
      : base.orderBy(asc(conceptQuestions.topic), asc(conceptQuestions.orderIdx));
  }

  /** Competencies for the behavioural rail, with counts. */
  competencies() {
    return this.db
      .select({
        id: behaviouralCompetencies.id,
        label: behaviouralCompetencies.label,
        blurb: behaviouralCompetencies.blurb,
        count: sql<number>`count(${behaviouralQuestions.id})::int`,
      })
      .from(behaviouralCompetencies)
      .leftJoin(
        behaviouralQuestions,
        eq(behaviouralQuestions.competency, behaviouralCompetencies.id),
      )
      .groupBy(
        behaviouralCompetencies.id,
        behaviouralCompetencies.label,
        behaviouralCompetencies.blurb,
        behaviouralCompetencies.orderIdx,
      )
      .orderBy(asc(behaviouralCompetencies.orderIdx));
  }

  listBehavioural(competency?: string) {
    const base = this.db
      .select({
        id: behaviouralQuestions.id,
        competency: behaviouralQuestions.competency,
        title: behaviouralQuestions.title,
        prompt: behaviouralQuestions.prompt,
        orderIdx: behaviouralQuestions.orderIdx,
      })
      .from(behaviouralQuestions);

    return competency
      ? base
          .where(eq(behaviouralQuestions.competency, competency))
          .orderBy(asc(behaviouralQuestions.orderIdx))
      : base.orderBy(asc(behaviouralQuestions.competency), asc(behaviouralQuestions.orderIdx));
  }

  listHrScenarios() {
    return this.db
      .select({
        id: hrScenarios.id,
        title: hrScenarios.title,
        blurb: hrScenarios.blurb,
        stage: hrScenarios.stage,
      })
      .from(hrScenarios)
      .orderBy(asc(hrScenarios.orderIdx));
  }

  listSystemDesign() {
    return this.db
      .select({
        id: systemDesignProblems.id,
        title: systemDesignProblems.title,
        level: systemDesignProblems.level,
        prompt: systemDesignProblems.prompt,
      })
      .from(systemDesignProblems)
      .orderBy(asc(systemDesignProblems.orderIdx));
  }
}
