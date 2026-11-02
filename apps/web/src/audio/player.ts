import { AUDIO } from '@orvia/shared';

/**
 * Gap-free playback of the interviewer's voice.
 * Schedules PCM buffers against a cursor to prevent seams and resets on interruption.
 */
export class PcmPlayer {
  private ctx?: AudioContext;
  private gain?: GainNode;
  private cursor = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /** Small lead so scheduling jitter never causes an underrun. */
  private static readonly LEAD_SECONDS = 0.08;

  async ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ sampleRate: AUDIO.outputSampleRate });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.cursor = this.ctx.currentTime + PcmPlayer.LEAD_SECONDS;
  }

  /** base64 of raw little-endian 16-bit PCM @ 24 kHz. */
  enqueue(base64: string) {
    if (!this.ctx || !this.gain) return;

    const pcm = fromBase64(base64);
    if (pcm.length === 0) return;

    const buffer = this.ctx.createBuffer(1, pcm.length, AUDIO.outputSampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 0x8000;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);

    // If playback fell behind (tab throttling, a network stall), jump the
    // cursor forward rather than queueing audio that is already late.
    const startAt = Math.max(this.cursor, this.ctx.currentTime + 0.01);
    src.start(startAt);
    this.cursor = startAt + buffer.duration;

    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /**
   * Pauses output without discarding queued audio.
   * Suspending the context maintains cursor alignment so playback resumes smoothly.
   */
  async setPaused(paused: boolean) {
    if (!this.ctx) return;
    if (paused) await this.ctx.suspend();
    else await this.ctx.resume();
  }

  /** Barge-in: kill everything queued, immediately. */
  interrupt() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    if (this.ctx) this.cursor = this.ctx.currentTime + PcmPlayer.LEAD_SECONDS;
  }

  /** Seconds of audio still queued — drives the "AI is speaking" indicator. */
  get pendingSeconds() {
    if (!this.ctx) return 0;
    return Math.max(0, this.cursor - this.ctx.currentTime);
  }

  async close() {
    this.interrupt();
    const ctx = this.ctx;
    this.ctx = this.gain = undefined;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  }
}

function fromBase64(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // The byte length is always even (16-bit samples), but guard anyway so a
  // truncated frame degrades instead of throwing.
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}
