/**
 * Archives finished round recordings to R2 as FLAC, restoring them on demand.
 * FLAC is used because it is bit-exact with the original WAVs, avoiding codec drift
 * in speech boundary detection. Decoded restores use `-bitexact -map_metadata -1`
 * so sample offsets match standard WAV chunk layouts. Local WAVs are deleted only
 * after FLAC verification and remote read-back checks succeed.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { isTestDatabaseName } from '@orvia/shared';

import { APP_ROOT } from '../config/paths';
import { ENV, type Env } from '../config/env';
import { mixPathFor, soloMixPath } from '../interview/audio-mix';
import { StorageService } from './storage.service';

const run = promisify(execFile);

/** Restored WAVs land here, never back in `audio/`, which holds live rounds. */
const CACHE_DIR_NAME = 'audio-cache';
/**
 * Encoder scratch. Kept out of `audio/` because `tools/backup-db.sh` snapshots
 * that directory whole and a crash would leave a stray `*.verify.wav` there
 * that looks like a round.
 */
const WORK_DIR_NAME = 'archive-work';
/** A restored file untouched for this long is evicted. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** `x-amz-meta-<this>`: SHA-1 of the WAV the object was encoded from. */
export const WAV_SHA_META = 'wav-sha1';

type Encoded = {
  wav: string;
  key: string;
  flac: Buffer;
  wavSha: string;
  wavSize: number;
  wavMtimeMs: number;
};

export type ArchiveResult = { archived: boolean; bytes: number };

@Injectable()
export class ArchiveService {
  private readonly log = new Logger(ArchiveService.name);
  private readonly dataDir: string;
  private readonly cacheDir: string;
  private readonly workDir: string;
  /**
   * Test stacks share the bucket with the real one. Their own prefix means no
   * test cleanup can ever address a real round's key, and a lifecycle rule on
   * `test/` can expire whatever a failed suite leaks.
   */
  private readonly keyPrefix: string;
  private readonly restoring = new Map<string, Promise<string | null>>();
  private readonly archiving = new Map<string, Promise<ArchiveResult>>();

  constructor(
    @Inject(ENV) env: Env,
    private readonly storage: StorageService,
  ) {
    const dataDir = resolve(APP_ROOT, env.DATA_DIR);
    this.dataDir = dataDir;
    this.cacheDir = join(dataDir, CACHE_DIR_NAME);
    this.workDir = join(dataDir, WORK_DIR_NAME);
    this.keyPrefix = isTestDatabaseName(basename(dataDir)) ? 'test/audio/' : 'audio/';
  }

  /** `data/audio/<id>.ai.wav` -> `audio/<id>.ai.flac`. */
  keyFor(wavPath: string): string {
    return `${this.keyPrefix}${basename(wavPath).replace(/\.wav$/, '.flac')}`;
  }

  /**
   * Returns a readable local WAV path for a recording, restoring it from R2
   * first if it is archived. THE choke point: every consumer calls this and
   * none of them needs to know whether the round is local or remote.
   *
   * Null in, null out, and null when the bucket has no such object: a round
   * with no recording is a normal state and "absent" must not become a 500.
   */
  async ensureLocal(wavPath: string | null | undefined): Promise<string | null> {
    if (!wavPath) return null;
    if (await this.exists(wavPath)) return wavPath;
    if (!this.storage.isEnabled()) return null;

    const cached = join(this.cacheDir, basename(wavPath));
    if (await this.exists(cached)) {
      // Refreshed so a file a ten-minute re-transcription is reading is not
      // evicted by a restore of another round halfway through.
      const now = new Date();
      await utimes(cached, now, now).catch(() => {});
      return cached;
    }

    const inFlight = this.restoring.get(cached);
    if (inFlight) return inFlight;

    const job = this.restore(wavPath, cached).finally(() => this.restoring.delete(cached));
    this.restoring.set(cached, job);
    return job;
  }

  /**
   * Written to a temporary name and renamed, so no reader — including one in a
   * later process — can ever pick up a half-decoded file as the recording.
   */
  private async restore(wavPath: string, cached: string): Promise<string | null> {
    const key = this.keyFor(wavPath);
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.workDir, { recursive: true });
    await this.evictStale();

