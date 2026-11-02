import { Link } from 'react-router-dom';
import type { InterviewMode } from '@orvia/shared';
import { studyHref } from '../../lib/studyModes';

/** The setup screen's pointer to a mode's study guide, for the modes that have one. */
export function StudyLink({ mode, children }: { mode: InterviewMode; children: string }) {
  return (
    <p className="rounded-md bg-brand-muted px-3 py-2 text-xs leading-relaxed text-fg">
      {children}{' '}
      <Link to={studyHref(mode)} className="font-medium text-brand underline-offset-2 hover:underline">
        Study first →
      </Link>
    </p>
  );
}
