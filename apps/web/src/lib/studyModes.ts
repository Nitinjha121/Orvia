import type { InterviewMode } from '@orvia/shared';

/**
 * Which modes have a study guide, and the tab each one sits under. Separate
 * from `study.ts` so the playbook and the setup screen can link to a guide
 * without pulling every guide's text into the main bundle.
 */
export const STUDY_TABS: Partial<Record<InterviewMode, string>> = {
  system_design: 'System design',
  hr: 'HR & salary',
  behavioural: 'Behavioural',
};

/** System design is the default tab, so it keeps the bare path. */
export const studyHref = (mode: InterviewMode): string =>
  mode === 'system_design' ? '/study' : `/study?mode=${mode}`;
