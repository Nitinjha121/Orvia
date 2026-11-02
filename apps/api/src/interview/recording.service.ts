import { Injectable, Inject, Logger } from '@nestjs/common';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { AUDIO } from '@orvia/shared';
import { ENV, type Env } from '../config/env';
import { APP_ROOT } from '../config/paths';

/**
 * One open capture. `failed` is set by the stream's 'error' event: an unheard
 * 'error' on a WriteStream (disk full, directory removed) throws and kills the
 * process — and every other live round with it.
 */
type Track = { stream: WriteStream; bytes: number; bytesPerSecond: number; failed?: boolean };

/**
 * Persists the candidate's microphone — the artefact delivery scoring exists
 * for, since hesitation and pace live in the waveform and nowhere else — and
 * the interviewer's voice for playback. Chunks go to a headerless `.pcm` and are
 * wrapped as WAV at the end, when the length the header needs is known.
 */
@Injectable()
export class RecordingService {
  private readonly log = new Logger(RecordingService.name);
  /** Candidate microphone, 16kHz — the artefact the evaluator is given. */
  private readonly streams = new Map<string, Track>();
  /** Interviewer voice, 24kHz — playback only, never scored. */
  private readonly aiStreams = new Map<string, Track>();
  private readonly dir: string;

  constructor(@Inject(ENV) env: Env) {
    this.dir = resolve(APP_ROOT, env.DATA_DIR, 'audio');
  }

  async begin(sessionId: string) {
    await mkdir(this.dir, { recursive: true });
    this.streams.set(sessionId, this.open(sessionId, `${sessionId}.pcm`, AUDIO.inputSampleRate, 'candidate'));
    this.aiStreams.set(sessionId, this.open(sessionId, `${sessionId}.ai.pcm`, AUDIO.outputSampleRate, 'interviewer'));
  }

  private open(sessionId: string, file: string, sampleRate: number, label: string): Track {
    const track: Track = {
      stream: createWriteStream(join(this.dir, file)),
      bytes: 0,
      bytesPerSecond: sampleRate * AUDIO.bytesPerSample,
    };
    track.stream.on('error', (err) => {
      if (!track.failed) {
        this.log.error(`session ${sessionId}: ${label} recording failed after ${track.bytes} bytes: ${err.message}`);
      }
      track.failed = true;
    });
    return track;
  }

  /**
   * Writes a chunk at its position in the round, padding with silence up to `atMs`
   * so both tracks stay synchronized to session offsets.
   */
  private writeAt(track: Track | undefined, base64Pcm: string, atMs: number) {
    if (!track || track.failed) return;
    const target = Math.floor((atMs / 1000) * track.bytesPerSecond) & ~1; // even: 16-bit frames
    if (target > track.bytes) {
      const gap = Buffer.alloc(target - track.bytes); // zeroed = silence
      track.stream.write(gap);
      track.bytes += gap.length;
    }
    const buf = Buffer.from(base64Pcm, 'base64');
    track.stream.write(buf);
    track.bytes += buf.length;
  }

  /** Candidate microphone. */
  append(sessionId: string, base64Pcm: string, atMs: number) {
    this.writeAt(this.streams.get(sessionId), base64Pcm, atMs);
  }

  /**
   * Interviewer voice track for playback. Kept in a separate file so the
   * evaluator receives the candidate audio alone for delivery scoring.
   */
  appendAi(sessionId: string, base64Pcm: string, atMs: number) {
    this.writeAt(this.aiStreams.get(sessionId), base64Pcm, atMs);
  }

  /**
   * Closes both raw streams and emits playable WAVs.
   *
   * The candidate's file is the one everything downstream depends on; the
   * interviewer's is optional and its absence must never fail a round.
   */
  async finalize(sessionId: string): Promise<{ audioPath?: string; aiAudioPath?: string }> {
    const audioPath = await this.closeTrack(
      sessionId, this.streams, `${sessionId}`, AUDIO.inputSampleRate, 'candidate',
    );
    const aiAudioPath = await this.closeTrack(
      sessionId, this.aiStreams, `${sessionId}.ai`, AUDIO.outputSampleRate, 'interviewer',
    );
    return { audioPath, aiAudioPath };
  }

