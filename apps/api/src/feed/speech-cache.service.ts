import { Inject, Injectable, Logger } from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { FeedAudioClip } from '@orvia/shared';
import { APP_ROOT } from '../config/paths';
import { ENV, type Env } from '../config/env';

type Manifest = {
  voice: string;
  model: string;
  entries: Record<string, { file: string; pauseAfterMs: number }[]>;
};

/**
 * Pre-generated feed audio narration cache.
 * Loads offline-built manifests from disk; falls back cleanly to client-side
 * browser speech if no audio cache is present.
 */
@Injectable()
export class SpeechCacheService {
  private readonly log = new Logger(SpeechCacheService.name);
  /** Resolved against the package root, never `process.cwd()` — see `paths.ts`. */
  private readonly root: string;

  constructor(@Inject(ENV) env: Env) {
    this.root = resolve(APP_ROOT, env.DATA_DIR, 'speech');
  }

  /** voice → cardKey → clips. */
  private manifests = new Map<string, Manifest>();
  private loadedAt = 0;

  /** Re-read at most this often, so a rebuilt cache appears without a restart. */
  private static readonly RELOAD_MS = 60_000;

  /**
   * The built voices and how much of the feed each covers.
   *
   * The count is the point: a half-built cache reads as "the voice is bad"
   * rather than "most cards are not generated yet", because the fallback is
   * silent about being a fallback.
   */
  async voices(): Promise<{ voice: string; cards: number }[]> {
    await this.load();
    return [...this.manifests.values()]
      .map((m) => ({ voice: m.voice, cards: Object.keys(m.entries).length }))
      .sort((a, b) => b.cards - a.cards);
  }

  /** Every card key this voice has narration for. */
  async narratedKeys(voice: string): Promise<Set<string>> {
    await this.load();
    return new Set(Object.keys(this.manifests.get(voice)?.entries ?? {}));
  }

  /** The first built voice, used when the client names none. */
  async defaultVoice(): Promise<string | undefined> {
    return (await this.voices())[0]?.voice;
  }

  /**
   * The clips for one card, as URLs the browser can fetch.
   *
   * An exact key match only. A recall and a drill on the same question read
   * different opening lines, so serving one for the other would narrate
   * "your turn" over a card headed "unfinished business" — the client falls
   * back to browser speech instead, which says the right words.
   */
  async clipsFor(cardKey: string, voice: string): Promise<FeedAudioClip[] | null> {
    await this.load();
    const entry = this.manifests.get(voice)?.entries[cardKey];
    if (!entry?.length) return null;
    return entry.map((clip) => ({
      url: `/api/feed/audio/${encodeURIComponent(voice)}/${encodeURIComponent(clip.file)}`,
      pauseAfterMs: clip.pauseAfterMs,
    }));
  }

  /**
   * Resolve a clip to a path on disk, or null.
   * Path components are validated to prevent directory traversal and ensure the
   * resolved path remains strictly within the cache directory.
   */
  async resolveFile(voice: string, file: string): Promise<string | null> {
    const v = basename(voice);
    const f = basename(file);
    if (!v || !f || v === '.' || v === '..' || f === '.' || f === '..') return null;
    const safe = resolve(this.root, v, f);
    if (!safe.startsWith(resolve(this.root) + sep)) return null;
    try {
      const info = await stat(safe);
      return info.isFile() ? safe : null;
    } catch {
      return null;
    }
  }

  private async load(): Promise<void> {
    if (Date.now() - this.loadedAt < SpeechCacheService.RELOAD_MS) return;
    this.loadedAt = Date.now();

    let files: string[];
    try {
      files = (await readdir(this.root)).filter((f) => f.endsWith('.json'));
    } catch {
      // No cache built yet is the normal state on a fresh install, not an error.
      this.manifests = new Map();
      return;
    }

    // Per file: one manifest caught mid-write by `speech:build` must cost only
    // its own voice, not every voice on the install.
    const next = new Map<string, Manifest>();
    for (const file of files) {
      try {
        const manifest = JSON.parse(await readFile(join(this.root, file), 'utf8')) as Manifest;
        if (manifest?.voice && manifest.entries) next.set(manifest.voice, manifest);
      } catch (e) {
        this.log.warn(`skipping narration manifest ${file}: ${(e as Error).message}`);
      }
    }
    this.manifests = next;
  }
}
