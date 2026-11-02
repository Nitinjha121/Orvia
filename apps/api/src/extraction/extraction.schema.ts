import { Type } from '@google/genai';
import { z } from 'zod';

/**
 * A job description, reduced to what an interviewer needs.
 *
 * The point is targeting. Handed raw JD text, the interviewer asks generically
 * relevant questions; handed weighted competencies, it asks about what this
 * role actually screens for.
 */
export const JD_BRIEF_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    role: { type: Type.STRING, description: 'The job title, normalised.' },
    seniority: { type: Type.STRING, enum: ['junior', 'mid', 'senior', 'staff', 'unclear'] },
    domain: { type: Type.STRING, description: 'e.g. "payments infrastructure", "consumer mobile".' },
    mustHave: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Non-negotiable skills, in the order the posting weights them. At most 6.',
    },
    niceToHave: { type: Type.ARRAY, items: { type: Type.STRING } },
    focusAreas: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          area: { type: Type.STRING },
          why: { type: Type.STRING, description: 'What in the posting implies this matters.' },
          weight: { type: Type.NUMBER, description: '1-5, how much of the round to spend here.' },
        },
        required: ['area', 'why', 'weight'],
      },
      description: '3-5 areas the round should actually cover.',
    },
    likelyProbes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Specific questions a real interviewer for THIS role would ask. 4-8.',
    },
  },
  required: ['role', 'seniority', 'mustHave', 'focusAreas', 'likelyProbes'],
};

/**
 * A background dump, reduced to things that can be probed.
 *
 * Vague collective claims are the primary failure mode in an experience round,
 * so they are extracted explicitly — they are the most valuable thing to push on.
 */
export const EXPERIENCE_BRIEF_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING, description: 'One line: who this person is, professionally.' },
    projects: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          whatTheyClaim: { type: Type.STRING, description: 'Their own description, condensed.' },
          probeAngles: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Specific questions that would test whether they actually did this. 2-4.',
          },
        },
        required: ['name', 'whatTheyClaim', 'probeAngles'],
      },
      description: 'Up to 5 projects, most substantial first.',
    },
    quantifiedClaims: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Claims with a number attached. Ask how it was measured.',
    },
    vagueClaims: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Claims with no personal ownership or no measurement — "we built", "improved performance". These are the most valuable things to push on.',
    },
    strongestArea: { type: Type.STRING },
    thinnestArea: { type: Type.STRING, description: 'Where the background is weakest or least evidenced.' },
  },
  required: ['headline', 'projects', 'vagueClaims'],
};

/** The replies, validated before they are cached or reach a prompt. */
export const jdBriefSchema = z.object({
  role: z.string(),
  seniority: z.string(),
  domain: z.string().optional(),
  mustHave: z.array(z.string()),
  niceToHave: z.array(z.string()).optional(),
  focusAreas: z.array(z.object({ area: z.string(), why: z.string(), weight: z.number() })),
  likelyProbes: z.array(z.string()),
});
export type JdBrief = z.infer<typeof jdBriefSchema>;

export const experienceBriefSchema = z.object({
  headline: z.string(),
  projects: z.array(z.object({ name: z.string(), whatTheyClaim: z.string(), probeAngles: z.array(z.string()) })),
  quantifiedClaims: z.array(z.string()).optional(),
  vagueClaims: z.array(z.string()),
  strongestArea: z.string().optional(),
  thinnestArea: z.string().optional(),
});
export type ExperienceBrief = z.infer<typeof experienceBriefSchema>;
