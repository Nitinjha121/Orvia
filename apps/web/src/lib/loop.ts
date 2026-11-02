import { useNavigate } from 'react-router-dom';
import type { InterviewMode } from '@orvia/shared';

/**
 * Router state that opens the setup screen on an onsite loop's next stage.
 *
 * Does NOT start the round: the stage still needs its questions picked, and
 * the server checks at start that the round really is this loop's next stage.
 */
export type LoopNavState = {
  loopStage?: { loopId: string; mode: InterviewMode; minutes: number; stage: number; of: number; label: string };
};

export function useContinueLoop() {
  const navigate = useNavigate();
  return (s: NonNullable<LoopNavState['loopStage']>) =>
    navigate('/', { state: { loopStage: s } satisfies LoopNavState });
}
