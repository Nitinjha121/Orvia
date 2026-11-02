import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';
import { CommitmentsService } from './commitments.service';
import { LoopsService } from './loops.service';
import { PlanService } from './plan.service';

/** Every route is guarded and every read is scoped to the signed-in user. */
@Controller('api/commitments')
@UseGuards(AuthGuard)
export class CommitmentsController {
  constructor(private readonly svc: CommitmentsService) {}

  @Get()
  list(@CurrentUser() user: PublicUser) {
    return this.svc.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: PublicUser, @Body() body: unknown) {
    return this.svc.create(user.id, body);
  }

  /** Drops it. The verdicts it earned stay, keyed by its id. */
  @Delete(':id')
  drop(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.drop(user.id, id);
  }
}

@Controller('api/loops')
@UseGuards(AuthGuard)
export class LoopsController {
  constructor(private readonly svc: LoopsService) {}

  @Get()
  list(@CurrentUser() user: PublicUser) {
    return this.svc.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: PublicUser, @Body() body: unknown) {
    return this.svc.create(user.id, body);
  }

  @Get(':id')
  get(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(user.id, id);
  }

  @Post(':id/abandon')
  abandon(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.abandon(user.id, id);
  }
}

@Controller('api/plan')
@UseGuards(AuthGuard)
export class PlanController {
  constructor(private readonly svc: PlanService) {}

  @Get()
  get(@CurrentUser() user: PublicUser) {
    return this.svc.summary(user.id);
  }
}
