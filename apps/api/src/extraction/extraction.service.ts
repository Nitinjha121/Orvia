import { Injectable, Inject, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { MODELS } from '@orvia/shared';
import { ENV, type Env } from '../config/env';
import { ModelAvailabilityService } from '../gemini/model-availability.service';
import { walkChain } from '../evaluation/model-chain';
import {
  JD_BRIEF_SCHEMA, EXPERIENCE_BRIEF_SCHEMA, jdBriefSchema, experienceBriefSchema,
  type JdBrief, type ExperienceBrief,
} from './extraction.schema';

/**
 * Deadlines for the round-start critical path. Not measured: chosen so a slow
 * or hung model costs a round at most ~40s before it starts on the raw text,
 * where the unbounded walk could spend five models' worth of hangs.
 */
const CALL_TIMEOUT_MS = 20_000;
const WALK_BUDGET_MS = 40_000;

/**
 * Turns pasted text into something the interviewer can aim with: a JD round
 * learns which competencies the posting weights, an experience round which
 * claims have no number and no ownership attached.
 *
 * Cached by content hash, because extraction sits on the critical path of
 * starting a round.
 */
@Injectable()
export class ExtractionService {
  private readonly log = new Logger(ExtractionService.name);
  private readonly ai: GoogleGenAI;
  private readonly cache = new Map<string, unknown>();

  constructor(
    @Inject(ENV) env: Env,
    private readonly availability: ModelAvailabilityService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  async jobDescription(text: string): Promise<JdBrief | null> {
    return this.extract(
      'jd',
      text,
      JD_BRIEF_SCHEMA,
      jdBriefSchema,
      `Read this job posting and reduce it to what an interviewer needs in order to interview FOR THIS ROLE ` +
        `specifically, rather than asking generically sensible questions.\n\n` +
        `Weight the focus areas by what the posting actually emphasises — repetition, placement near the top, ` +
        `and anything stated as a requirement rather than a nice-to-have.\n\n---\n\n${text.slice(0, 12_000)}`,
    );
  }

  async experience(text: string): Promise<ExperienceBrief | null> {
    return this.extract(
      'exp',
      text,
      EXPERIENCE_BRIEF_SCHEMA,
      experienceBriefSchema,
      `Read this candidate's background and reduce it to things that can be PROBED.\n\n` +
        `Pay particular attention to claims that are collective rather than personal ("we built", "the team ` +
        `migrated") or unquantified ("improved performance", "at scale"). Those are the most valuable things ` +
        `for an interviewer to push on, so extract them precisely.\n\n---\n\n${text.slice(0, 16_000)}`,
    );
  }

  private async extract<T>(
    kind: string,
    source: string,
    responseSchema: object,
    contract: z.ZodType<T>,
    prompt: string,
  ): Promise<T | null> {
    const key = `${kind}:${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
    const hit = this.cache.get(key);
    if (hit) return hit as T;

    const walk = await walkChain(
      MODELS.extractorChain,
      this.availability,
      async (model, abortSignal) => {
        const res = await this.ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json', responseSchema, temperature: 0.2, abortSignal },
        });
        return contract.parse(JSON.parse(res.text ?? ''));
      },
      { callTimeoutMs: CALL_TIMEOUT_MS, budgetMs: WALK_BUDGET_MS },
    );

    if (walk.ok) {
      this.cache.set(key, walk.value);
      this.log.log(`extracted ${kind} brief via ${walk.model}`);
      return walk.value;
    }

    // Never fatal: a round on the raw text is worse than one with a brief, and
    // far better than one that refuses to start.
    this.log.warn(
      `could not extract a ${kind} brief — falling back to the raw text ` +
        `(${walk.failures.map((f) => `${f.model}: ${f.kind}`).join(', ')})`,
    );
    return null;
  }
}
