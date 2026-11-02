/**
 * Monitors whether the upstream server is still processing audio input.
 *
 * If the server stops transcribing microphone audio while still responding to
 * injected text messages, standard stall watchdogs will not detect the issue.
 * This class tracks commit points (substantial voice followed by a pause) and
 * flags the session as deaf when multiple consecutive utterances produce no
 * input transcriptions.
 */

import type { Silence } from './voice-activity';

/** A pause long enough that the server's VAD has certainly ended the utterance. */
export const DEAF_PAUSE_MS = 3_000;

/** Less voice than this is a cough or an "mm", which the server may rightly drop. */
export const DEAF_MIN_VOICE_MS = 1_000;

/** How long after a pause begins its transcript may take to arrive. */
export const DEAF_COMMIT_WAIT_MS = 8_000;

/** Consecutive missed commit points that mean deaf. */
export const DEAF_MISSED_COMMITS = 4;

/** Voice this close after the interviewer's playback may be its own echo. */
const PLAYBACK_SLACK_MS = 500;

export type VoiceReading = {
  /** Epoch ms of the last voiced frame. */
  lastVoiceAt: number;
  /** See `VoiceActivity.voicedBetween`. */
  voicedBetween: (from: number, to: number) => number;
};

type CommitPoint = { startedAt: number; endedAt: number; voicedMs: number };

export class InputLiveness {
  private lastHeardAt = 0;
  /** Where the last commit point's voice ended; the next one is measured from here. */
  private lastPointEnd = 0;
  private pending: CommitPoint | null = null;
  private missed: CommitPoint[] = [];

  /** Any input transcription arrived, interim or final. */
  heard(at: number) {
    this.lastHeardAt = at;
    this.pending = null;
    this.missed = [];
  }

  /**
   * A clean upstream socket. It has had no chance to miss anything, and what
   * was said to the old one is not its to answer.
   */
  reset(at: number) {
    this.heard(at);
    this.lastPointEnd = at;
  }

  /**
   * A socket resumed from a handle retains session state. Only voice occurring
   * after resumption is measured so disconnected intervals are not counted.
   */
  resumed(at: number) {
    this.pending = null;
    this.lastPointEnd = Math.max(this.lastPointEnd, at);
  }

  /** Whether the server has missed enough commit points in a row to be deaf. */
  get deaf(): boolean {
    return this.missed.length >= DEAF_MISSED_COMMITS;
  }

  get missedCommits(): number {
    return this.missed.length;
  }

  /** Voice in the missed run: what the candidate said that nothing received. */
  get missedVoiceMs(): number {
    return this.missed.reduce((n, c) => n + c.voicedMs, 0);
  }

  /** Epoch ms the missed run's voice began, or 0. */
  get missedSince(): number {
    return this.missed[0]?.startedAt ?? 0;
  }

  /**
   * Called with every silence the microphone reports ending, and on every
   * watchdog tick for the one still open — a tick alone steps over a pause
   * shorter than its interval plus `DEAF_PAUSE_MS`. Returns `deaf`.
   */
  observe(now: number, v: VoiceReading, playbackEndsAt: number, ended?: Silence | null): boolean {
    if (ended && ended.to - ended.from >= DEAF_PAUSE_MS) this.commitAt(ended.from, v, playbackEndsAt);
    else if (now - v.lastVoiceAt >= DEAF_PAUSE_MS) this.commitAt(v.lastVoiceAt, v, playbackEndsAt);

    if (this.pending && now - this.pending.endedAt >= DEAF_COMMIT_WAIT_MS) {
      this.missed.push(this.pending);
      this.pending = null;
    }
    return this.deaf;
  }

  private commitAt(end: number, v: VoiceReading, playbackEndsAt: number) {
    const from = Math.max(this.lastPointEnd, this.lastHeardAt, playbackEndsAt + PLAYBACK_SLACK_MS);
    if (end <= from) return;
    const voicedMs = v.voicedBetween(from, end);
    if (voicedMs < DEAF_MIN_VOICE_MS) return;
    // A later point before the earlier one's wait ran out: nothing arrived for
    // the earlier one either, or `heard` would have cleared it.
    if (this.pending) this.missed.push(this.pending);
    this.pending = { startedAt: from, endedAt: end, voicedMs };
    this.lastPointEnd = end;
  }
}
