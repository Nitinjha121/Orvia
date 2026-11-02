/**
 * Captures microphone audio as raw little-endian 16-bit PCM.
 *
 * Runs on the audio thread so capture never stutters when React re-renders —
 * a dropped frame here becomes a swallowed word in the transcript.
 *
 * The graph's AudioContext is created at 16 kHz, so no resampling is needed:
 * we only convert Float32 [-1,1] to Int16 and batch into ~80 ms chunks, which
 * is small enough to keep latency imperceptible and large enough to avoid
 * flooding the WebSocket with tiny frames.
 */
const CHUNK_SAMPLES = 1280; // 80 ms @ 16 kHz

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(CHUNK_SAMPLES);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      if (s > peak) peak = s;
      else if (-s > peak) peak = -s;

      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this.n === CHUNK_SAMPLES) {
        const out = new Int16Array(this.buf);
        this.port.postMessage({ pcm: out, peak }, [out.buffer]);
        this.n = 0;
        peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
