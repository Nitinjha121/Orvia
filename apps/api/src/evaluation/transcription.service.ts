import { Injectable, Inject, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { GoogleGenAI, Modality, AudioTranscriptionConfigMode } from '@google/genai';
import { AUDIO, MODELS } from '@orvia/shared';
import { ENV, type Env } from '../config/env';
import { expire } from '../common/expire';
import { analyzePcm } from './audio-analysis';

/**
 * Post-session re-transcription service.
 * Streams candidate audio in bounded, retried segments through `MODELS.transcriber`
 * to produce accurate verbatim transcripts and verify complete audio coverage.
 */
const MODEL = MODELS.transcriber;

/** 100ms of audio per frame. */
const CHUNK_BYTES = AUDIO.inputSampleRate * 2 * 0.1;
/**
 * Wall-clock gap between audio frames (~3.3x real-time streaming).
 * Balances streaming throughput while staying within model ingestion rate limits
 * to prevent dropped speech.
 */
const SEND_INTERVAL_MS = 30;
/**
 * Audio duration per segment. Segmenting long recordings limits connection
 * lifetimes and bounds retry costs to individual segments rather than whole files.
 */
const SEGMENT_SECONDS = 120;
/** Attempts per segment before giving up on complete coverage. */
const SEGMENT_ATTEMPTS = 3;
/** Pause before a retry, grown per attempt, so a retry is not the same instant's failure. */
const SEGMENT_RETRY_BACKOFF_MS = 2000;
/** How long to wait for trailing transcription after a segment ends. */
const DRAIN_MS = 15_000;

/**
 * Timeout ceiling on the WebSocket connection handshake to prevent pending
 * connection hangs when the socket closes or fails during setup.
 */
const CONNECT_TIMEOUT_MS = 30_000;
/**
 * Multiple of an attempt's theoretical cost before the whole attempt is called
 * hung. This is a BACKSTOP: the handshake ceiling above closes the hole that was
 * actually measured, and this one bounds the holes that have not been. Every
 * step in `transcribeSegment` is individually bounded, so this firing means a
 * new unbounded await has appeared upstream — which is invisible until a report
 * never arrives, so it is logged loudly rather than silently retried.
 */
const ATTEMPT_SLACK = 2;
/** Distinguishes "the deadline fired" from a segment's own null (a clean failure). */
const TIMED_OUT = Symbol('timed out');

/**
 * Verifies that empty transcripts correspond to genuinely quiet audio.
 * If a segment with significant measured speech yields an empty transcript,
 * it is treated as a transcription dropout and retried.
 */

/** Below this much measured speech, a segment returning nothing is believable. */
const SILENT_SEGMENT_MS = 3000;
/**
 * Words per second of VOICED audio, below which a transcript is not a
 * transcript of this segment. Normal speech measures 2-3; the failures measured
 * 0 to 0.4. Deliberately far below the healthy range so slow speech and
 * ordinary ASR losses are never flagged.
 */
const MIN_WORDS_PER_VOICED_SECOND = 0.5;
/** Only apply the sparseness rule to segments with enough speech to judge. */
const SPARSENESS_MIN_VOICED_MS = 20_000;

/**
 * Differentiates ambient non-speech noise from actual speech. If the live transcript
 * corroborates that the candidate did not speak in a window and voiced energy is low,
 * an empty transcript is accepted as true silence rather than a dropout.
 */
const CORROBORATED_SILENCE_MAX_VOICED_MS = 20_000;
/** Slack around a live candidate turn: its stamps follow transcription, not the voice. */
const LIVE_TURN_MARGIN_MS = 15_000;

/** A window, in recording milliseconds, in which the live ASR heard the candidate. */
export type HeardWindow = { startMs: number; endMs: number | null };

const BYTES_PER_SECOND = AUDIO.inputSampleRate * AUDIO.bytesPerSample;

const clock = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Transcribed segment covering a fixed audio window.
 * Byte-offset boundaries provide coarse time ranges for quoting and audio seeking.
 */
export type VerbatimSegment = { startMs: number; endMs: number; text: string };

export type VerbatimResult = {
  text: string;
  model: string;
  /** Per-segment text with its time window, in order. */
  segments: VerbatimSegment[];
  /**
   * True only when every segment of the recording was streamed in full and
   * acknowledged. When false the text is a fragment and MUST NOT be used for
   * anything counted — see `computeSpeechMetrics`.
   */
  complete: boolean;
  /** Seconds of audio in the recording, for reporting coverage. */
  audioSeconds: number;
  /**
   * Identifies which segment failed and the cause when `complete` is false,
   * retained for diagnostics on incomplete evaluations.
   */
  failure: string | null;
};

@Injectable()
export class TranscriptionService {
  private readonly log = new Logger(TranscriptionService.name);
  private readonly ai: GoogleGenAI;

  constructor(@Inject(ENV) env: Env) {
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }

  /**
   * Returns a verbatim transcript of the candidate's recording, or null if the
   * pass fails outright. Failure is never fatal — the report falls back to the
   * live transcript, which is serviceable, just less accurate.
   *
   * `heard` is where the live transcript has the candidate speaking; without
   * it, no empty segment over SILENT_SEGMENT_MS of energy is believed.
   */
  async transcribe(wavPath: string, heard?: HeardWindow[]): Promise<VerbatimResult | null> {
    let pcm: Buffer;
    try {
      const wav = await readFile(wavPath);
      if (wav.length <= 44) return null;
      pcm = wav.subarray(44); // strip the RIFF header we wrote
    } catch {
      return null;
    }

    const started = Date.now();
    const audioSeconds = pcm.length / BYTES_PER_SECOND;
    const segmentBytes = SEGMENT_SECONDS * BYTES_PER_SECOND;
    const segmentCount = Math.ceil(pcm.length / segmentBytes);

    const parts: string[] = [];
    const segments: VerbatimSegment[] = [];
    let complete = true;
    let failure: string | null = null;

    for (let i = 0; i < segmentCount; i++) {
      const segment = pcm.subarray(i * segmentBytes, Math.min((i + 1) * segmentBytes, pcm.length));
      const label = `segment ${i + 1}/${segmentCount}`;

      let text: string | null = null;
      let lastProblem = 'the transcription socket failed or closed early';
      for (let attempt = 1; attempt <= SEGMENT_ATTEMPTS && text === null; attempt++) {
        if (attempt > 1) await this.wait(SEGMENT_RETRY_BACKOFF_MS * (attempt - 1));
        const got = await this.attempt(segment, `${label} attempt ${attempt}`);
        if (got === null) {
          lastProblem = 'the transcription socket failed or closed early';
          continue;
        }

        const window = { startMs: i * SEGMENT_SECONDS * 1000, endMs: (i + 1) * SEGMENT_SECONDS * 1000 };
        const problem = this.implausible(segment, got, heard && { window, heard }, label);
        if (problem) {
          this.log.warn(`${label} attempt ${attempt}: ${problem} — retrying`);
          lastProblem = problem;
          continue;
        }
        text = got;
      }

      if (text === null) {
        // Coverage is broken from here on. Keep what we have for logging, but
        // the result is explicitly incomplete and callers must not count it.
        this.log.error(`${label} failed after ${SEGMENT_ATTEMPTS} attempts — coverage incomplete`);
        complete = false;
        failure =
          `${label} (${clock(i * SEGMENT_SECONDS)}–${clock(Math.min((i + 1) * SEGMENT_SECONDS, audioSeconds))}) ` +
          `failed ${SEGMENT_ATTEMPTS} attempts: ${lastProblem}`;
        break;
      }
      parts.push(text);
      segments.push({
        startMs: i * SEGMENT_SECONDS * 1000,
        endMs: Math.min((i + 1) * SEGMENT_SECONDS * 1000, Math.round(audioSeconds * 1000)),
        text,
      });
      this.log.log(`${label} transcribed (${text.split(/\s+/).filter(Boolean).length} words)`);
    }

    const clean = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    this.log.log(
      `re-transcribed ${audioSeconds.toFixed(0)}s of audio across ${segmentCount} segment(s) ` +
        `in ${((Date.now() - started) / 1000).toFixed(0)}s ` +
        `(${clean.split(/\s+/).length} words, ${complete ? 'complete' : 'INCOMPLETE'})`,
    );
    return { text: clean, model: MODEL, segments, complete, audioSeconds, failure };
  }

  /** See `common/expire.ts` — shared with the interview session's handshake. */
  private expire = expire;

  private wait(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  /**
   * Executes a segment transcription attempt under a calculated wall-clock deadline
   * derived from expected frame transfer and drain times to prevent unbounded stalls.
   */
  private async attempt(pcm: Buffer, label: string): Promise<string | null> {
    const frames = Math.ceil(pcm.length / CHUNK_BYTES);
    const budget = CONNECT_TIMEOUT_MS + (frames * SEND_INTERVAL_MS + DRAIN_MS) * ATTEMPT_SLACK;

    const running = this.transcribeSegment(pcm, label);
    running.catch(() => {});
    const deadline = this.expire(budget, TIMED_OUT);
    const got = await Promise.race([running, deadline.promise]);
    deadline.cancel();

    if (got === TIMED_OUT) {
      this.log.error(
        `${label}: still running after ${(budget / 1000).toFixed(0)}s — ${ATTEMPT_SLACK}x what it ` +
          `should cost — so abandoning it. Every step here is bounded by design; this is a bug, ` +
          `not a slow network.`,
      );
      return null;
    }
    return got;
  }

  /**
   * Checks a segment's transcript against the segment's own waveform.
   *
   * Returns a description of the problem, or null when the result is
   * believable. This is the only thing standing between an intermittently
   * broken upstream and a report written from a quarter of the round.
   */
  private implausible(
    pcm: Buffer,
    text: string,
    live?: { window: { startMs: number; endMs: number }; heard: HeardWindow[] },
    label = 'segment',
  ): string | null {
    // Even-length, offset-zero copy: Int16Array cannot view a Buffer at an odd
    // byte offset, and pooled Buffers frequently sit at one.
    const count = Math.floor(pcm.length / 2);
    if (count === 0) return null;
    const bytes = Uint8Array.prototype.slice.call(pcm, 0, count * 2);
    const analysis = analyzePcm(new Int16Array(bytes.buffer, bytes.byteOffset, count), AUDIO.inputSampleRate);
    if (!analysis) return null;

    const voicedMs = analysis.voicedMs;
    const words = text.split(/\s+/).filter(Boolean).length;
    const voicedSeconds = voicedMs / 1000;

    if (!words) {
      if (voicedMs < SILENT_SEGMENT_MS) return null;
      if (live && voicedMs < CORROBORATED_SILENCE_MAX_VOICED_MS) {
        const { startMs, endMs } = live.window;
        const overlaps = live.heard.some(
          (h) =>
            h.startMs - LIVE_TURN_MARGIN_MS < endMs &&
            (h.endMs ?? h.startMs) + LIVE_TURN_MARGIN_MS > startMs,
        );
        if (!overlaps) {
          this.log.log(
            `${label}: no transcript for ${voicedSeconds.toFixed(0)}s of measured sound, and the live ` +
              `transcript heard no candidate turn here either — accepted as silence`,
          );
          return null;
        }
      }
      return `returned no transcript for ${voicedSeconds.toFixed(0)}s of measured speech`;
    }

    if (voicedMs >= SPARSENESS_MIN_VOICED_MS && words < voicedSeconds * MIN_WORDS_PER_VOICED_SECOND) {
      return (
        `returned ${words} words for ${voicedSeconds.toFixed(0)}s of measured speech ` +
        `(${(words / voicedSeconds).toFixed(2)} words per voiced second, floor is ` +
        `${MIN_WORDS_PER_VOICED_SECOND})`
      );
    }
    return null;
  }

  /**
   * Streams one segment through a dedicated socket.
   *
   * Returns the transcript, or null if the socket closed before every frame
   * had been sent — an early close is a failure, never a short answer. An
   * empty string is a legitimate result: a segment can be pure silence.
   */
  private async transcribeSegment(pcm: Buffer, label: string): Promise<string | null> {
    let text = '';
    let closed = false;
    let sentBytes = 0;
    let session: { close(): void } | null = null;

    try {
      /**
       * Deliberately not awaited on its own line — see CONNECT_TIMEOUT_MS. The
       * rejection handler goes on immediately so that a connect which fails
       * AFTER the race below has given up cannot surface as an unhandled
       * rejection and take the process down. Attaching it here still leaves the
       * rejection visible to the race, so a fast failure keeps failing fast.
       */
      const connecting = this.ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            // VERBATIM keeps the fillers, stutters and false starts that the
            // whole delivery analysis is built on.
            mode: AudioTranscriptionConfigMode.VERBATIM,
            languageCodes: ['en-US'],
          },
        },
        callbacks: {
          onopen: () => {},
          onmessage: (m) => {
            const t = m.serverContent?.inputTranscription?.text;
            if (t) text += t;
          },
          onerror: (e: { message?: string }) =>
            this.log.warn(`${label}: socket error: ${e?.message}`),
          onclose: () => {
            closed = true;
          },
        },
      });
      connecting.catch(() => {});

      const handshake = this.expire<null>(CONNECT_TIMEOUT_MS, null);
      const live = await Promise.race([connecting, handshake.promise]);
      handshake.cancel();

      if (!live) {
        this.log.warn(
          `${label}: handshake did not complete within ${CONNECT_TIMEOUT_MS / 1000}s — ` +
            `abandoning this attempt`,
        );
        // Should it open eventually, close it. A socket nobody is reading from
        // would otherwise stay up for the rest of the pass.
        void connecting.then((s) => s.close()).catch(() => {});
        return null;
      }

      session = live;

      for (let off = 0; off < pcm.length && !closed; off += CHUNK_BYTES) {
        const frame = pcm.subarray(off, off + CHUNK_BYTES);
        live.sendRealtimeInput({
          audio: { data: frame.toString('base64'), mimeType: AUDIO.inputMimeType },
        });
        sentBytes += frame.length;
        await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
      }

      if (closed) {
        this.log.warn(
          `${label}: upstream closed after ${(sentBytes / BYTES_PER_SECOND).toFixed(0)}s of ` +
            `${(pcm.length / BYTES_PER_SECOND).toFixed(0)}s — discarding the partial result`,
        );
        return null;
      }

      live.sendRealtimeInput({ audioStreamEnd: true });

      // Wait for the tail, but stop early once transcription goes quiet rather
      // than always burning the full drain window.
      let lastLen = -1;
      let quietFor = 0;
      const deadline = Date.now() + DRAIN_MS;
      while (Date.now() < deadline && quietFor < 3000) {
        await new Promise((r) => setTimeout(r, 500));
        if (text.length === lastLen) quietFor += 500;
        else {
          quietFor = 0;
          lastLen = text.length;
        }
      }
    } catch (e) {
      this.log.warn(`${label}: failed: ${(e as Error).message}`);
      return null;
    } finally {
      // Every exit, including a throw mid-send: an unclosed socket stays up for
      // the rest of the pass.
      try {
        session?.close();
      } catch {
        /* already closed */
      }
    }

    return text.trim();
  }
}
