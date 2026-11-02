import { Injectable } from '@nestjs/common';
import type { SessionReadyPayload, StartSessionInput } from '@orvia/shared';
import { CommitmentsService } from '../practice/commitments.service';
import { LoopsService } from '../practice/loops.service';
import { DrillService } from './drill.service';
import type { SessionService } from './session.service';

export type PreparedRound = {
  /** What the round actually runs — for a drill, rebuilt server-side and not what the client sent. */
  input: StartSessionInput;
  extras: NonNullable<Parameters<SessionService['create']>[3]>;
  ready: Pick<SessionReadyPayload, 'focus' | 'drill' | 'loop'>;
};

/**
 * Resolves round context before start: drills, open commitments, and loop stage.
 * A drill carries only its own focus.
 */
@Injectable()
export class RoundPracticeService {
  constructor(
    private readonly drills: DrillService,
    private readonly commitments: CommitmentsService,
    private readonly loops: LoopsService,
  ) {}

  async prepare(userId: string, input: StartSessionInput): Promise<PreparedRound> {
    if (input.drill) {
      const d = await this.drills.resolve(userId, input.drill, input.options.durationMinutes);
      return {
        input: d.input,
        extras: { drill: { record: d.record, narrowed: d.narrowed }, focus: d.focus },
        ready: {
          focus: d.focus,
          drill: {
            label: d.record.label,
            question: d.record.question,
            advice: d.record.advice,
            beforeScore: d.record.before.score,
            outOf: d.record.before.outOf,
          },
        },
      };
    }

    const focus = await this.commitments.focusFor(userId);
    const loop = input.loopId ? await this.loops.stageFor(userId, input.loopId, input.config.mode) : undefined;
    return {
      input,
      extras: { focus, loop: loop ? { id: loop.id, stage: loop.stage } : undefined },
      ready: { focus, loop },
    };
  }
}
