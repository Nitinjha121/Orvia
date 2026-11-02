import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '@orvia/shared';
import { ENV, type Env } from '../config/env';
import { ModelAvailabilityService } from '../gemini/model-availability.service';
import { walkChain } from '../evaluation/model-chain';

/**
 * Listens to microphone recordings using a background model chain and summarizes
 * acoustic delivery into text for coach and mentor sessions, avoiding token
 * bloat in the live session context.
 */
@Injectable()
export class ListeningService {
  private readonly log = new Logger(ListeningService.name);
  private readonly ai: Pick<GoogleGenAI, 'models'>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly availability: ModelAvailabilityService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  /**
   * What a listener heard in the recording, or null when no model could listen.
   * `covers` names the stretch when it is only part of the round, so the notes
   * say so rather than passing a part off as the whole.
   */
  async listen(
    audio: { mimeType: string; data: string },
    o: { round: string; covers?: string; focus?: string },
  ): Promise<string | null> {
    const prompt =
      `This is a candidate's own microphone recording from a practice interview (${o.round}` +
      `${o.covers ? `, ${o.covers}` : ''}). Only their voice is on it; the interviewer cannot be heard.\n\n` +
      'Describe how they SOUNDED, for a coach who will talk to them about it: pace and how it ' +
      'changed, pauses and hesitation, filler words and which ones, false starts, how confident ' +
      'or tentative they sounded and where that shifted, clarity, and energy. Quote a few of ' +
      'their own short phrases where they show a point. Do not judge whether the content was ' +
      'correct, and do not give timestamps or minute marks — say what they were talking about ' +
      'instead. If some of it is silent or unintelligible, say so rather than guessing.' +
      (o.focus ? `\n\nThey particularly want to know about: ${o.focus}.` : '') +
      '\n\nPlain prose, no markdown, at most 250 words.';

    const walk = await walkChain(
      MODELS.listenerChain,
      this.availability,
      async (model, abortSignal) => {
        const res = await this.ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: audio }] }],
          config: { temperature: 0.3, abortSignal },
        });
        const text = res.text?.trim();
        if (!text) throw new Error('the listener returned nothing');
        return text;
      },
      { callTimeoutMs: 120_000, budgetMs: 240_000 },
    );
    if (walk.ok) return walk.value;
    for (const f of walk.failures) this.log.warn(`listening ${f.model}: ${f.kind} — ${f.message.slice(0, 160)}`);
    return null;
  }
}
