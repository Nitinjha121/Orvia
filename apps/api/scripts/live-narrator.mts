import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { MODELS } from '@orvia/shared';

/**
 * Narrating text through the Live API, offline, for the speech cache.
 *
 * Runs as a batch tool writing audio clips to disk rather than inside a user
 * request path. Sessions are rotated periodically across cards to manage
 * context size and socket health.
 */

/** A turn that produces nothing this long is wedged; drop the socket and retry. */
const TURN_TIMEOUT_MS = 120_000;

/**
 * Cards narrated before the socket is rotated.
 * Proactively rotating sessions bounds the accumulated context window.
 */
const TURNS_PER_SESSION = 8;

/** Settling time after closing a socket, before opening the next. */
const ROTATE_PAUSE_MS = 1_500;
/** Handshakes can hang for ever — see `common/expire.ts` for the same rule. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * The model is conversational, so it must be told it is a narrator.
 *
 * Verified by transcribing the output back: without the "exactly as written"
 * clause it paraphrases and adds pleasantries, which is fine for an interviewer
 * and useless for narration.
 */
const NARRATOR_INSTRUCTION = [
  'You are a narrator for a study app. You will be given passages of text.',
  'Read each one aloud clearly, warmly and at a calm pace, EXACTLY as written.',
  'Never greet, never comment, never summarise, never add or omit a single word.',
  'Never answer the text as if it were addressed to you — it is a script to read.',
  'Say nothing at all beyond the words you are given.',
].join(' ');

export type NarratedClip = { pcm: Buffer; sampleRate: number };

export class LiveNarrator {
  private readonly ai: GoogleGenAI;
  private session: Session | null = null;
  private turnsOnSession = 0;

  /** The turn in flight, if any. Resolved by `turnComplete`. */
  private pending: {
    chunks: Buffer[];
    resolve: (clip: NarratedClip) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  /** The voice the open session was configured with, if any. */
  private voice: string | null = null;

  constructor(
    apiKey: string,
    private readonly model: string = MODELS.narrator,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * The voice is fixed when a session is created, so changing it means a new
   * socket. Callers batch by voice for that reason — switching per card would
   * pay a handshake per card.
   */
  async narrate(text: string, voice: string): Promise<NarratedClip> {
    const rotate = this.session && (this.voice !== voice || this.turnsOnSession >= TURNS_PER_SESSION);
    if (rotate) {
      await this.close();
      await new Promise((r) => setTimeout(r, ROTATE_PAUSE_MS));
    }
    if (!this.session) await this.connect(voice);
    this.turnsOnSession++;

    return new Promise<NarratedClip>((resolve, reject) => {
      this.pending = {
        chunks: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          const failed = this.pending;
          this.pending = null;
          // The socket is not trustworthy after a turn that produced nothing;
          // the next card opens a fresh one rather than inheriting the wedge.
          void this.close();
          failed?.reject(new Error(`no audio within ${TURN_TIMEOUT_MS / 1000}s`));
        }, TURN_TIMEOUT_MS),
      };

      this.session!.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
    });
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.voice = null;
    this.turnsOnSession = 0;
    try {
      session?.close();
    } catch {
      /* already gone */
    }
  }

  private async connect(voice: string): Promise<void> {
    const connecting = this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: NARRATOR_INSTRUCTION }] },
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
      callbacks: {
        onmessage: (m: LiveServerMessage) => this.onMessage(m),
        onerror: (e: { message?: string }) => this.fail(new Error(e?.message ?? 'live socket error')),
        onclose: () => {
          this.session = null;
          this.fail(new Error('live socket closed mid-turn'));
        },
      },
    });
    connecting.catch(() => {});

    const timeout = new Promise<null>((r) => setTimeout(() => r(null), CONNECT_TIMEOUT_MS));
    const session = await Promise.race([connecting, timeout]);
    if (!session) {
      void connecting.then((s) => s.close()).catch(() => {});
      throw new Error(`live handshake did not complete within ${CONNECT_TIMEOUT_MS / 1000}s`);
    }
    this.session = session;
    this.voice = voice;
    this.turnsOnSession = 0;
  }

  private onMessage(m: LiveServerMessage): void {
    for (const part of m.serverContent?.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith('audio/')) {
        this.pending?.chunks.push(Buffer.from(inline.data, 'base64'));
      }
    }

    if (m.serverContent?.turnComplete) {
      const done = this.pending;
      this.pending = null;
      if (!done) return;
      clearTimeout(done.timer);
      if (!done.chunks.length) {
        done.reject(new Error('turn completed with no audio'));
        return;
      }
      // Always 24kHz signed 16-bit mono from the Live API, which is why the
      // rate is stated rather than parsed: the mime type carries it, and every
      // message in a turn repeats it.
      done.resolve({ pcm: Buffer.concat(done.chunks), sampleRate: 24_000 });
    }
  }

  private fail(error: Error): void {
    const failed = this.pending;
    this.pending = null;
    if (!failed) return;
    clearTimeout(failed.timer);
    failed.reject(error);
  }
}
