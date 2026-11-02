import { useNavigate } from 'react-router-dom';

/**
 * Router state requesting the interview page to replay a past round by session ID.
 * The server re-validates the setup against the current question bank via replay API.
 */
export type ReplayNavState = { replaySessionId?: string };

/**
 * Navigates to the interview screen with a replay queued.
 * Initiating from a user click activates audio playback permission for the session.
 */
export function useRunAgain() {
  const navigate = useNavigate();
  return (sessionId: string) =>
    navigate('/', { state: { replaySessionId: sessionId } satisfies ReplayNavState });
}
