/**
 * Verifies that verbatim transcription passes always terminate within bounded time.
 * Tests timeouts, retry backoff, and dropout detection using stubbed clients.
 */
import { AUDIO } from '@orvia/shared';
import { TranscriptionService } from '../src/evaluation/transcription.service';

const env = { GEMINI_API_KEY: 'not-used-these-tests-never-reach-the-network' } as never;
const BYTES_PER_SECOND = AUDIO.inputSampleRate * AUDIO.bytesPerSample;

let pass = 0;
const fails: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++;
  else fails.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};

/** Silence is fine: none of these tests get far enough to transcribe anything. */
const audio = (seconds: number) => Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
/** A WAV whose 44-byte header `transcribe` strips before segmenting. */
const wavOf = (seconds: number) => Buffer.concat([Buffer.alloc(44), audio(seconds)]);

const stub = (connect: () => Promise<unknown>) => {
  const svc = new TranscriptionService(env);
  (svc as unknown as { ai: unknown }).ai = { live: { connect } };
  return svc as unknown as {
    transcribeSegment(pcm: Buffer, label: string): Promise<string | null>;
    transcribe(path: string): Promise<unknown>;
  };
};

const NEVER = () => new Promise<never>(() => {});

console.log('\n\x1b[1m1. a handshake that never completes\x1b[0m');
{
  const svc = stub(NEVER);
  const t0 = Date.now();
  const got = await svc.transcribeSegment(audio(5), 'test');
  const took = Date.now() - t0;
  check('returns instead of hanging', got === null, `${(took / 1000).toFixed(1)}s`);
  check('bounded by CONNECT_TIMEOUT_MS', took >= 28_000 && took < 40_000, `${(took / 1000).toFixed(1)}s`);
}

console.log('\n\x1b[1m2. a handshake that rejects\x1b[0m');
{
  const svc = stub(() => Promise.reject(new Error('upstream refused')));
  const t0 = Date.now();
  const got = await svc.transcribeSegment(audio(5), 'test');
  const took = Date.now() - t0;
  check('still fails fast', got === null && took < 2_000, `${took}ms`);
}

console.log('\n\x1b[1m3. the whole pass over a dead upstream\x1b[0m');
{
  const { writeFile, rm } = await import('node:fs/promises');
  const path = '/tmp/orvia-timeout-verify.wav';
  await writeFile(path, wavOf(30));
  const svc = stub(NEVER);
  const t0 = Date.now();
  const got = await svc.transcribe(path);
  const took = Date.now() - t0;
  await rm(path, { force: true });
  check('the pass completes rather than hanging', got === null, `${(took / 1000).toFixed(0)}s`);
  check(
    'cost is the three attempts, not for ever',
    took >= 85_000 && took < 130_000,
    `${(took / 1000).toFixed(0)}s for 3 attempts x 30s plus 2s and 4s of retry backoff`,
  );
}

console.log('\n\x1b[1m4. a socket that throws mid-send is still closed\x1b[0m');
{
  // `close()` sat at the end of the try, so any throw after the handshake
  // left the socket open for the rest of the pass.
  let closed = 0;
  const svc = stub(async () => ({
    sendRealtimeInput: () => { throw new Error('socket is not open'); },
    close: () => { closed++; },
  }));
  const got = await svc.transcribeSegment(audio(1), 'test');
  check('the attempt fails', got === null);
  check('and its socket is closed', closed === 1, `close() called ${closed}x`);
}

console.log('\n\x1b[1m5. retries back off\x1b[0m');
{
  const { writeFile, rm } = await import('node:fs/promises');
  const path = '/tmp/orvia-backoff-verify.wav';
  await writeFile(path, wavOf(5));
  const svc = stub(() => Promise.reject(new Error('upstream refused')));
  const waits: number[] = [];
  (svc as unknown as { wait: (ms: number) => Promise<void> }).wait = async (ms) => { waits.push(ms); };
  await svc.transcribe(path);
  await rm(path, { force: true });
  check('a failed segment waits before each retry, longer each time',
    waits.length === 2 && waits[1]! > waits[0]! && waits[0]! > 0, `${waits.join(', ')}ms`);
}

console.log('\n\x1b[1m6. an empty segment the live transcript also heard nothing in\x1b[0m');
{
  /**
   * 120s of near-silence with sound bursts adding up to `voicedSeconds`,
   * simulating background typing or breathing without speech.
   */
  const bursts = (voicedSeconds: number) => {
    const pcm = audio(120);
    const n = Math.round(voicedSeconds / 0.25);
    for (let b = 0; b < n; b++) {
      const at = Math.floor(((b + 0.5) * 120) / n * BYTES_PER_SECOND) & ~1;
      for (let o = 0; o < 0.25 * BYTES_PER_SECOND; o += 2) pcm.writeInt16LE(o % 4 ? 3000 : -3000, at + o);
    }
    return pcm;
  };
  const svc = new TranscriptionService(env) as unknown as {
    implausible(pcm: Buffer, text: string, live?: unknown, label?: string): string | null;
  };
  const window = { startMs: 1_680_000, endMs: 1_800_000 };
  const quiet = bursts(10);
  check('without the live transcript, 10s of sound and no words is still a dropout',
    svc.implausible(quiet, '') !== null);
  check('with no candidate turn in the window, it is accepted as silence',
    svc.implausible(quiet, '', { window, heard: [{ startMs: 1_589_965, endMs: 1_589_970 }, { startMs: 1_843_231, endMs: 1_844_043 }] }) === null);
  check('a candidate turn inside the window keeps it a dropout',
    svc.implausible(quiet, '', { window, heard: [{ startMs: 1_750_000, endMs: 1_760_000 }] }) !== null);
  check('a turn just past the window, inside the stamping margin, keeps it a dropout',
    svc.implausible(quiet, '', { window, heard: [{ startMs: 1_810_000, endMs: null }] }) !== null);
  check('a dropout-sized segment (45s of sound) is never excused by the live transcript',
    svc.implausible(bursts(45), '', { window, heard: [] }) !== null);
}

console.log(`\n${fails.length ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fails.length} failed\x1b[0m`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
