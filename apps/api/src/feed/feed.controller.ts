import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { feedInteractionSchema } from '@orvia/shared';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';
import { FeedService } from './feed.service';
import { SpeechCacheService } from './speech-cache.service';
import { pageQuerySchema } from './feed.query';

/**
 * A saved snapshot is display data for one account, but it is still stored
 * verbatim from a request body — so it is bounded. Well past the largest card
 * the feed composes, and far short of anything worth calling storage.
 */
const MAX_SNAPSHOT_BYTES = 8_000;

/**
 * The learning feed. Every endpoint is about ONE account — what you have seen,
 * what you got wrong, what your reports said — so the whole controller is
 * behind the guard, unlike the question catalogue next door.
 */
@Controller('api/feed')
@UseGuards(AuthGuard)
export class FeedController {
  constructor(
    private readonly feed: FeedService,
    private readonly speech: SpeechCacheService,
  ) {}

  @Get()
  page(@CurrentUser() user: PublicUser, @Query() query: unknown) {
    const q = pageQuerySchema.parse(query);
    return this.feed.page(user.id, {
      offset: q.offset,
      limit: q.limit,
      seed: q.seed,
      /**
       * Falls back to the server UTC date when omitted by the client.
       * Optional for preview requests that do not specify a day.
       */
      dayKey: q.day ?? new Date().toISOString().slice(0, 10),
      voice: q.voice,
      narratedOnly: q.narrated,
    });
  }

  @Post('interactions')
  interact(@CurrentUser() user: PublicUser, @Body() body: unknown) {
    const input = feedInteractionSchema.parse(body);
    if (input.snapshot !== undefined && JSON.stringify(input.snapshot).length > MAX_SNAPSHOT_BYTES) {
      throw new BadRequestException('That card is too large to save.');
    }
    return this.feed.interact(user.id, input);
  }

  @Get('saved')
  saved(@CurrentUser() user: PublicUser) {
    return this.feed.saved(user.id);
  }

  /** Which pre-generated narration voices this install has built. */
  @Get('voices')
  voices() {
    return this.speech.voices();
  }

  /**
   * One narration clip.
   *
   * Immutable for a year: the filename is a hash of the text and the voice, so
   * a changed card is a different URL and a cached one can never be stale. That
   * is what makes a second listen cost nothing at all.
   */
  @Get('audio/:voice/:file')
  async audio(@Param('voice') voice: string, @Param('file') file: string, @Res() res: Response) {
    const path = await this.speech.resolveFile(voice, file);
    if (!path) throw new NotFoundException('No narration for that card.');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'audio/mp4');
    res.sendFile(path);
  }
}
