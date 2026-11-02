import { useNavigate } from 'react-router-dom';

/**
 * Router state that asks the interview page to start a DRILL of one moment.
 *
 * Starts immediately, like "run it again" and unlike a feed card: the button
 * says "Retry this moment" on a page about that moment, and the click is what
 * grants the page audio (see `useRunAgain`). Only the reference travels — the
 * server rebuilds the drill from the source round's report.
 */
export type DrillNavState = { drill?: { sessionId: string; momentId: string; minutes?: number } };

export function useStartDrill() {
  const navigate = useNavigate();
  return (sessionId: string, momentId: string, minutes?: number) =>
    navigate('/', { state: { drill: { sessionId, momentId, minutes } } satisfies DrillNavState });
}
