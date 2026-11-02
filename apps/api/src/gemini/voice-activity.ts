/**
 * Real-time voice activity detection (VAD) from raw microphone PCM samples.
 *
 * Ingests audio frames and maintains an adaptive energy noise floor to detect
 * candidate speech directly, bypassing delayed or batched transcript arrivals.
 */

const FRAME_MS = 20;

/** How far above the floor a frame must be to count as voice. */
const MARGIN_DB = 12;

/**
 * Below this nothing is voice, however quiet the floor. The same absolute
 * minimum `analyzePcm` uses offline (0.005).
 */
const ABS_MIN_DB = -46;

/** Frames quieter than this are treated as digital silence and do not pull down the noise floor. */
const DIGITAL_SILENCE_DB = -90;

/** How quickly the floor follows a quieter frame down, per frame. */
const FALL_RATE = 0.05;

/**
 * How fast the floor may rise, in dB per second.
 *
 * Slow on purpose. Falling is fast, so a floor that rose into speech is
 * pulled back at the next pause; rising fast would let a long stretch of
 * talking lift the floor into the voice and read the rest of it as silence,
 * which is the one error that makes the watchdog fire on someone mid-answer.
 */
const FLOOR_RISE_DB_PER_S = 1;

const RISE_DB_PER_FRAME = (FLOOR_RISE_DB_PER_S * FRAME_MS) / 1000;

/** Loud time a run needs before it is voice rather than a click or keystroke. */
const MIN_VOICE_MS = 150;

/** Quiet short enough to be inside one run — `analyzePcm`'s `GAP_BRIDGE_MS`. */
const BRIDGE_MS = 300;

/** Quiet long enough to end an utterance rather than sit between two words. */
const UTTERANCE_GAP_MS = 700;

/** How far back `voicedBetween` can see. */
const RUN_HISTORY_MS = 60 * 60_000;

/** A stretch of silence that has just ENDED, in epoch ms. */
export type Silence = { from: number; to: number };

export class VoiceActivity {
  private readonly frameSamples: number;
  /** The noise floor in dB, or null until the first frame that is not digital silence. */
  private floorDb: number | null = null;
  private carry = new Int16Array(0);
  /** Epoch ms the last voiced frame ENDED at. 0 until the first one. */
  private lastVoice = 0;
  /** The loud run in progress: when it began, when its last loud frame ended, how loud-long it is. */
  private runStart = 0;
  private runLastLoud = 0;
  private runLoudMs = 0;
  /** Epoch ms the utterance containing `lastVoice` began. */
  private utteranceStart = 0;
  /** Total ms of voice heard, for "how much have they said since…". */
  private voiced = 0;
  /** Epoch ms of the first frame ever observed, so silence has a start before any voice. */
  private firstFrameAt = 0;
  /** Epoch ms of the latest frame observed, voiced or not. */
  private lastFrameAt = 0;
  /** The voice counted into `voiced`, as merged [start, end] stretches, oldest first. */
  private runs: [number, number][] = [];

  constructor(sampleRate: number) {
    this.frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  }

  /** Whether any audio has been observed at all. Without it the caller has no signal. */
  get heard(): boolean {
    return this.lastFrameAt > 0;
  }

  /** Epoch ms at which the candidate was last heard making a sound. */
  get lastVoiceAt(): number {
    return this.lastVoice || this.firstFrameAt;
  }

  /**
   * How long the candidate has been talking in the utterance heard most
   * recently — from its first voiced run to its last. Enough of it is proof they
   * said something, whether or not a transcript for it ever arrives.
   */
  get utteranceMs(): number {
    return this.lastVoice ? this.lastVoice - this.utteranceStart : 0;
  }

  /** Total voice heard so far, in ms. Differences of it measure how much was said. */
  get voicedMs(): number {
    return this.voiced;
  }

  /** Epoch ms the most recent utterance began. */
  get utteranceStartedAt(): number {
    return this.utteranceStart;
  }

  /**
   * Voice heard inside [from, to], in ms — the same voice `voicedMs` counts.
   * Used to subtract candidate speaking time from stall intervals.
   */
  voicedBetween(from: number, to: number): number {
    let ms = 0;
    for (const [a, b] of this.runs) {
      if (b <= from) continue;
      if (a >= to) break;
      ms += Math.min(b, to) - Math.max(a, from);
    }
    return ms;
  }

  private noteVoiced(start: number, end: number) {
    const last = this.runs.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else this.runs.push([start, end]);
    while (this.runs.length && this.runs[0]![1] < end - RUN_HISTORY_MS) this.runs.shift();
  }


  /**
   * Feeds one chunk of 16-bit little-endian mono PCM that finished arriving at
   * `at`. Returns the silence that voice in this chunk just ended, if any.
   */
  observe(pcm: Buffer, at: number): Silence | null {
    const joined = new Int16Array(this.carry.length + Math.floor(pcm.length / 2));
    joined.set(this.carry, 0);
    for (let i = 0; i < joined.length - this.carry.length; i++) {
      joined[this.carry.length + i] = pcm.readInt16LE(i * 2);
    }

    const frames = Math.floor(joined.length / this.frameSamples);
    this.carry = joined.slice(frames * this.frameSamples);
    if (!frames) return null;

    let ended: Silence | null = null;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const off = f * this.frameSamples;
      for (let i = 0; i < this.frameSamples; i++) {
        const s = joined[off + i]! / 32768;
        sum += s * s;
      }
      const level = sum > 0 ? 10 * Math.log10(sum / this.frameSamples) : -Infinity;
      // The chunk arrived at `at`; its frames are spread over the time before.
      const frameEnd = at - (frames - 1 - f) * FRAME_MS;
      if (!this.firstFrameAt) this.firstFrameAt = frameEnd - FRAME_MS;
      this.lastFrameAt = frameEnd;

      if (level <= DIGITAL_SILENCE_DB) continue;
      if (this.floorDb === null) this.floorDb = level;
      else if (level < this.floorDb) this.floorDb += (level - this.floorDb) * FALL_RATE;
      else this.floorDb += Math.min(level - this.floorDb, RISE_DB_PER_FRAME);

      if (level <= Math.max(this.floorDb + MARGIN_DB, ABS_MIN_DB)) continue;

      const frameStart = frameEnd - FRAME_MS;
      if (!this.runLastLoud || frameStart - this.runLastLoud > BRIDGE_MS) {
        this.runStart = frameStart;
        this.runLoudMs = 0;
      }
      this.runLastLoud = frameEnd;
      this.runLoudMs += FRAME_MS;
      if (this.runLoudMs < MIN_VOICE_MS) continue;
      // The frames that qualified the run were voice too.
      const counted = this.runLoudMs === MIN_VOICE_MS ? MIN_VOICE_MS : FRAME_MS;
      this.voiced += counted;
      this.noteVoiced(frameEnd - counted, frameEnd);

      // Voice. If this run has only just qualified, the silence before it ends
      // where the run BEGAN, not where it qualified.
      if (this.lastVoice < this.runStart) {
        const silentFrom = this.lastVoiceAt;
        const to = this.runStart;
        if (!this.lastVoice || to - this.lastVoice > UTTERANCE_GAP_MS) this.utteranceStart = to;
        // Two can end inside one chunk; the long one is the one anybody asks about.
        if (to - silentFrom >= FRAME_MS && (!ended || to - silentFrom > ended.to - ended.from)) {
          ended = { from: silentFrom, to };
        }
      }
      this.lastVoice = frameEnd;
    }
    return ended;
  }
}
