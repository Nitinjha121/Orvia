/**
 * Buffers recent microphone audio that has not yet been transcribed.
 *
 * When a socket drops or reconnects mid-utterance, audio sent while disconnected
 * or uncommitted by the dying socket is preserved and paced to the replacement
 * socket at model-supported replay speeds.
 */

/** Bytes per millisecond of 16 kHz, 16-bit mono PCM. */
const PCM_BYTES_PER_MS = 32;

/** The most audio held. A minute and a half covers any refusal run the backoff tolerates. */
export const BACKLOG_MAX_MS = 90_000;

/**
 * Kept past a transcript's arrival: the transcript covers the utterance that
 * ENDED, and the first moment of the next one can already be in the buffer.
 * Replaying a second too much costs a repeated word; too little, a lost one.
 */
export const COMMIT_OVERLAP_MS = 1_500;

/** Lead-in kept before the first voiced chunk, so a replay does not clip a word's onset. */
const LEAD_IN_MS = 600;

/**
 * Of each pause in a replay that is behind real time, how much is sent. Past
 * the server's end-of-speech silence (1.4s for a round, 1.8s for the coach), so
 * every utterance still commits; the rest is dropped, which is what lets a
 * replay at 1x catch up. Without it, live audio queued behind a minute of
 * replay at real time stays a minute late for the rest of the round.
 */
export const REPLAY_KEEP_SILENCE_MS = 2_000;

/** A chunk waiting to go out, and whether the microphone heard voice in it. */
export type QueuedChunk = { data: string; voiced: boolean };

export const base64PcmMs = (b64: string): number => Math.floor((b64.length * 3) / 4) / PCM_BYTES_PER_MS;

type Entry = { data: string; at: number; ms: number; sent: boolean };

export class MicBacklog {
  private entries: Entry[] = [];
  private totalMs = 0;

  /** A chunk from the microphone; `sent` says whether a socket received it. */
  push(data: string, at: number, sent: boolean) {
    const ms = base64PcmMs(data);
    this.entries.push({ data, at, ms, sent });
    this.totalMs += ms;
    while (this.totalMs > BACKLOG_MAX_MS && this.entries.length > 1) {
      this.totalMs -= this.entries.shift()!.ms;
    }
  }

  /** A transcript arrived: what came before it, less the overlap, is accounted for. */
  committed(now: number) {
    const keepFrom = now - COMMIT_OVERLAP_MS;
    while (this.entries.length && this.entries[0]!.at < keepFrom) {
      this.totalMs -= this.entries.shift()!.ms;
    }
  }

  /** Milliseconds of audio no socket has received. */
  get unsentMs(): number {
    return this.entries.reduce((n, e) => n + (e.sent ? 0 : e.ms), 0);
  }

  get heldMs(): number {
    return this.totalMs;
  }

  /**
   * What a new socket should be given, oldest first, from a little before the
   * first voiced moment — silence before speech is tokens for nothing.
   *
   * `all`: a clean socket, which has heard none of it. `unsent`: a resumed one,
   * which restores what the old socket received and needs only what arrived
   * while there was no socket.
   */
  takeForReplay(voicedBetween: (from: number, to: number) => number, which: 'all' | 'unsent'): QueuedChunk[] {
    const pool = which === 'all' ? this.entries : this.entries.filter((e) => !e.sent);
    const voiced = pool.map((e) => voicedBetween(e.at - e.ms, e.at) > 0);
    const first = voiced.indexOf(true);
    for (const e of this.entries) e.sent = true;
    if (first === -1) return [];
    const startAt = pool[first]!.at - pool[first]!.ms - LEAD_IN_MS;
    return pool
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => i >= first || e.at >= startAt)
      .map(({ e, i }) => ({ data: e.data, voiced: voiced[i]! }));
  }

  clear() {
    this.entries = [];
    this.totalMs = 0;
  }
}
