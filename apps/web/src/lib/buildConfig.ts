import type { InterviewConfig, InterviewMode, SessionOptions, StartSessionInput } from '@orvia/shared';

type ConfigOf<M extends InterviewMode> = Extract<InterviewConfig, { mode: M }>;

export type DsaLanguage = ConfigOf<'dsa'>['language'];
export type DesignLevel = ConfigOf<'system_design'>['level'];
export type ConceptDepth = ConfigOf<'concepts'>['depth'];

/** Everything the setup form holds, across every mode. */
export type SetupState = {
  dsa: { questionIds: string[]; language: DsaLanguage };
  /** Shared by the JD round and the experience round's optional role. */
  jobDescription: string;
  /** Shared by the experience and behavioural rounds. */
  experience: string;
  systemDesign: { problem: { id: string; prompt: string } | null; level: DesignLevel };
  concepts: { questionIds: string[]; depth: ConceptDepth };
  behavioural: { questionIds: string[] };
  hr: {
    scenarioId: string;
    targetRole: string;
    currentCompensation: string;
    expectedCompensation: string;
    noticePeriod: string;
    competingOffers: string;
    reasonForLeaving: string;
  };
  options: SessionOptions;
};

/** The server's own floor for `jobDescription` and `experience`. */
const MIN_TEXT = 50;

/**
 * The round `mode` would start with, or null while the form cannot start one.
 * Pure, so the readiness rule and the payload cannot disagree.
 */
export function buildConfig(mode: InterviewMode, s: SetupState): StartSessionInput | null {
  const config = configFor(mode, s);
  return config ? { config, options: s.options } : null;
}

function configFor(mode: InterviewMode, s: SetupState): InterviewConfig | null {
  switch (mode) {
    case 'dsa':
      if (s.dsa.questionIds.length === 0) return null;
      return { mode, questionIds: s.dsa.questionIds, codeEditor: true, language: s.dsa.language };
    case 'jd':
      if (s.jobDescription.trim().length < MIN_TEXT) return null;
      return { mode, jobDescription: s.jobDescription };
    case 'experience': {
      if (s.experience.trim().length < MIN_TEXT) return null;
      // The role is optional, but one too short for the server is a form that
      // cannot start, not a round that silently drops it.
      const role = s.jobDescription.trim();
      if (role && role.length < MIN_TEXT) return null;
      return role
        ? { mode, experience: s.experience, jobDescription: s.jobDescription }
        : { mode, experience: s.experience };
    }
    case 'system_design': {
      const p = s.systemDesign.problem;
      if (!p) return null;
      // The prompt is what the interviewer is given; the id is what history,
      // the evaluator's notes and the rotation resolve against.
      return { mode, problem: p.prompt, problemId: p.id, level: s.systemDesign.level, scratchpad: true };
    }
    case 'concepts':
      if (s.concepts.questionIds.length === 0) return null;
      return { mode, questionIds: s.concepts.questionIds, depth: s.concepts.depth };
    case 'behavioural':
      if (s.behavioural.questionIds.length === 0) return null;
      // Carried on the config so an old round stays reproducible.
      return { mode, questionIds: s.behavioural.questionIds, experience: s.experience };
    case 'hr': {
      const h = s.hr;
      if (!h.scenarioId) return null;
      // Empty strings become undefined, which JSON drops: an empty expected
      // salary is not the same claim as "not decided", and the evaluator
      // compares what you typed here against what you said in the room.
      const opt = (v: string) => v.trim() || undefined;
      return {
        mode,
        scenarioId: h.scenarioId,
        targetRole: opt(h.targetRole),
        currentCompensation: opt(h.currentCompensation),
        expectedCompensation: opt(h.expectedCompensation),
        noticePeriod: opt(h.noticePeriod),
        competingOffers: opt(h.competingOffers),
        reasonForLeaving: opt(h.reasonForLeaving),
      };
    }
  }
}
