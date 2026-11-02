import type { Logger } from '@nestjs/common';

type Part = Record<string, unknown>;
type Audio = { mimeType: string; data: string };

/** One client content, the only shape a note ever goes upstream in. */
export type ClientContent = {
  turns?: { role: 'user' | 'model'; parts: Part[] }[];
  turnComplete: boolean;
};

export type NoteSink = {
  /**
   * Whether a send now lands on a quiet line: a socket to send on, no model
   * turn open, and no reply already requested and not yet begun.
   */
  free(): boolean;
  send(content: ClientContent): void;
};

/**
 * Queues system notes and context updates to flush only at turn boundaries.
 *
 * Sending client content while a model turn is in flight triggers server-side
 * barge-in, disrupting VAD turn tracking. Multiple pending items at a boundary
 * are joined into a single send.
 */
export class NoteQueue {
  /** The newest editor snapshot. The ONLY coalescing slot — see `snapshot`. */
  private pendingSnapshot?: string;
  private facts: { text: string; key?: string }[] = [];
  private corrections: string[] = [];
  private lastSnapshotSent?: string;
  /** One per boundary: each is separately at the request-size ceiling. */
  private recordings: { text: string; audio: Audio; requestReply?: boolean }[] = [];
  /** Depth of `deferring`; while positive, nothing flushes on arrival. */
  private deferred = 0;

  constructor(
    private readonly sink: NoteSink,
    private readonly log: Logger,
  ) {}

  get hasQueuedAudio() {
    return this.recordings.length > 0;
  }

  get correctionCount() {
    return this.corrections.length;
  }

  get hasSnapshot() {
    return this.pendingSnapshot !== undefined;
  }

  /**
   * A DISPOSABLE editor snapshot, informing the next question without asking
   * for a reply. Only the newest is worth anything, so it overwrites and waits
   * for a boundary. Nothing owed exactly once may use this — see `fact`.
   */
  snapshot(text: string) {
    this.pendingSnapshot = text;
  }

  /**
   * Queues an uncoalesced note (e.g. clock elapsed reading, question switch).
   *
   * `key` collapses successive notes of the same kind in place so newer readings
   * replace older ones without unneeded queue growth. Sent immediately when the
   * line is free.
   */
  fact(text: string, key?: string) {
    const at = key ? this.facts.findIndex((f) => f.key === key) : -1;
    if (at === -1) this.facts.push({ text, key });
    else this.facts[at] = { text, key };
    this.flushIfFree();
  }

  /**
   * Queues a speech correction that requires model action.
   * Prioritized at the next turn boundary over general facts and snapshots.
   */
  correction(text: string) {
    this.corrections.push(text);
    this.flushIfFree();
  }

  /**
   * A recording for the next boundary. A QUEUE: `listen_to_round` can ask for
   * a later part while an earlier one waits, and coalescing would drop it.
   */
  recording(text: string, audio: Audio, requestReply?: boolean) {
    this.recordings.push({ text, audio, requestReply });
  }

  /**
   * Runs `fn` with arrival-flushes suspended, so the checks a boundary runs
   * and the boundary's own flush go out as one send.
   */
  deferring(fn: () => void) {
    this.deferred += 1;
    try {
      fn();
    } finally {
      this.deferred -= 1;
    }
  }

  /** Sends what is OWED if the line is free. A snapshot alone waits for a boundary. */
  flushIfFree() {
    if (this.deferred || !(this.corrections.length || this.facts.length)) return;
    if (!this.sink.free()) return;
    this.flushAtBoundary();
  }

  /**
   * Corrections first, one per boundary, because they are about the turn that
   * just ended. Otherwise the facts and the snapshot, JOINED; then at most one
   * recording, which is the coach's proven path — greet, then the round's audio
   * in the same boundary.
   */
  flushAtBoundary() {
    if (!this.sink.free()) return;
    const correction = this.corrections.shift();
    if (correction) {
      this.send({ text: correction }, true, 'turn boundary');
      return;
    }

    const texts = this.facts.splice(0).map((f) => f.text);
    const snap = this.pendingSnapshot;
    if (snap !== undefined) {
      this.pendingSnapshot = undefined;
      /**
       * Drop snapshots identical to the last one sent to avoid unnecessary
       * note injection. A repeated fact is still owed.
       */
      if (snap !== this.lastSnapshotSent) {
        this.lastSnapshotSent = snap;
        texts.push(snap);
      } else {
        this.log.log('dropped an editor snapshot identical to the last one sent');
      }
    }
    if (texts.length) this.send({ text: texts.join('\n\n') }, false, 'turn boundary');

    const rec = this.recordings.shift();
    if (rec) this.send(rec, !!rec.requestReply, 'turn boundary');
  }

  /**
   * Flushes queued notes when a turn is interrupted by candidate barge-in.
   * Sent as background context (`turnComplete: false`) without demanding an immediate reply.
   */
  flushAtBargeIn() {
    if (!this.sink.free()) return;
    const correction = this.corrections.shift();
    if (correction) {
      this.send({ text: correction }, false, 'barge-in');
      return;
    }
    const facts = this.facts.splice(0);
    if (facts.length) {
      this.send({ text: facts.map((f) => f.text).join('\n\n') }, false, 'barge-in');
      return;
    }
    const rec = this.recordings.shift();
    if (rec) this.send(rec, false, 'barge-in');
  }

  private send(note: { text: string; audio?: Audio }, requestReply: boolean, at: string) {
    const parts: Part[] = [{ text: `[SYSTEM NOTE — not spoken by the candidate]\n${note.text}` }];
    if (note.audio) {
      parts.push({ inlineData: { mimeType: note.audio.mimeType, data: note.audio.data } });
    }
    this.sink.send({ turns: [{ role: 'user', parts }], turnComplete: requestReply });
    this.log.log(
      `flushed a queued note at a ${at} (${note.text.length} chars` +
        `${note.audio ? `, plus ${(note.audio.data.length / 1048576).toFixed(1)}MB of audio` : ''}` +
        `${requestReply ? ', requesting a reply' : ''}` +
        `${this.recordings.length ? `; ${this.recordings.length} recording(s) still queued` : ''})`,
    );
  }
}
