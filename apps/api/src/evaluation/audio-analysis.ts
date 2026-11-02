import { readFile } from 'node:fs/promises';

export type SpeechRun = { startMs: number; endMs: number };

export type AudioAnalysis = {
  /** Wall-clock length of the recording. */
  totalMs: number;
  /** Time actually containing speech, excluding silence. */
  voicedMs: number;
  /** Longest continuous silence inside the recording. */
  longestSilenceMs: number;
  /** Number of distinct speech runs — a proxy for how choppy delivery was. */
  segments: number;
  /**
   * Ordered speech run intervals.
   * Derived from waveform energy so latency calculations measure actual speech
   * onset rather than delayed transcript arrival times.
   */
  runs: SpeechRun[];
};

const FRAME_MS = 20;
/** Silence shorter than this is a breath, not a pause worth reporting. */
const MIN_SILENCE_MS = 400;
/** Speech runs shorter than this are clicks and lip noise. */
const MIN_SPEECH_MS = 100;
/**
 * Gaps shorter than this are bridged into continuous speech so inter-word pauses
 * and unvoiced consonants do not artificially inflate words-per-minute estimates.
 */
const GAP_BRIDGE_MS = 300;

/**
 * Measures candidate speaking duration and speech intervals directly from WAV audio
 * using energy-based voice activity detection, avoiding distorted metrics from bursty
 * transcript arrivals.
 */
export async function analyzeWav(path: string): Promise<AudioAnalysis | null> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  if (buf.length < 44) return null;

  // Minimal RIFF parse — we wrote this file ourselves, so the layout is known,
  // but read the rate rather than assuming it.
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16 || sampleRate <= 0) return null;

  // A view, not a copy — a long round is 50MB+. Int16Array needs an even
  // offset, which a pooled Buffer does not promise, so copy only then.
  const count = Math.floor((buf.length - 44) / 2);
  const start = buf.byteOffset + 44;
  const samples =
    start % 2 === 0
      ? new Int16Array(buf.buffer, start, count)
      : new Int16Array(buf.buffer.slice(start, start + count * 2));
  return analyzePcm(samples, sampleRate);
}

/**
 * The same measurement over raw samples, for callers holding PCM rather than a
 * file — notably the re-transcription pass, which needs to know whether a
 * segment it just sent actually contained any speech.
 */
export function analyzePcm(samples: Int16Array, sampleRate: number): AudioAnalysis | null {
  if (samples.length === 0 || sampleRate <= 0) return null;

  const frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const rms: number[] = [];
  for (let i = 0; i + frameSamples <= samples.length; i += frameSamples) {
    let sum = 0;
    for (let j = 0; j < frameSamples; j++) {
      const s = samples[i + j]! / 32768;
      sum += s * s;
    }
    rms.push(Math.sqrt(sum / frameSamples));
  }
  if (rms.length === 0) return null;

  // Adaptive threshold: the noise floor is taken from the quietest decile, and
  // speech is anything meaningfully above it. A fixed threshold fails on both
  // quiet microphones and noisy rooms.
  const sorted = [...rms].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const threshold = Math.max(noiseFloor * 3, peak * 0.08, 0.005);

  const voiced = rms.map((r) => r > threshold);

  // Bridge short gaps between speech runs, so inter-word pauses and unvoiced
  // consonants count as part of speaking rather than as silence.
  const bridgeFrames = Math.round(GAP_BRIDGE_MS / FRAME_MS);
  let gapStart = -1;
  for (let i = 0; i < voiced.length; i++) {
    if (voiced[i]) {
      if (gapStart > 0 && i - gapStart <= bridgeFrames) {
        for (let j = gapStart; j < i; j++) voiced[j] = true;
      }
      gapStart = -1;
    } else if (gapStart === -1) {
      gapStart = i;
    }
  }

  let voicedFrames = 0;
  let longestSilenceFrames = 0;
  let runSilence = 0;
  let runSpeech = 0;
  let segments = 0;
  const minSpeechFrames = Math.round(MIN_SPEECH_MS / FRAME_MS);
  const minSilenceFrames = Math.round(MIN_SILENCE_MS / FRAME_MS);
  const runs: SpeechRun[] = [];
  /** Frame index the current speech run began at, for `runs`. */
  let speechStart = -1;

  for (let i = 0; i < voiced.length; i++) {
    const v = voiced[i];
    if (v) {
      voicedFrames++;
      if (runSpeech === 0) speechStart = i;
      runSpeech++;
      if (runSilence >= minSilenceFrames) longestSilenceFrames = Math.max(longestSilenceFrames, runSilence);
      runSilence = 0;
    } else {
      if (runSpeech >= minSpeechFrames) {
        segments++;
        runs.push({ startMs: speechStart * FRAME_MS, endMs: i * FRAME_MS });
      }
      runSpeech = 0;
      runSilence++;
    }
  }
  if (runSpeech >= minSpeechFrames) {
    segments++;
    runs.push({ startMs: speechStart * FRAME_MS, endMs: voiced.length * FRAME_MS });
  }
  // Trailing silence is padding the harness/browser added, not a pause the
  // candidate took — only count it if speech follows, which it does not here.

  return {
    totalMs: Math.round((samples.length / sampleRate) * 1000),
    voicedMs: voicedFrames * FRAME_MS,
    longestSilenceMs: longestSilenceFrames * FRAME_MS,
    segments,
    runs,
  };
}
