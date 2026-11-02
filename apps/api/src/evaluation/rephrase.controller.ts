import { Controller, Get, Post, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { RephraseService } from './rephrase.service';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';

@Controller('api/sessions/:id/rephrase')
@UseGuards(AuthGuard)
export class RephraseController {
  constructor(private readonly rephrase: RephraseService) {}

  /** Polled by the report while `writing`. */
  @Get()
  get(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rephrase.get(user.id, id);
  }

  /** Writes the rewrites, or writes them again. */
  @Post()
  start(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rephrase.start(user.id, id);
  }
}
