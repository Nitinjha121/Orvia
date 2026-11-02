import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AUDIO } from '@orvia/shared';
import { wavHeader } from './recording.service';

/**
 * The two sides of a round as one track. The microphone is 16kHz and the
 * interviewer 24kHz, both silence-padded to their offset in the round, so they
 * share a timeline and sum once resampled. Plain Node, not ffmpeg: ffmpeg is a
 * test-time dependency here, and playback must not need it. Mixed at 16kHz —
 * upsampling the candidate would invent detail that was never captured.
 */

const BYTES = AUDIO.bytesPerSample;

/** Reads a mono 16-bit WAV written by `RecordingService` into samples. */
function readPcm(buf: Buffer): Int16Array {
  const body = buf.subarray(44); // our own canonical header
  return new Int16Array(body.buffer, body.byteOffset, Math.floor(body.length / BYTES));
}

/**
 * Linear resample. Speech at these rates has nothing near Nyquist that a
 * sharper filter would rescue, and a wrong-but-clever filter is worse than a
 * simple correct one.
 */
function resample(src: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return src;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const a = Math.floor(at);
    const b = Math.min(a + 1, src.length - 1);
    const frac = at - a;
    out[i] = (src[a]! * (1 - frac) + src[b]! * frac) | 0;
  }
  return out;
}

/**
 * Sums two tracks into one 16kHz mono WAV.
 *
 * Each side is halved before summing. Two full-scale voices added together
 * clip, and clipping is not a cosmetic problem here: this recording exists so
 * you can hear hesitation and vocal confidence, and distortion destroys exactly
 * that. Halving costs 6dB of headroom, which playback volume replaces.
 */
export function mixTracks(mineWav: Buffer, theirsWav: Buffer | null): Buffer {
  const mine = readPcm(mineWav);
  const theirs = theirsWav
    ? resample(readPcm(theirsWav), AUDIO.outputSampleRate, AUDIO.inputSampleRate)
    : new Int16Array(0);

  const len = Math.max(mine.length, theirs.length);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const sum = ((mine[i] ?? 0) >> 1) + ((theirs[i] ?? 0) >> 1);
    out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
  }

  const body = Buffer.from(out.buffer, out.byteOffset, out.length * BYTES);
  return Buffer.concat([
    wavHeader(body.length, AUDIO.inputSampleRate, 1, 8 * BYTES),
    body,
  ]);
}

/**
 * Directory for generated playback mixes: `DATA_DIR/mix`, separated from canonical
 * audio recordings so regenerable mixes are excluded from backups.
 */
export function mixPathFor(dataDir: string, micPath: string): string {
  return join(dataDir, 'mix', basename(micPath).replace(/\.wav$/, '') + '.mix.wav');
}

/**
 * The size a mix of these two files comes out at, computed exactly as
 * `mixTracks` does. Freshness is judged by this and not by mtime, because
 * `ArchiveService.ensureLocal` touches a restored file on every access, which
 * made every cached mix look stale and re-mixed a whole round on every seek.
 */
function mixedBytes(mineBytes: number, theirsBytes: number | null): number {
  const mine = Math.floor(Math.max(0, mineBytes - 44) / BYTES);
  const theirsIn = theirsBytes === null ? 0 : Math.floor(Math.max(0, theirsBytes - 44) / BYTES);
  const ratio = AUDIO.outputSampleRate / AUDIO.inputSampleRate;
  const theirs = theirsBytes === null ? 0 : ratio === 1 ? theirsIn : Math.floor(theirsIn / ratio);
  return 44 + Math.max(mine, theirs) * BYTES;
}

/**
 * Where a mix built WITHOUT the interviewer track goes. Size alone cannot tell
 * the two apart — the candidate's track runs the whole round, so it is almost
 * always the longer one — and a candidate-only mix cached at `outPath` was
 * served for good once the interviewer's restore started succeeding.
 */
export function soloMixPath(outPath: string): string {
  return outPath.replace(/\.mix\.wav$/, '.solo.mix.wav');
}

/** One build per output path, so concurrent range requests share it. */
const building = new Map<string, Promise<string>>();

/**
 * The mixed track, built on first request and reused. Mixing a 30-minute round
 * is a second or two — worth caching, not worth repeating per seek. Written to
 * a temporary name and renamed, so a concurrent reader can never serve, or a
 * later request cache as fresh, a half-written file.
 */
export function ensureMixed(
  minePath: string,
  theirsPath: string | null,
  outPath: string,
): Promise<string> {
  const inFlight = building.get(outPath);
  if (inFlight) return inFlight;
  const job = build(minePath, theirsPath, outPath).finally(() => building.delete(outPath));
  building.set(outPath, job);
  return job;
}

async function build(minePath: string, theirsPath: string | null, outPath: string): Promise<string> {
  const [mineStat, theirsStat, outStat] = await Promise.all([
    stat(minePath).catch(() => null),
    theirsPath ? stat(theirsPath).catch(() => null) : Promise.resolve(null),
    stat(outPath).catch(() => null),
  ]);
  if (!mineStat) throw new Error('no candidate track to mix');
  if (!theirsStat) outPath = soloMixPath(outPath);
  const cached = theirsStat ? outStat : await stat(outPath).catch(() => null);

  if (cached && cached.size === mixedBytes(mineStat.size, theirsStat?.size ?? null)) return outPath;

  const [mine, theirs] = await Promise.all([
    readFile(minePath),
    theirsStat && theirsPath ? readFile(theirsPath) : Promise.resolve(null),
  ]);
  await mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, mixTracks(mine, theirs));
    await rename(tmp, outPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return outPath;
}
