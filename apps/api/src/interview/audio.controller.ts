import {
  Controller, Get, Param, ParseUUIDPipe, Query, Inject, Logger, NotFoundException, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import { sessions, type Database } from '@orvia/db';
import { DB } from '../db/db.module';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';
import { ensureMixed, mixPathFor } from './audio-mix';
import { parseRange } from './byte-range';
import { ArchiveService } from '../storage/archive.service';
import { ENV, type Env } from '../config/env';
import { APP_ROOT } from '../config/paths';

/**
 * Serves round audio recordings with HTTP range requests for in-browser playback seeking.
 * `?track=` supports `both` (default mix), `me` (candidate track), or `interviewer`.
 *
 * Evaluation and delivery scoring analyze the candidate's voice track directly rather than this mix.
 */
@Controller('api/sessions/:id/audio')
@UseGuards(AuthGuard)
export class AudioController {
  private readonly log = new Logger(AudioController.name);
  private readonly dataDir: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly archive: ArchiveService,
    @Inject(ENV) env: Env,
  ) {
    this.dataDir = resolve(APP_ROOT, env.DATA_DIR);
  }

  @Get()
  async get(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('track') track: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Scoped by user as well as id: a recording of someone talking about their
    // career must never be reachable by guessing a session id.
    const [row] = await this.db
      .select({ audioPath: sessions.audioPath, aiAudioPath: sessions.aiAudioPath })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, user.id)));

    if (!row?.audioPath) throw new NotFoundException('No recording for this round.');

    // Archived rounds are restored from R2 to a local cache first, so all
    // below works on ordinary WAV paths whichever side they came from.
    const micPath = await this.archive.ensureLocal(row.audioPath);
    const aiPath = await this.archive.ensureLocal(row.aiAudioPath);
    if (!micPath) throw new NotFoundException('The recording file is missing.');

    const want = track === 'me' || track === 'interviewer' ? track : 'both';
    let path: string;
    if (want === 'me') {
      path = micPath;
    } else if (want === 'interviewer') {
      if (!aiPath) {
        throw new NotFoundException('No interviewer audio for this round.');
      }
      path = aiPath;
    } else {
      // With no interviewer track (older rounds) the mix is the candidate.
      try {
        path = await ensureMixed(micPath, aiPath, mixPathFor(this.dataDir, micPath));
      } catch (err) {
        this.log.warn(`session ${id}: mix failed, serving the candidate track: ${String(err)}`);
        path = micPath;
      }
    }

    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new NotFoundException('The recording file is missing.');
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    // Private: this is personal audio, and it must not sit in a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.setHeader('Content-Length', size);
    }

    // A read error mid-stream would otherwise be an unhandled 'error' event,
    // which takes the whole process down with every live round in it.
    try {
      await pipeline(createReadStream(path, range ?? {}), res);
    } catch (err) {
      if (!res.writableEnded) this.log.warn(`session ${id}: playback stream failed: ${String(err)}`);
      res.destroy();
    }
  }
}
