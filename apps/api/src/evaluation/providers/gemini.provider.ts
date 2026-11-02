import { Logger } from '@nestjs/common';
import type { GoogleGenAI } from '@google/genai';
import { MODELS, evaluationReportSchema } from '@orvia/shared';
import { evaluationSchema } from '../evaluation.schema';
import { walkChain, chainError, type ChainAvailability, type WalkOptions } from '../model-chain';
import { AudioRejectedError, type AudioPayload, type EvaluatorProvider, type EvaluatorResult } from './types';

/**
 * Pulls the three scores into range before the contract parses them. The
 * bounds are also in the response schema, but one out-of-range number would
 * otherwise throw away the whole report.
 */
export function clampReportScores(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const clamp = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : v;
  const r = raw as { overallScore?: unknown; questions?: unknown; delivery?: unknown };
  const each = (xs: unknown, lo: number, hi: number) =>
    Array.isArray(xs)
      ? xs.map((x) => (x && typeof x === 'object' ? { ...x, score: clamp((x as { score?: unknown }).score, lo, hi) } : x))
      : xs;
  return {
    ...r,
    overallScore: clamp(r.overallScore, 0, 100),
    questions: each(r.questions, 0, 10),
    delivery: each(r.delivery, 1, 5),
  };
}

export class GeminiEvaluatorProvider implements EvaluatorProvider {
  private readonly log = new Logger(GeminiEvaluatorProvider.name);
  readonly name = 'gemini';
  readonly supportsAudio = true;

  constructor(
    private readonly ai: Pick<GoogleGenAI, 'models'>,
    private readonly availability: ChainAvailability,
    private readonly walkOptions: WalkOptions = {},
  ) {}

  async evaluate(
    prompt: string,
    audio: AudioPayload | null,
    assignedIds: string[] = [],
    focusKeys: string[] = [],
  ): Promise<EvaluatorResult> {
    const parts: unknown[] = [{ text: prompt }];
    if (audio) parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.data } });
    const responseSchema = evaluationSchema(assignedIds, focusKeys);

    const walk = await walkChain(
      MODELS.evaluatorChain,
      this.availability,
      async (model, abortSignal) => {
        const res = await this.ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: parts as never }],
          config: { responseMimeType: 'application/json', responseSchema, temperature: 0.3, abortSignal },
        });
        return evaluationReportSchema.parse(clampReportScores(JSON.parse(res.text ?? '')));
      },
      this.walkOptions,
    );

    if (walk.ok) {
      return { report: walk.value, provider: this.name, model: walk.model, audioAnalysed: !!audio };
    }
    for (const f of walk.failures) {
      this.log.warn(`evaluator ${f.model}: ${f.kind} — ${f.message.slice(0, 160)}`);
    }
    if (audio && walk.failures.some((f) => f.kind === 'invalid_request')) {
      throw new AudioRejectedError(chainError(walk.failures, 'the request was rejected with the recording attached').message);
    }
    throw chainError(walk.failures, 'every Gemini evaluator model failed');
  }
}
