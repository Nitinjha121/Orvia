import { Controller, Get, Post, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { EvaluationService } from './evaluation.service';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';

@Controller('api/sessions/:id/evaluation')
@UseGuards(AuthGuard)
export class EvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  /**
   * Polled by the report screen. Returns evaluation status or reasons why
   * evaluation is unavailable. Asserts session ownership before returning status.
   */
  @Get()
  async get(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.evaluation.getForSession(user.id, id)) ?? (await this.evaluation.describeMissing(id));
  }

  /**
   * Manual re-run to re-score a session. Answers only once the new evaluation row
   * exists so subsequent polls read fresh data, or reports if a run is already in flight.
   */
  @Post()
  async retry(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.evaluation.getForSession(user.id, id); // asserts ownership
    const started = await this.evaluation.enqueue(id);
    return { status: started === 'started' ? 'evaluating' : 'already_running' };
  }
}
