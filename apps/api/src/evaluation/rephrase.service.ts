import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { and, asc, eq } from 'drizzle-orm';
import { sessions, turns, turnRewrites, type Database } from '@orvia/db';
import { MODELS, type InterviewMode, type RephraseItem, type RephraseView } from '@orvia/shared';
import { DB } from '../db/db.module';
import { ENV, type Env } from '../config/env';
import { ModelAvailabilityService } from '../gemini/model-availability.service';
import { walkChain, chainError } from './model-chain';
import {
  REPHRASE_BUDGET_MS, REPHRASE_STALE_MS,
  buildRephrasePrompt, mergeRephrase, paragraphsOf, rephraseReplySchema, rephraseResponseSchema,
  type Paragraph,
} from './rephrase';

/** "Say it better" — see `rephrase.ts`. Generated on request, cached per round. */
@Injectable()
export class RephraseService {
  private readonly log = new Logger(RephraseService.name);
  private readonly ai: GoogleGenAI;
  private readonly running = new Set<string>();

  constructor(
    @Inject(ENV) env: Env,
    @Inject(DB) private readonly db: Database,
    private readonly availability: ModelAvailabilityService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  private async owned(userId: string, sessionId: string) {
    const [s] = await this.db
      .select({ id: sessions.id, mode: sessions.mode })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    if (!s) throw new NotFoundException(`no session ${sessionId}`);
    return s;
  }

  async get(userId: string, sessionId: string): Promise<RephraseView> {
    await this.owned(userId, sessionId);
    const [row] = await this.db.select().from(turnRewrites).where(eq(turnRewrites.sessionId, sessionId));
    if (!row) return { status: 'none', items: [], model: null, error: null, createdAt: null };

    const stale = row.status === 'writing' && Date.now() - row.createdAt.getTime() > REPHRASE_STALE_MS;
    return {
      status: stale ? 'failed' : (row.status as RephraseView['status']),
      items: row.items as RephraseItem[],
      model: row.model,
      error: stale ? 'the rewrite stopped part-way — try again' : row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Answers once the `writing` row exists, so the next poll reads it. */
  async start(userId: string, sessionId: string): Promise<RephraseView> {
    const session = await this.owned(userId, sessionId);
    if (this.running.has(sessionId)) return this.get(userId, sessionId);

    const rows = await this.db
      .select({ speaker: turns.speaker, text: turns.text })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.idx));
    const paragraphs = paragraphsOf(rows);

    const fresh = { createdAt: new Date(), model: null, error: null, completedAt: null };
    if (!paragraphs.length) {
      await this.db
        .insert(turnRewrites)
        .values({ sessionId, status: 'complete', items: [], ...fresh, completedAt: new Date() })
        .onConflictDoUpdate({
          target: turnRewrites.sessionId,
          set: { status: 'complete', items: [], ...fresh, completedAt: new Date() },
        });
      return this.get(userId, sessionId);
    }

    await this.db
      .insert(turnRewrites)
      .values({ sessionId, status: 'writing', items: [], ...fresh })
      .onConflictDoUpdate({ target: turnRewrites.sessionId, set: { status: 'writing', items: [], ...fresh } });

    this.running.add(sessionId);
    void this.write(sessionId, session.mode, paragraphs).finally(() => this.running.delete(sessionId));
    return this.get(userId, sessionId);
  }

  private async write(sessionId: string, mode: InterviewMode, paragraphs: Paragraph[]) {
    try {
      const prompt = buildRephrasePrompt(mode, paragraphs);
      const schema = rephraseResponseSchema(paragraphs.map((p) => p.idx));
      const walk = await walkChain(
        MODELS.extractorChain,
        this.availability,
        async (model, abortSignal) => {
          const res = await this.ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, abortSignal },
          });
          return rephraseReplySchema.parse(JSON.parse(res.text ?? ''));
        },
        { callTimeoutMs: 150_000, budgetMs: REPHRASE_BUDGET_MS },
      );
      if (!walk.ok) throw chainError(walk.failures, 'no model could write the rewrites');

      const items = mergeRephrase(paragraphs, walk.value);
      await this.db
        .update(turnRewrites)
        .set({ status: 'complete', items, model: walk.model, completedAt: new Date() })
        .where(eq(turnRewrites.sessionId, sessionId));
      this.log.log(
        `rephrase ${sessionId}: ${items.filter((i) => i.better).length}/${items.length} paragraphs rewritten via ${walk.model}`,
      );
    } catch (e) {
      const message = (e as Error).message;
      this.log.error(`rephrase ${sessionId} failed: ${message}`);
      await this.db
        .update(turnRewrites)
        .set({ status: 'failed', error: message.slice(0, 500) })
        .where(eq(turnRewrites.sessionId, sessionId));
    }
  }
}