    const obj = await this.storage.getObject(key);
    if (!obj) {
      this.log.warn(`${basename(wavPath)} is neither on disk nor in R2 (${key})`);
      return null;
    }

    const tag = randomBytes(6).toString('hex');
    const flac = join(this.workDir, `${basename(cached)}.${tag}.restore.flac`);
    const partial = join(this.cacheDir, `.${basename(cached, '.wav')}.${tag}.partial.wav`);
    try {
      await writeFile(flac, obj.body);
      await this.decodeToWav(flac, partial);
      const expected = obj.meta[WAV_SHA_META];
      if (expected) {
        const got = await this.sha(partial);
        if (got !== expected) {
          throw new Error(`${key} restored to sha1 ${got}, archived as ${expected} — refusing to serve it`);
        }
      } else {
        this.log.warn(`${key} predates checksum metadata — restored unverified`);
      }
      await rename(partial, cached);
    } finally {
      await unlink(flac).catch(() => {});
      await unlink(partial).catch(() => {});
    }
    this.log.log(`restored ${key} -> ${basename(cached)} (${obj.body.length} bytes of FLAC)`);
    return cached;
  }

  /**
   * Archives both tracks of one session and removes the local WAVs.
   * `beforeDelete` runs after objects are verified and stamps the row before
   * local files are removed. If files were already removed previously, the track
   * still counts as archived.
   */
  archiveSession(
    sessionId: string,
    paths: { audioPath?: string | null; aiAudioPath?: string | null },
    opts: { beforeDelete?: (bytes: number) => Promise<void> } = {},
  ): Promise<ArchiveResult> {
    const inFlight = this.archiving.get(sessionId);
    if (inFlight) return inFlight;
    const job = this.archiveOnce(sessionId, paths, opts).finally(() => this.archiving.delete(sessionId));
    this.archiving.set(sessionId, job);
    return job;
  }

  private async archiveOnce(
    sessionId: string,
    paths: { audioPath?: string | null; aiAudioPath?: string | null },
    opts: { beforeDelete?: (bytes: number) => Promise<void> },
  ): Promise<ArchiveResult> {
    const none = { archived: false, bytes: 0 };
    if (!this.storage.isEnabled()) return none;

    const tracks = [...new Set([paths.audioPath, paths.aiAudioPath].filter(Boolean) as string[])];
    if (!tracks.length) return none;
    await mkdir(this.workDir, { recursive: true });

    // Every track is encoded and proven before any is uploaded: archiving one
    // track of a round and abandoning the other leaves a session half-playable.
    const encoded: Encoded[] = [];
    let alreadyRemote = 0;
    for (const wav of tracks) {
      if (await this.exists(wav)) {
        const e = await this.encodeVerified(wav);
        if (!e) return none;
        encoded.push({ ...e, key: this.keyFor(wav) });
      } else {
        const remote = await this.storage.head(this.keyFor(wav));
        if (remote !== null) alreadyRemote += remote;
      }
    }
    if (!encoded.length && !alreadyRemote) return none;

    const planned = encoded.reduce((n, e) => n + e.flac.length, 0);
    if (!this.storage.hasRoomFor(planned)) {
      const u = this.storage.usage();
      this.log.warn(
        `session ${sessionId}: not archived — R2 is at ${(u.fraction * 100).toFixed(1)}% ` +
          `of the free tier and this round needs ${(planned / 1024 ** 2).toFixed(1)}MB. ` +
          'Recordings stay on local disk.',
      );
      return none;
    }

    for (const e of encoded) {
      await this.storage.put(e.key, e.flac, 'audio/flac', { [WAV_SHA_META]: e.wavSha });
      const back = await this.storage.getObject(e.key);
      if (!back || !back.body.equals(e.flac) || back.meta[WAV_SHA_META] !== e.wavSha) {
        throw new Error(
          `session ${sessionId}: ${e.key} did not read back as uploaded ` +
            `(${back ? `${back.body.length} bytes` : 'absent'}, expected ${e.flac.length}) — WAVs kept`,
        );
      }
    }

    const total = planned + alreadyRemote;
    if (opts.beforeDelete) await opts.beforeDelete(total);

    for (const e of encoded) {
      const now = await stat(e.wav);
      if (now.size !== e.wavSize || now.mtimeMs !== e.wavMtimeMs) {
        throw new Error(`session ${sessionId}: ${basename(e.wav)} changed while archiving — kept`);
      }
      await unlink(e.wav);
    }
    // The playback mix is derived from these two files and rebuilt from the
    // restored copies on demand, so leaving it would free only half the disk.
    if (paths.audioPath && encoded.length) await this.dropMix(paths.audioPath);
    this.log.log(
      `session ${sessionId}: archived ${encoded.length} track(s), ` +
        `${(total / 1024 ** 2).toFixed(1)}MB in R2`,
    );
    return { archived: true, bytes: total };
  }

  /**
   * Removes a round's objects and cached copies. For whatever deletes a
   * session: its row going leaves bytes in the bucket that no budget seed can
   * see and no restore will ever ask for.
   */
  async purgeSession(paths: { audioPath?: string | null; aiAudioPath?: string | null }): Promise<number> {
    if (!this.storage.isEnabled()) return 0;
    let freed = 0;
    for (const wav of [paths.audioPath, paths.aiAudioPath].filter(Boolean) as string[]) {
      const key = this.keyFor(wav);
      const size = await this.storage.head(key);
      if (size !== null) {
        await this.storage.delete(key, size);
        freed += size;
      }
      await unlink(join(this.cacheDir, basename(wav))).catch(() => {});
    }
    if (paths.audioPath) await this.dropMix(paths.audioPath);
    return freed;
  }

  // Mixes predating DATA_DIR/mix sit beside the recording, so both are cleared.
  private async dropMix(micPath: string): Promise<void> {
    // Without the suffix the replace below is a no-op and would unlink the recording itself.
    if (!micPath.endsWith('.wav')) return;
    const mix = mixPathFor(this.dataDir, micPath);
    await unlink(mix).catch(() => {});
    await unlink(soloMixPath(mix)).catch(() => {});
    await unlink(micPath.replace(/\.wav$/, '.mix.wav')).catch(() => {});
  }

  /**
   * Encodes to FLAC and proves it decodes back to the identical bytes. Null
   * rather than a throw when the proof fails: an unarchivable round stays on
   * disk, which is safe. A salvaged round whose header disagrees with its
   * length lands here, and is meant to.
   */
  private async encodeVerified(wav: string): Promise<Omit<Encoded, 'key'> | null> {
    const tag = randomBytes(6).toString('hex');
    const flacPath = join(this.workDir, `${basename(wav)}.${tag}.flac`);
    const check = join(this.workDir, `${basename(wav)}.${tag}.verify.wav`);
    try {
      const before = await stat(wav);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'flac', flacPath]);
      await this.decodeToWav(flacPath, check);
      const [wavSha, checkSha] = await Promise.all([this.sha(wav), this.sha(check)]);
      if (wavSha !== checkSha) {
        this.log.warn(`${basename(wav)}: FLAC round-trip is not identical — leaving it on disk`);
        return null;
      }
      return {
        wav,
        flac: await readFile(flacPath),
        wavSha,
        wavSize: before.size,
        wavMtimeMs: before.mtimeMs,
      };
    } catch (err) {
      this.log.warn(`${basename(wav)}: archive encode failed — ${(err as Error).message}`);
      return null;
    } finally {
      await unlink(flacPath).catch(() => {});
      await unlink(check).catch(() => {});
    }
  }

  private async decodeToWav(src: string, dest: string) {
    await run('ffmpeg', [
      '-v', 'error', '-y', '-i', src,
      '-c:a', 'pcm_s16le',
      // Load-bearing: see the note at the top of this file.
      '-fflags', '+bitexact', '-map_metadata', '-1',
      dest,
    ]);
  }

  /** Streamed: a long round's WAV is over 100MB. */
  private sha(path: string): Promise<string> {
    return new Promise((ok, fail) => {
      const h = createHash('sha1');
      createReadStream(path)
        .on('data', (c) => h.update(c))
        .on('end', () => ok(h.digest('hex')))
        .on('error', fail);
    });
  }

  private async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  private async evictStale() {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const dir of [this.cacheDir, this.workDir]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const p = join(dir, name);
        const s = await stat(p).catch(() => null);
        if (s && s.mtimeMs < cutoff) await unlink(p).catch(() => {});
      }
    }
  }
}
