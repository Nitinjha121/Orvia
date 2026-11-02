import { useNavigate } from 'react-router-dom';
import type { InterviewMode } from '@orvia/shared';

/**
 * Router state for navigating to setup with a pre-selected question from the feed.
 * Configures the mode and question while allowing the user to review settings
 * before starting the session.
 */
export type FeedPracticeNavState = {
  practice?: { mode: InterviewMode; questionId: string };
};

export function usePracticeFromFeed() {
  const navigate = useNavigate();
  return (mode: string, questionId: string) =>
    navigate('/', {
      state: { practice: { mode: mode as InterviewMode, questionId } } satisfies FeedPracticeNavState,
    });
}