  /**
   * Wraps a session's orphaned `.pcm` files in WAV containers if a process
   * ended unexpectedly before `finalize`. Refuses sessions currently being
   * recorded in this process.
   */
  async salvage(sessionId: string): Promise<{ audioPath?: string; aiAudioPath?: string; durationMs: number }> {
    if (this.streams.has(sessionId) || this.aiStreams.has(sessionId)) {
      throw new Error(`session ${sessionId} is still recording in this process`);
    }
    const mic = await this.wrapPcm(sessionId, `${sessionId}`, AUDIO.inputSampleRate, 'candidate');
    const ai = await this.wrapPcm(sessionId, `${sessionId}.ai`, AUDIO.outputSampleRate, 'interviewer');
    return {
      audioPath: mic?.path,
      aiAudioPath: ai?.path,
      // Both tracks are padded to their offset in the round, so the longer one
      // IS the round's length as recorded — the only honest duration available
      // once the process that knew the real one is gone.
      durationMs: Math.round(1000 * Math.max(mic?.seconds ?? 0, ai?.seconds ?? 0)),
    };
  }

  /** Flushes one track's `.pcm` and wraps it in a WAV container. */
  private async closeTrack(
    sessionId: string,
    from: Map<string, Track>,
    base: string,
    sampleRate: number,
    label: string,
  ): Promise<string | undefined> {
    const track = from.get(sessionId);
    if (!track) return undefined;
    from.delete(sessionId);

    // `finished` also settles for a stream that already errored, where an
    // `end` callback can wait for a 'finish' that never comes. Whatever reached
    // disk before a failure is still wrapped: part of a recording beats none.
    track.stream.end();
    await finished(track.stream).catch(() => undefined);

    return (await this.wrapPcm(sessionId, base, sampleRate, label))?.path;
  }

  /**
   * Turns `<base>.pcm` into `<base>.wav` and deletes the raw file.
   *
   * Shared by the normal close and by orphan salvage, so a recovered recording
   * is byte-identical to one that ended cleanly rather than a second,
   * almost-right implementation of the same header.
   */
  private async wrapPcm(
    sessionId: string,
    base: string,
    sampleRate: number,
    label: string,
  ): Promise<{ path: string; seconds: number } | undefined> {
    const pcmPath = join(this.dir, `${base}.pcm`);
    const wavPath = join(this.dir, `${base}.wav`);

    let size: number;
    try {
      size = (await stat(pcmPath)).size;
    } catch {
      return undefined;
    }
    if (size === 0) {
      await rm(pcmPath, { force: true });
      this.log.warn(`session ${sessionId}: no ${label} audio captured`);
      return undefined;
    }

    const header = wavHeader(size, sampleRate, 1, 8 * AUDIO.bytesPerSample);
    const src = await open(pcmPath, 'r');
    const dst = await open(wavPath, 'w');
    try {
      await dst.write(header);
      const buf = Buffer.alloc(1 << 16);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        await dst.write(buf, 0, bytesRead);
        pos += bytesRead;
      }
    } finally {
      await src.close();
      await dst.close();
    }
    await rm(pcmPath, { force: true });

    const seconds = size / (sampleRate * AUDIO.bytesPerSample);
    this.log.log(`session ${sessionId}: wrote ${seconds.toFixed(1)}s of ${label} audio -> ${wavPath}`);
    return { path: wavPath, seconds };
  }

  /**
   * Cleanup for a session that never produced usable audio. `finalize` already
   * deletes a zero-length capture, so failure paths route through the same
   * code as success rather than growing their own half-correct variant.
   */
  async abort(sessionId: string) {
    await this.finalize(sessionId).catch(() => undefined);
  }
}

/** Canonical 44-byte RIFF/WAVE header for uncompressed PCM. */
export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const b = Buffer.alloc(44);

  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); // PCM chunk size
  b.writeUInt16LE(1, 20); // format = PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}
