import { Type } from '@google/genai';
import { DELIVERY_DIMENSION_IDS, VERDICTS, QUESTION_OUTCOMES, FOCUS_RESULTS } from '@orvia/shared';

/**
 * Response schema for the evaluator, enforced by the API.
 * Every report field must stay synchronized between this schema and the shared
 * contract in `@orvia/shared` to avoid missing keys falling back to defaults.
 */
const BASE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overallScore: {
      type: Type.NUMBER, minimum: 0, maximum: 100,
      description: '0-100, content and delivery weighted together',
    },
    overallVerdict: { type: Type.STRING, enum: [...VERDICTS] },
    summary: { type: Type.STRING, description: '3-5 sentences addressed to the candidate as "you". Lead with the most important point.' },
    topFixes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Exactly 3 ranked instructions, not observations, each about something the candidate can change. Never about how they reacted to the interviewer going silent, repeating itself, moving on early or ending early.',
    },
    questions: {
      type: Type.ARRAY,
      description: 'One entry per substantive question, with its follow-ups merged in.',
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          myAnswer: { type: Type.STRING, description: 'What the candidate actually said, faithfully summarised.' },
          idealAnswer: { type: Type.STRING, description: 'What a strong answer would contain. Specific enough to study from.' },
          whatWasGood: { type: Type.ARRAY, items: { type: Type.STRING } },
          whatWasMissing: { type: Type.ARRAY, items: { type: Type.STRING } },
          howToImprove: { type: Type.STRING, description: 'One concrete rewrite instruction.' },
          modelSolution: {
            type: Type.STRING,
            nullable: true,
            description:
              'CODING ROUNDS ONLY: a complete, correct, idiomatic implementation in the language the candidate was using. Plain code, no markdown fences, no commentary. Format it as real source: literal newlines between statements and real indentation, exactly as it would appear in a file. NEVER collapse it onto one line or join statements with semicolons — that is not runnable code and it renders as an unreadable single line. Null for non-coding questions.',
          },
          modelSolutionLanguage: { type: Type.STRING, nullable: true },
          complexity: {
            type: Type.ARRAY,
            description:
              'CODING ROUNDS ONLY: one entry per axis (time, space, output). Empty array for non-coding questions.',
            items: {
              type: Type.OBJECT,
              properties: {
                axis: { type: Type.STRING, enum: ['time', 'space', 'output'] },
                stated: {
                  type: Type.STRING,
                  nullable: true,
                  description:
                    'The complexity the CANDIDATE claimed, in big-O. Their final claim if they revised it. NULL if they never stated it — never infer this from their code, and never fill it in from the correct answer. A fabricated claim is worse than a blank.',
                },
                statedQuote: {
                  type: Type.STRING,
                  nullable: true,
                  description: 'Their exact words making that claim. Null whenever stated is null.',
                },
                actual: {
                  type: Type.STRING,
                  description:
                    'The true cost of THE CODE THE CANDIDATE WROTE, even if that code is suboptimal.',
                },
                optimal: { type: Type.STRING, description: 'The cost of the modelSolution.' },
                correct: {
                  type: Type.BOOLEAN,
                  nullable: true,
                  description:
                    'Does stated match actual? Judge the claim against THEIR OWN code, never against optimal. Null when nothing was stated.',
                },
              },
              // Nullable fields are required so the model must emit an explicit
              // null: a missing claim and an unmade claim must be distinguishable.
              required: ['axis', 'stated', 'statedQuote', 'actual', 'optimal', 'correct'],
            },
          },
          score: { type: Type.NUMBER, minimum: 0, maximum: 10, description: '0-10' },
          verdict: { type: Type.STRING, enum: [...VERDICTS] },
          // No `startMs` and no `complexity[].statedAtMs`: the model reads
          // transcripts stamped [MM:SS] and timestamps can be misparsed.
          // Both are measured in `EvaluationService.persist` instead.
        },
        required: ['question', 'myAnswer', 'idealAnswer', 'whatWasGood', 'whatWasMissing', 'howToImprove', 'score', 'verdict'],
      },
    },
    delivery: {
      type: Type.ARRAY,
      description: 'Every dimension, scored 1-5 against its anchors. Higher is always better.',
      items: {
        type: Type.OBJECT,
        properties: {
          dimension: { type: Type.STRING, enum: [...DELIVERY_DIMENSION_IDS] },
          score: { type: Type.NUMBER, minimum: 1, maximum: 5, description: '1-5' },
          assessment: { type: Type.STRING, description: '1-2 sentences, addressed to the candidate.' },
          evidenceQuote: {
            type: Type.STRING,
            description:
              'A verbatim fragment of what the CANDIDATE said that supports this score. Quote them, not the interviewer. Use null ONLY if this dimension genuinely never arose in the round.',
            nullable: true,
          },
          evidenceAtMs: { type: Type.NUMBER, nullable: true },
        },
        required: ['dimension', 'score', 'assessment', 'evidenceQuote'],
      },
    },
  },
  required: ['overallScore', 'overallVerdict', 'summary', 'topFixes', 'questions', 'delivery'],
};

