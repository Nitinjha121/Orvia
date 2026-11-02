import { Injectable, Inject, Logger } from '@nestjs/common';
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { MODELS } from '@orvia/shared';
import { ENV, type Env } from '../config/env';
import { ModelAvailabilityService } from '../gemini/model-availability.service';
import { walkChain } from './model-chain';

/**
 * Evaluates candidate code correctness via step-by-step tracing against small inputs.
 * Acts as a focused preliminary check whose concrete findings are provided to
 * the rubric as verified facts rather than relying on high-level prompt evaluation.
 */

const VERDICTS = ['correct', 'incorrect', 'incomplete', 'empty'] as const;

/** The model's reply, validated before anything reads it. */
export const codeCheckReplySchema = z.object({
  trace: z.string(),
  verdict: z.enum(VERDICTS),
  /** A concrete input it gets wrong, in the problem's own terms. Null if correct. */
  failingInput: z.string().nullable(),
  /** What the problem requires for that input. */
  expected: z.string().nullable(),
  /** What this code returns instead. */
  actual: z.string().nullable(),
  /** One sentence naming the line or condition responsible. */
  whatBreaks: z.string().nullable(),
  /** Every OTHER independent defect, one sentence each — see SCHEMA. */
  otherFaults: z.array(z.string()).default([]),
});

export type CodeCheck = Omit<z.infer<typeof codeCheckReplySchema>, 'trace'> & {
  questionId: string;
  title: string;
};

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    /**
     * Required first so the model executes a step-by-step trace before choosing a verdict,
     * stabilizing judgements across runs.
     */
    trace: {
      type: Type.STRING,
      description:
        'Before deciding anything: pick the smallest input that could expose a ' +
        'bug and evaluate the code on it BY HAND, step by step, naming each ' +
        'branch taken and the value of each variable as it changes, until the ' +
        'function returns. Write that walkthrough here, then compare the value ' +
        'it actually reached against what the problem requires. Do not describe ' +
        'what the code is trying to do — evaluate what it does.',
    },
    verdict: {
      type: Type.STRING,
      enum: [...VERDICTS],
      description:
        'correct = returns the right answer for every input the problem allows. ' +
        'incorrect = complete enough to run but returns a wrong answer, or loops ' +
        'forever, for at least one allowed input. incomplete = stops part way, ' +
        'or calls something that was never written. empty = nothing of substance.',
    },
    failingInput: {
      type: Type.STRING,
      nullable: true,
      description:
        'The SMALLEST concrete input this code gets wrong, written in the ' +
        "problem's own terms, e.g. \"m = 2, n = 3\" or \"s = 'ababcc'\". Null " +
        'ONLY when the verdict is correct.',
    },
    expected: {
      type: Type.STRING,
      nullable: true,
      description: 'What the problem requires for that input. Null only when correct.',
    },
    actual: {
      type: Type.STRING,
      nullable: true,
      description:
        'What THIS code returns for that input, from tracing it. Null only when correct.',
    },
    whatBreaks: {
      type: Type.STRING,
      nullable: true,
      description:
        'One sentence naming the specific line, condition or omission ' +
        'responsible. Null only when correct.',
    },
    /**
     * Additional defects identified beyond the primary failing input.
     */
    otherFaults: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Every OTHER independent defect, one sentence each naming its line or ' +
        'condition: imagine the fault in whatBreaks fixed and keep tracing — ' +
        'anything that would STILL make the code wrong goes here. Empty when ' +
        'there is none, and always empty when the verdict is correct.',
    },
  },
  required: ['trace', 'verdict', 'failingInput', 'expected', 'actual', 'whatBreaks', 'otherFaults'],
} as const;

/**
 * Passes down the whole model chain before giving up.
 *
 * Three, not one: a single pass is what left 4 of 42 buffers unchecked when the
 * audit ran them six at a time, and all four succeeded on a later sequential
 * run. Not more than three, because the only failure a retry can fix is a
 * per-minute burst, and by the third pass roughly a minute has gone by.
 */
const CHAIN_ATTEMPTS = 3;

/** Grows per attempt — 20s, then 40s, which spans a per-minute window. */
const RETRY_BACKOFF_MS = 20_000;

/**
 * Sampling temperature for the confirming pass.
 *
 * Low, because this is still arithmetic — but not zero, or the second pass
 * would be the same greedy decode as the first and could only agree with it.
 * Confirmation is worth nothing unless the second read can actually differ.
 */
const CONFIRM_TEMPERATURE = 0.4;

/**
 * Prompt focused on code correctness rather than interview delivery.
 * Style, minor naming issues, and missing imports are ignored to focus strictly
 * on logic, edge cases, and algorithmic soundness.
 */
