import { AUDIO } from '@orvia/shared';
import { micErrorMessage } from '../lib/micError';

export type MicHandlers = {
  /** base64 of raw little-endian 16-bit PCM @ 16 kHz. */
  onChunk: (base64: string) => void;
  /** 0..1 peak amplitude, for the level meter. */
  onLevel?: (peak: number) => void;
  /** The device went away and getting it back failed; `reacquire` may still succeed later. */
  onLost?: () => void;
  /** Capture is running again after `onLost`. */
  onRestored?: () => void;
};

/** `getUserMedia` failed; `message` is already worded for the candidate. */
export class MicUnavailableError extends Error {}

const CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    // Browser DSP genuinely helps here: it strips room noise and typing
    // that would otherwise trip the model's voice activity detection.
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

async function acquire(): Promise<MediaStream> {
  // Absent outright, not rejected, on a page that is not a secure context.
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicUnavailableError(micErrorMessage({ name: 'SecurityError' }));
  }
  try {
    return await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  } catch (err) {
    throw new MicUnavailableError(micErrorMessage(err as Error));
  }
}

/**
 * Microphone capture at exactly the rate the Live API expects.
 *
 * The AudioContext is constructed at 16 kHz so the browser's own resampler
 * does the downconversion in native code. Resampling in JS is both slower and
 * measurably worse, and ASR accuracy is what everything downstream depends on.
 */
export class MicCapture {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private handlers?: MicHandlers;
  private muted = false;
  private lost = false;
  private reacquiring?: Promise<boolean>;
  private readonly onTrackEnded = () => void this.recover();
  private readonly onDeviceChange = () => {
    if (this.lost) void this.reacquire();
  };

  /** Replaces any capture already running, so a second start never leaves a stream open. */
  async start(handlers: MicHandlers) {
    await this.stop();
    this.stream = await acquire();
    this.handlers = handlers;

    this.ctx = new AudioContext({ sampleRate: AUDIO.inputSampleRate });
    await this.ctx.audioWorklet.addModule('/worklets/pcm-recorder.js');

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder');

    this.node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; peak: number }>) => {
      handlers.onChunk(toBase64(e.data.pcm));
      handlers.onLevel?.(e.data.peak);
    };

    this.source.connect(this.node);
    // The worklet emits nothing downstream, but Chrome will not schedule a
    // node that is not connected to the destination.
    this.node.connect(this.ctx.destination);

    // Watched only once there is a graph to swap a new device into; a track
    // that ended while the worklet loaded is recovered here instead.
    this.watch(this.stream);
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    if (this.stream.getAudioTracks().some((t) => t.readyState === 'ended')) void this.recover();
  }

  /**
   * Stops capturing without tearing the stream down so resuming is instant.
   * Disabling the track causes the device to deliver silence.
   */
  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  /**
   * Handles ended audio tracks (e.g. disconnected devices).
   * Attempts to reacquire the default microphone before marking capture as lost.
   */
  private async recover() {
    const ctx = this.ctx;
    if (!(await this.reacquire()) && ctx && this.ctx === ctx) {
      this.lost = true;
      this.handlers?.onLost?.();
    }
  }

  /**
   * Opens the default microphone again and swaps it in under the SAME worklet,
   * so the socket, the context and the chunk stream never notice. On failure
   * the dead source stays connected: its silence keeps the recording's length
   * equal to the wall clock every turn offset is measured in.
   */
  reacquire(): Promise<boolean> {
    this.reacquiring ??= this.swapStream().finally(() => (this.reacquiring = undefined));
    return this.reacquiring;
  }

  private async swapStream(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx || !this.node) return false;
    let stream: MediaStream;
    try {
      stream = await acquire();
    } catch {
      return false;
    }
    // `stop()` ran while the prompt or the device was opening.
    if (this.ctx !== ctx || !this.node) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    const old = this.stream;
    this.source?.disconnect();
    if (old) this.unwatch(old);
    old?.getTracks().forEach((t) => t.stop());

    this.stream = stream;
    stream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.watch(stream);
    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(this.node);
    if (this.lost) {
      this.lost = false;
      this.handlers?.onRestored?.();
    }
    return true;
  }

  private watch(stream: MediaStream) {
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', this.onTrackEnded));
  }

  private unwatch(stream: MediaStream) {
    stream.getAudioTracks().forEach((t) => t.removeEventListener('ended', this.onTrackEnded));
  }

  async stop() {
    const { ctx, stream, node, source } = this;
    this.ctx = this.stream = this.node = this.source = this.handlers = undefined;
    this.lost = this.muted = false;
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    if (stream) this.unwatch(stream);
    node?.port.close();
    node?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  }
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  const CHUNK = 0x8000; // avoids blowing the argument limit on long buffers
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