/**
 * The evaluator's schema for one round.
 *
 * `assignedQuestions` exists only when the round assigned bank questions, and
 * `questionId` is a closed enum of THAT ROUND'S ids: the field decides whether
 * a problem leaves the practice rotation, so a foreign id must be impossible to
 * emit rather than filtered afterwards.
 */
export function evaluationSchema(assignedIds: string[] = [], focusKeys: string[] = []) {
  const withAssigned = assignedSchema(assignedIds);
  if (!focusKeys.length) return withAssigned;

  /**
   * Same closed-enum move as `assignedQuestions`: a check against a key the
   * round did not carry could only be the model inventing a commitment, and
   * it is what closes one.
   */
  return {
    ...withAssigned,
    properties: {
      ...withAssigned.properties,
      focusChecks: {
        type: Type.ARRAY,
        description: `EXACTLY one entry per focus item — all ${focusKeys.length} of them.`,
        items: {
          type: Type.OBJECT,
          properties: {
            key: { type: Type.STRING, enum: [...focusKeys], description: 'The focus item this judges, verbatim from the prompt.' },
            result: {
              type: Type.STRING,
              enum: [...FOCUS_RESULTS],
              description:
                'applied = shown clearly every time it had the chance; partly = shown but not consistently, or only ' +
                'when prompted; not_applied = the chance was there and the old habit came back; no_chance = nothing ' +
                'in this round gave an opening for it.',
            },
            evidenceQuote: {
              type: Type.STRING,
              nullable: true,
              description:
                "The candidate's own words showing the result, verbatim. Required for applied and partly. Null for " +
                'no_chance, and for not_applied only when the habit showed as an omission there is nothing to quote.',
            },
            note: { type: Type.STRING, description: 'One sentence justifying that result.' },
          },
          required: ['key', 'result', 'evidenceQuote', 'note'],
        },
      },
    },
    required: [...withAssigned.required, 'focusChecks'],
  };
}

function assignedSchema(assignedIds: string[]) {
  if (!assignedIds.length) return BASE_SCHEMA;

  return {
    ...BASE_SCHEMA,
    properties: {
      ...BASE_SCHEMA.properties,
      assignedQuestions: {
        type: Type.ARRAY,
        description:
          'EXACTLY one entry per assigned problem — all ' +
          `${assignedIds.length} of them, in the order listed in the prompt.`,
        items: {
          type: Type.OBJECT,
          properties: {
            questionId: {
              type: Type.STRING,
              enum: [...assignedIds],
              description: 'The assigned problem this entry judges, verbatim from the prompt.',
            },
            outcome: {
              type: Type.STRING,
              enum: [...QUESTION_OUTCOMES],
              description:
                'solved = a correct working approach they reasoned out; partial = a real but ' +
                'incomplete or incorrect attempt; unsolved = the problem was put to them and ' +
                'they never reached a working approach; not_reached = the interviewer never ' +
                'got to this problem at all.',
            },
            reason: { type: Type.STRING, description: 'One sentence justifying that outcome.' },
            evidenceQuote: {
              type: Type.STRING,
              nullable: true,
              description:
                "The candidate's own words that decide the outcome, verbatim. Null ONLY for " +
                'not_reached.',
            },
          },
          required: ['questionId', 'outcome', 'reason', 'evidenceQuote'],
        },
      },
    },
    required: [...BASE_SCHEMA.required, 'assignedQuestions'],
  };
}
