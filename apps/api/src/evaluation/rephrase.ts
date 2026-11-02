import { Type } from '@google/genai';
import { z } from 'zod';
import { REPHRASE_MIN_WORDS, wordCount, type InterviewMode, type RephraseItem } from '@orvia/shared';

/**
 * Pure half of "Say it better" (`rephrase.service.ts` makes the call), so
 * `verify:rephrase` runs every rule here without a model or a database.
 *
 * The source is the live `turns`, not the verbatim pass: the verbatim text is
 * one undivided string, and splitting it back into answers would need turn
 * timestamps, which are not accurate enough to cut on.
 */

/** A `writing` row older than this died with its process. Above the walk budget below. */
export const REPHRASE_STALE_MS = 6 * 60_000;
export const REPHRASE_BUDGET_MS = 4 * 60_000;

const ASKED_MAX_CHARS = 280;
const SYSTEM_NOTE_LEAK = /\[SYSTEM NOTE/i;

export type Paragraph = { idx: number; asked: string | null; said: string };

type TurnLike = { speaker: 'user' | 'ai'; text: string };

/**
 * Consecutive candidate turns with no interviewer line between them are one
 * answer: the live transcript splits on pauses, and a thinking pause mid-answer
 * is not a new paragraph. Interviewer lines echoing a system note are dropped,
 * as the evaluator drops them.
 */
export function paragraphsOf(turns: readonly TurnLike[]): Paragraph[] {
  const out: Paragraph[] = [];
  let asked: string | null = null;
  let open: string[] | null = null;

  const close = () => {
    if (!open) return;
    const said = open.join(' ').replace(/\s+/g, ' ').trim();
    if (wordCount(said) >= REPHRASE_MIN_WORDS) out.push({ idx: out.length, asked, said });
    open = null;
  };

  for (const t of turns) {
    const text = t.text.trim();
    if (!text) continue;
    if (t.speaker === 'ai') {
      if (SYSTEM_NOTE_LEAK.test(text)) continue;
      close();
      asked = text.length > ASKED_MAX_CHARS ? `${text.slice(0, ASKED_MAX_CHARS).trimEnd()}…` : text;
    } else {
      (open ??= []).push(text);
    }
  }
  close();
  return out;
}

const MODE_HINT: Record<InterviewMode, string> = {
  dsa:
    'A coding round. While coding, a strong candidate narrates INTENT ("I will map each wildcard ' +
    'pattern to the words that match it"), not keystrokes ("now for i in range length word, now ' +
    'okay"). Approaches lead with the idea, then the cost.',
  system_design:
    'A system design round. Strong answers name the component and the reason in one breath, ' +
    'and signpost ("two parts: the write path, then the read path").',
  concepts: 'A spoken concepts round. Strong answers give the definition first, then one example.',
  jd: 'A round on the job description. Strong answers tie one concrete experience to the requirement.',
  experience: 'A round on past experience. Strong answers say what they did, how, and the result.',
  behavioural:
    'A behavioural round. Strong answers follow situation, task, action, result, with most of ' +
    'the words on the action and "I", not "we".',
  hr: 'An HR round. Strong answers are direct, positive and short.',
};

export function buildRephrasePrompt(mode: InterviewMode, paragraphs: readonly Paragraph[]): string {
  const body = paragraphs
    .map((p) => `[${p.idx}]\nInterviewer: ${p.asked ?? '(the candidate spoke first)'}\nCandidate: ${p.said}`)
    .join('\n\n');
  return (
    'You are a speaking coach for technical interviews. Below are things a candidate said, ' +
    'transcribed from speech. For each numbered paragraph, write what they SHOULD have said: the ' +
    'same content, said the way a clear, fluent engineer says it out loud.\n\n' +
    `${MODE_HINT[mode]}\n\n` +
    'Rules:\n' +
    '- Keep THEIR ideas, approach, numbers, examples and conclusions, and every question they ' +
    'asked the interviewer. Keep concrete details: the data structure, the specific trick, the ' +
    'final answer they gave. Never add a word of content they did not say (not even a qualifier ' +
    'like "shortest"), never change a conclusion, and never fix a technical mistake: correctness ' +
    'is judged elsewhere, and this is only about how it was said.\n' +
    '- Lead with the point. Cut fillers, restarts, repeated phrases, hedging and thinking out ' +
    'loud that reaches no point.\n' +
    '- If they restated the whole question, keep one sentence of it.\n' +
    '- Plain, simple spoken English in the first person, as they would say it in the room. Say ' +
    'maths the standard way ("N times L squared", "O of N log N", not "N into L square"). No ' +
    'fancy vocabulary, no bullet points, no markdown.\n' +
    '- As short as it can be without losing a detail. Clarity first; length follows.\n' +
    '- If a paragraph is already clear and concise, or is only an acknowledgement, set better to ' +
    'null.\n' +
    '- why: one short sentence naming the specific habit the rewrite removes, addressed to the ' +
    'candidate as "you", e.g. "You restated the whole problem before your question." Name only a ' +
    'habit visible in that paragraph. Null when better is null.\n\n' +
    'Return one item per paragraph, using its number as id.\n\n' +
    body
  );
}

export const rephraseReplySchema = z.object({
  items: z.array(
    z.object({
      id: z.coerce.number().int(),
      why: z.string().nullable(),
      better: z.string().nullable(),
    }),
  ),
});
export type RephraseReply = z.infer<typeof rephraseReplySchema>;

/** `ids` constrains `id` to the paragraphs actually sent; enums are strings, so it comes back as one. */
export function rephraseResponseSchema(ids: readonly number[]) {
  return {
    type: Type.OBJECT,
    properties: {
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, enum: ids.map(String) },
            // Before `better`, so the diagnosis is written first rather than justifying a rewrite.
            why: { type: Type.STRING, nullable: true },
            better: { type: Type.STRING, nullable: true },
          },
          required: ['id', 'why', 'better'],
        },
      },
    },
    required: ['items'],
  };
}

/**
 * Joins the reply onto the paragraphs. Every paragraph appears once, in order,
 * whatever the model returned: an unknown id is dropped, a repeated one keeps
 * its first answer, a missing one shows with no rewrite. A rewrite that is not
 * shorter is dropped too — the one property this feature promises.
 */
export function mergeRephrase(paragraphs: readonly Paragraph[], reply: RephraseReply): RephraseItem[] {
  const byId = new Map<number, RephraseReply['items'][number]>();
  for (const r of reply.items) if (!byId.has(r.id)) byId.set(r.id, r);

  return paragraphs.map((p) => {
    const saidWords = wordCount(p.said);
    const r = byId.get(p.idx);
    const better = r?.better?.replace(/\s+/g, ' ').trim() || null;
    const betterWords = better ? wordCount(better) : null;
    const kept = better !== null && betterWords !== null && betterWords < saidWords;
    return {
      idx: p.idx,
      asked: p.asked,
      said: p.said,
      better: kept ? better : null,
      why: kept ? (r?.why?.trim() || null) : null,
      saidWords,
      betterWords: kept ? betterWords : null,
    };
  });
}