export function buildCodeCheckPrompt(
  problem: { title: string; prompt: string },
  code: string,
  language: string | null,
): string {
  return (
    `You are checking whether a piece of code solves a problem. Nothing else — ` +
    `you are not grading anybody and not writing feedback.\n\n` +
    `## The problem\n\n${problem.title}\n\n${problem.prompt}\n\n` +
    `## The code${language ? ` (${language})` : ''}\n\n${code}\n\n` +
    `## What to do\n\n` +
    `Trace this code by hand on the SMALLEST input that could expose a bug, then ` +
    `on one ordinary input. Actually follow the control flow line by line and ` +
    `keep track of the values — do not judge it by whether the approach sounds ` +
    `right, and do not assume a variable is used just because it was created.\n\n` +
    `Check specifically:\n` +
    `- every early return and base case: does it fire on the right condition, and ` +
    `  does it return the right value when it does?\n` +
    `- anything written but never read back — a cache or table that is assigned ` +
    `  and never consulted means there is no memoisation, whatever it is named;\n` +
    `- loop and recursion bounds, including the last row, the last column and the ` +
    `  last element;\n` +
    `- whether it terminates.\n\n` +
    `This was written in an interview editor with NO compiler and no way to run ` +
    `anything, so ignore FOUR things and nothing else: a missing semicolon or ` +
    `colon, an unclosed bracket, a missing import, and a variable misspelt from ` +
    `one declared beside it. Those are typing, not thinking, and "it would not ` +
    `compile" on their account is not a verdict of "incorrect".\n\n` +
    `That allowance covers PUNCTUATION ONLY. Everything the code says about ` +
    `control flow you must take exactly as written, and you must not repair it, ` +
    `complete it or infer intent:\n` +
    `- a condition is the condition on the page, even if a neighbouring one ` +
    `  would be more sensible;\n` +
    `- a table or cache that is assigned and never read back is NOT memoisation, ` +
    `  no matter what it is called or what the surrounding code implies was ` +
    `  meant — a missing lookup is a missing lookup;\n` +
    `- a branch that returns the wrong value returns the wrong value;\n` +
    `- a bound that stops one short stops one short.\n\n` +
    `The candidate is credited for what they wrote, not for what they probably ` +
    `intended. Charitably reconstructing the algorithm they meant is the single ` +
    `most damaging thing you can do here: it hands back exactly the verdict this ` +
    `check exists to prevent.\n\n` +
    `If the algorithm really is wrong, give the smallest concrete input that ` +
    `shows it.\n\n` +
    `**Find EVERY fault, not just the first.** Once you have one, assume it ` +
    `fixed and trace again. A variable read before it is ever assigned is one ` +
    `fault; a collection built each iteration and never written back is ` +
    `another, and fixing the first does not fix the second. List each further ` +
    `independent fault in otherFaults.\n\n` +
    `**Then check your own example before you answer.** Run that exact input ` +
    `through the code once more and confirm the answer you claim it gives really ` +
    `differs from the answer the problem requires. An example where the two ` +
    `agree proves nothing and is worse than none — it is the first thing anybody ` +
    `reading your finding will check. If your example turns out to agree, either ` +
    `find one that genuinely differs or say the code is correct.`
  );
}

/** Exported for `verify:metrics`, which pins the fields the rubric depends on. */
export const CODE_CHECK_SCHEMA = SCHEMA;

@Injectable()
export class CodeCheckService {
  private readonly log = new Logger(CodeCheckService.name);
  private readonly ai: GoogleGenAI;

