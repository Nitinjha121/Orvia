import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';
import { SessionHistoryService } from './session-history.service';
import { ReplayService } from './replay.service';
import { DrillService } from './drill.service';

/** A user's own rounds. Every route is guarded and every read is user-scoped. */
@Controller('api/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(
    private readonly history: SessionHistoryService,
    private readonly replayer: ReplayService,
    private readonly drills: DrillService,
  ) {}

  @Get()
  list(@CurrentUser() user: PublicUser) {
    return this.history.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.history.detail(user.id, id);
  }

  /** Everything needed to run this round AGAIN — see `ReplayService`. */
  @Get(':id/replay')
  replay(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.replayer.plan(user.id, id);
  }

  /** What the report says went badly, each one retryable as a drill — see `DrillService`. */
  @Get(':id/moments')
  moments(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.drills.moments(user.id, id);
  }

  /** A drill of one moment, ready to start. The server rebuilds it again at start. */
  @Get(':id/moments/:momentId/drill')
  drill(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('momentId') momentId: string,
    @Query('minutes') minutes?: string,
  ) {
    return this.drills.plan(user.id, id, momentId, minutes ? Number(minutes) : undefined);
  }
}
