import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { AUDIO } from '@orvia/shared';
import { wavHeader } from '../interview/recording.service';

/**
 * Shared by the two paths that put a recording in front of a model: the
 * session coach's primer, and the mentor's `listen_to_round` tool. One
 * implementation on purpose — the budget arithmetic below was measured, not
 * guessed, and a second copy of it would drift.
 */

/**
 * Ceiling on audio in a request, capped at 36MB base64 (~15 minutes of 16kHz mono PCM).
 * Budget is calculated on the base64 payload rather than raw file size.
 * Compressed audio and 8kHz PCM are unsupported by the Live API, so duration is partitioned.
 */
const MAX_PART_B64_BYTES = 36 * 1024 * 1024;

/** Canonical RIFF/WAVE header written by the recorder. */
const WAV_HEADER_BYTES = 44;

/** Raw PCM that base64-encodes to at most the budget above. */
const MAX_PART_PCM_BYTES = Math.floor(MAX_PART_B64_BYTES / 4) * 3;

const BYTES_PER_SECOND = AUDIO.inputSampleRate * AUDIO.bytesPerSample;

/**
 * Seconds of recording per request (~884s). Longer rounds are partitioned into
 * sequential parts. Header size is accounted for before encoding to stay strictly
 * within the base64 payload ceiling.
 */
export const PART_SECONDS = Math.floor(
  (MAX_PART_PCM_BYTES - WAV_HEADER_BYTES) / BYTES_PER_SECOND,
);


const log = new Logger('CoachAudio');

export type LoadedAudio = {
  audio: { mimeType: string; data: string };
  /** 1-based. */
  part: number;
  /** How many parts this recording splits into. 1 means it fits whole. */
  parts: number;
  fromSeconds: number;
  toSeconds: number;
  totalSeconds: number;
  /** True when the recording does not fit in a single request. */
  split: boolean;
};

/**
 * Loads one part of a recording, re-headered as a standalone valid WAV.
 * Allows models to inspect full recordings across multiple parts.
 * Out-of-bounds part indices are clamped to valid ranges.
 */
export async function loadAudio(
  path: string | null,
  part = 1,
): Promise<LoadedAudio | null> {
  if (!path) return null;
  try {
    const wav = await readFile(path);
    if (wav.length <= WAV_HEADER_BYTES) return null;

    const pcm = wav.subarray(WAV_HEADER_BYTES);
    const totalSeconds = Math.round(pcm.length / BYTES_PER_SECOND);
    const parts = Math.max(1, Math.ceil(totalSeconds / PART_SECONDS));

    const want = Number.isFinite(part) ? Math.trunc(part) : 1;
    const idx = Math.min(Math.max(want, 1), parts) - 1;

    // Cut on whole-second boundaries so every rebuilt header stays honest.
    const fromSeconds = idx * PART_SECONDS;
    const toSeconds = Math.min(totalSeconds, fromSeconds + PART_SECONDS);
    const split = parts > 1;

    const body = split
      ? pcm.subarray(fromSeconds * BYTES_PER_SECOND, toSeconds * BYTES_PER_SECOND)
      : pcm;
    if (!body.length) return null;

    const buf = split
      ? Buffer.concat([
          wavHeader(body.length, AUDIO.inputSampleRate, 1, 8 * AUDIO.bytesPerSample),
          body,
        ])
      : wav;

    if (split) {
      log.log(
        `recording is ${totalSeconds}s, over the ${PART_SECONDS}s request budget — ` +
          `serving part ${idx + 1} of ${parts} (${fromSeconds}-${toSeconds}s)`,
      );
    }

    return {
      audio: { mimeType: 'audio/wav', data: buf.toString('base64') },
      part: idx + 1,
      parts,
      fromSeconds,
      toSeconds,
      totalSeconds,
      split,
    };
  } catch {
    return null;
  }
}