  constructor(
    @Inject(ENV) env: Env,
    private readonly availability: ModelAvailabilityService,
  ) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  /** Overridden by `verify:guards` so the backoff does not cost a minute. */
  private wait(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  /**
   * One check per problem that has code, in parallel. A failed check is
   * swallowed — losing a finding costs the rubric a fact, a throw would cost
   * the candidate the report — but logged at ERROR, because a problem with no
   * finding is judged on what the candidate SAID, which is the bug this file
   * exists to fix.
   */
  async check(
    problems: { id: string; title: string; prompt: string }[],
    code: Record<string, { code?: string; language?: string | null } | undefined>,
  ): Promise<CodeCheck[]> {
    const wanted = problems.filter((p) => (code[p.id]?.code ?? '').trim().length > 0);
    if (!wanted.length) return [];

    const results = await Promise.all(
      wanted.map((p) =>
        this.one(p, code[p.id]!.code!.trim(), code[p.id]?.language ?? null).catch((e) => {
          this.log.error(
            `code check threw for ${p.id}: ${(e as Error).message} — that problem will be ` +
              `judged on what the candidate SAID, which is the bug this check exists to fix`,
          );
          return null;
        }),
      ),
    );
    return results.filter((r): r is CodeCheck => r !== null);
  }

  private async one(
    problem: { id: string; title: string; prompt: string },
    code: string,
    language: string | null,
  ): Promise<CodeCheck | null> {
    const prompt = buildCodeCheckPrompt(problem, code, language);

    /**
     * A defect must be confirmed across two passes before it is reported.
     * Biased in the candidate's favor: false defects undermine credibility,
     * so two independent passes must agree an issue exists before marking code incorrect.
     */
    const first = await this.chainWithRetry(problem, prompt, 0);
    if (!first || first.verdict === 'correct' || first.verdict === 'empty') return first;

    /**
     * The second pass samples at a small NONZERO temperature so it is a
     * genuinely independent read rather than a replay of the first. Two
     * identical greedy decodes would agree by construction and confirm
     * nothing — the point is to find out whether the defect survives a
     * different path through the same reasoning.
     */
    const second = await this.chainWithRetry(problem, prompt, CONFIRM_TEMPERATURE);
    if (!second) {
      // Nothing to corroborate with. Reporting an unconfirmed defect is the
      // expensive error, so it is dropped and the round keeps its benefit.
      this.log.warn(
        `${problem.id}: "${first.verdict}" could not be confirmed by a second pass — ` +
          `not reporting it`,
      );
      return null;
    }
    if (second.verdict === 'correct' || second.verdict === 'empty') {
      this.log.warn(
        `${problem.id}: first pass said ${first.verdict}, second said ${second.verdict} — ` +
          `treating it as correct, because a false defect costs the candidate a solved`,
      );
      return {
        ...second,
        verdict: 'correct',
        failingInput: null,
        expected: null,
        actual: null,
        whatBreaks: null,
        otherFaults: [],
      };
    }

    /**
     * Both agree something is wrong. The SECOND pass's detail is returned
     * rather than a merge: the two often name the same defect with different
     * arithmetic, and one coherent account beats a stitched-together one.
     */
    this.log.log(
      `${problem.id}: ${first.verdict}/${second.verdict} on two passes — reporting it`,
    );
    return second;
  }

  /**
   * Evaluates the chain with retries if models are not exhausted for the day.
   * Checks `exhaustedForDay` rather than `isAvailable` because short per-minute
   * cooldowns clear quickly, whereas daily quota limits do not.
   */
  private async chainWithRetry(
    problem: { id: string; title: string; prompt: string },
    prompt: string,
    temperature: number,
  ): Promise<CodeCheck | null> {
    for (let attempt = 1; attempt <= CHAIN_ATTEMPTS; attempt++) {
      const out = await this.attemptChain(problem, prompt, temperature);
      if (out) return out;
      if (attempt === CHAIN_ATTEMPTS) break;

      if (MODELS.extractorChain.every((m) => this.availability.exhaustedForDay(m))) {
        this.log.warn(`every model is out of daily quota — not retrying the check for ${problem.id}`);
        break;
      }
      const waitMs = RETRY_BACKOFF_MS * attempt;
      this.log.warn(
        `the whole chain failed for ${problem.id} (attempt ${attempt}/${CHAIN_ATTEMPTS}) — ` +
          `retrying in ${waitMs / 1000}s`,
      );
      await this.wait(waitMs);
    }

    this.log.error(
      `no model could check the code for ${problem.id} — it will be judged on what the ` +
        `candidate SAID about it`,
    );
    return null;
  }

  /** One pass down the chain. Null when every model in it failed. */
  private async attemptChain(
    problem: { id: string; title: string; prompt: string },
    prompt: string,
    temperature: number,
  ): Promise<CodeCheck | null> {
    const walk = await walkChain(MODELS.extractorChain, this.availability, async (model, abortSignal) => {
      const res = await this.ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: SCHEMA as object,
          temperature,
          abortSignal,
        },
      });
      return codeCheckReplySchema.parse(JSON.parse(res.text ?? ''));
    });
    if (!walk.ok) {
      for (const f of walk.failures) {
        this.log.warn(`code check ${problem.id} on ${f.model}: ${f.kind} — ${f.message.slice(0, 160)}`);
      }
      return null;
    }

    /**
     * `trace` is dropped: it exists to make the model do the arithmetic before
     * committing (see SCHEMA), and handing it on would put a second, longer,
     * unverified account of the code in front of an evaluator that already
     * struggles to prefer the code over the words.
     */
    const { trace: _trace, ...parsed } = walk.value;
    const out: CodeCheck = { questionId: problem.id, title: problem.title, ...parsed };
    this.log.log(
      `code check ${problem.id}: ${out.verdict}` +
        (out.verdict === 'correct' ? '' : ` — ${out.failingInput} gives ${out.actual}, ` +
          `expected ${out.expected}`) +
        ` (via ${walk.model})`,
    );
    return out;
  }
}
