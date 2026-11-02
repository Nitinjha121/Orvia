/**
 * Verifies the R2 audio archive and restore pipeline.
 *
 * Tests offline signing, config validation, and deletion guards using temporary directories.
 * If R2 credentials are configured in .env, also tests round-trip against the real bucket.
 *
 *   pnpm --filter @orvia/api verify:archive [--offline]
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Logger } from '@nestjs/common';
import { basename, join, resolve } from 'node:path';

import { ArchiveService, WAV_SHA_META } from '../src/storage/archive.service';
import {
  StorageService, CEILING, FREE_TIER_BYTES, readR2Config, type StoredObject,
} from '../src/storage/storage.service';
import { sign, signV4, sha256hex, uriEncode } from '../src/storage/sigv4';
import { wavHeader } from '../src/interview/recording.service';
import type { Env } from '../src/config/env';

const APP_ROOT = resolve(import.meta.dirname, '..');
const REAL_AUDIO = join(APP_ROOT, 'data', 'audio');
const OFFLINE = process.argv.includes('--offline');

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const sha = async (p: string) => createHash('sha1').update(await readFile(p)).digest('hex');
const throws = async (fn: () => unknown) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: 8787,
  WEB_ORIGIN: 'http://localhost:5173',
  GEMINI_API_KEY: 'x'.repeat(20),
  DATABASE_URL: 'postgresql://postgres@localhost:5432/orvia_test',
  JWT_SECRET: 'x'.repeat(40),
};
const FAKE_R2 = {
  R2_ACCOUNT_ID: 'abc123',
  R2_BUCKET: 'b',
  R2_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'k',
  R2_SECRET_ACCESS_KEY: 's',
};

/** A bucket in a Map, with knobs for every way the real one can let us down. */
class MemoryStorage extends StorageService {
  objects = new Map<string, StoredObject>();
  failPut = false;
  corruptReadBack = false;
  puts = 0;
  constructor(dataDir: string) {
    super({ ...BASE_ENV, DATA_DIR: dataDir } as Env);
  }
  override isEnabled() {
    return true;
  }
  override async put(key: string, body: Buffer, _t: string, meta: Record<string, string> = {}) {
    this.puts++;
    if (!this.hasRoomFor(body.length)) throw new Error('budget');
    if (this.failPut) throw new Error('simulated PUT failure');
    const stored = Buffer.from(body);
    if (this.corruptReadBack) stored[stored.length - 1] = stored[stored.length - 1]! ^ 0xff;
    this.objects.set(key, { body: stored, meta: { ...meta } });
  }
  override async getObject(key: string) {
    return this.objects.get(key) ?? null;
  }
  override async head(key: string) {
    return this.objects.get(key)?.body.length ?? null;
  }
  override async delete(key: string) {
    this.objects.delete(key);
  }
}

/** A recorder-format WAV: the real 44-byte header, speech-like noise then silence. */
function syntheticWav(seconds: number, rate: number, seed: number): Buffer {
  const n = seconds * rate;
  const pcm = Buffer.alloc(n * 2);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = i < n / 2 ? Math.round(Math.sin(i / 7) * 8000 + ((x % 2000) - 1000)) : 0;
    pcm.writeInt16LE(v, i * 2);
  }
  return Buffer.concat([wavHeader(pcm.length, rate, 1, 16), pcm]);
}

async function offline(work: string) {
  console.log('\nOFFLINE\n\n1. SigV4 against the AWS S3 published examples');
  const aws = {
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    amzDate: '20130524T000000Z',
  };
  const empty = sha256hex('');
  const getAuth = signV4({
    ...aws, method: 'GET', canonicalUri: '/test.txt', payloadHash: empty,
    headers: {
      Host: 'examplebucket.s3.amazonaws.com', Range: 'bytes=0-9',
      'x-amz-content-sha256': empty, 'x-amz-date': aws.amzDate,
    },
  });
  check('GET Object vector',
    getAuth.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'));
  const putBody = sha256hex('Welcome to Amazon S3.');
  check('payload hash vector',
    putBody === '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const putAuth = signV4({
    ...aws, method: 'PUT', canonicalUri: `/${uriEncode('test$file.text', false)}`, payloadHash: putBody,
    headers: {
      Host: 'examplebucket.s3.amazonaws.com', Date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-date': aws.amzDate, 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      'x-amz-content-sha256': putBody,
    },
  });
  check('PUT Object vector (key needing %24)',
    putAuth.endsWith('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'));
  check('uriEncode is RFC3986 on UTF-8 bytes', uriEncode("a b!'()*/é", false) === 'a%20b%21%27%28%29%2A/%C3%A9');
  const creds = readR2Config(FAKE_R2)!;
  const signed = sign(creds, 'GET', 'audio/x.flac', undefined, {}, new Date('2026-01-02T03:04:05.678Z'));
  check('R2 request is path-style on the account host',
    signed.url === 'https://abc123.r2.cloudflarestorage.com/b/audio/x.flac', signed.url);
  check('scope uses region auto', (signed.headers.Authorization ?? '').includes('/20260102/auto/s3/aws4_request'));
  check('x-amz-date has no millis', signed.headers['x-amz-date'] === '20260102T030405Z');
  check('signing without a key throws',
    await throws(() => sign({ ...creds, accessKeyId: '', secretAccessKey: '' }, 'GET', 'x')));

  console.log('\n2. configuration: all or nothing, and only R2');
  check('no R2 vars -> off', readR2Config({}) === null);
  check('blank R2 vars -> off', readR2Config({ R2_BUCKET: '  ', R2_ENDPOINT: '' }) === null);
  check('partial R2 vars -> refuses', await throws(() => readR2Config({ ...FAKE_R2, R2_SECRET_ACCESS_KEY: '' })));
  check('an AWS S3 endpoint -> refuses',
    await throws(() => readR2Config({ ...FAKE_R2, R2_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' })));
  check('another account\'s R2 endpoint -> refuses',
    await throws(() => readR2Config({ ...FAKE_R2, R2_ENDPOINT: 'https://zzz999.r2.cloudflarestorage.com' })));
  check('http -> refuses',
    await throws(() => readR2Config({ ...FAKE_R2, R2_ENDPOINT: 'http://abc123.r2.cloudflarestorage.com' })));
  check('eu jurisdiction endpoint accepted',
    readR2Config({ ...FAKE_R2, R2_ENDPOINT: 'https://abc123.eu.r2.cloudflarestorage.com' }) !== null);

  console.log('\n3. with R2 off, nothing is touched');
  const offDir = join(work, 'off');
  await mkdir(join(offDir, 'audio'), { recursive: true });
  const offEnv = { ...BASE_ENV, DATA_DIR: offDir } as Env;
  const offStorage = new StorageService(offEnv);
  const offArchive = new ArchiveService(offEnv, offStorage);
  const keep = join(offDir, 'audio', 'keep.wav');
  await writeFile(keep, syntheticWav(1, 16000, 1));
  check('isEnabled is false', !offStorage.isEnabled());
  check('archiveSession is a no-op', !(await offArchive.archiveSession('s', { audioPath: keep })).archived);
  check('the local file is untouched', existsSync(keep));
  check('ensureLocal passes a local path through', (await offArchive.ensureLocal(keep)) === keep);
  check('ensureLocal(null) is null', (await offArchive.ensureLocal(null)) === null);
  check('ensureLocal(missing) is null, not a throw',
    (await offArchive.ensureLocal(join(offDir, 'audio', 'gone.wav'))) === null);

  console.log('\n4. the deletion gates, against an in-memory bucket');
  const dir = join(work, 'mem');
  const audio = join(dir, 'audio');
  await mkdir(audio, { recursive: true });
  const env = { ...BASE_ENV, DATA_DIR: dir } as Env;
  const round = async (tag: string) => {
    const id = `${tag}-${randomBytes(3).toString('hex')}`;
    const mic = join(audio, `${id}.wav`);
    const ai = join(audio, `${id}.ai.wav`);
    await writeFile(mic, syntheticWav(3, 16000, 7));
    await writeFile(ai, syntheticWav(3, 24000, 9));
    await writeFile(join(audio, `${id}.mix.wav`), Buffer.alloc(100));
    return { id, mic, ai, micSha: await sha(mic), aiSha: await sha(ai) };
  };

  {
    const s = new MemoryStorage(dir);
    s.corruptReadBack = true;
    const r = await round('corrupt');
    const a = new ArchiveService(env, s);
    const threw = await throws(() => a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai }));
    check('a read-back that differs by ONE byte throws', threw);
    check('...and both WAVs are still on disk', existsSync(r.mic) && existsSync(r.ai));
  }
  {
    const s = new MemoryStorage(dir);
    s.failPut = true;
    const r = await round('putfail');
    const a = new ArchiveService(env, s);
    check('a failed PUT throws', await throws(() => a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai })));
    check('...and both WAVs are still on disk', existsSync(r.mic) && existsSync(r.ai));
  }
  {
    const s = new MemoryStorage(dir);
    const r = await round('stampfail');
    const a = new ArchiveService(env, s);
    const threw = await throws(() => a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai }, {
      beforeDelete: async () => { throw new Error('db down'); },
    }));
    check('a failed stamp throws', threw);
    check('...and both WAVs are still on disk', existsSync(r.mic) && existsSync(r.ai));
  }
  {
    const s = new MemoryStorage(dir);
    s.setUsedBytes(Math.floor(FREE_TIER_BYTES * CEILING));
    const r = await round('full');
    const a = new ArchiveService(env, s);
    const res = await a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai });
    check('at the ceiling nothing is archived', !res.archived && s.puts === 0, `${s.puts} puts`);
    check('...and both WAVs are still on disk', existsSync(r.mic) && existsSync(r.ai));
  }
  {
    const s = new MemoryStorage(dir);
    const r = await round('mismatch');
    // A header claiming more data than the file holds: ffmpeg decodes what is
    // there and writes an honest header, so the round-trip cannot match.
    const buf = await readFile(r.mic);
    buf.writeUInt32LE(buf.readUInt32LE(40) + 1000, 40);
    await writeFile(r.mic, buf);
    const a = new ArchiveService(env, s);
    const res = await a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai });
    check('a WAV that does not round-trip is not archived', !res.archived && s.puts === 0);
    check('...and it is still on disk', existsSync(r.mic) && existsSync(r.ai));
  }

  let stamped = -1;
  const s = new MemoryStorage(dir);
  const a = new ArchiveService(env, s);
  const r = await round('ok');
  const [res, dup] = await Promise.all([
    a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai }, {
      beforeDelete: async (b) => {
        stamped = b;
        check('stamp runs while the WAVs still exist', existsSync(r.mic) && existsSync(r.ai));
      },
    }),
    a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai }),
  ]);
  check('happy path archives', res.archived);
  check('a concurrent call for the same session shares the job', dup === res && s.puts === 2, `${s.puts} puts`);
  check('stamp received the byte count', stamped === res.bytes && res.bytes > 0);
  check('WAVs deleted only now', !existsSync(r.mic) && !existsSync(r.ai));
  check('derived mix deleted too', !existsSync(join(audio, `${r.id}.mix.wav`)));
  check('objects carry the WAV sha1', s.objects.get(a.keyFor(r.mic))?.meta[WAV_SHA_META] === r.micSha);
  check('keys are plain audio/ for a non-test data dir', a.keyFor(r.mic) === `audio/${r.id}.flac`);
  check('no scratch left in audio/', readdirSync(audio).every((f) => !/\.(flac|verify\.wav)$/.test(f)));

  console.log('\n5. restore');
  const [m1, m2] = await Promise.all([a.ensureLocal(r.mic), a.ensureLocal(r.mic)]);
  check('concurrent restores return one path', Boolean(m1) && m1 === m2);
  check('restored mic is BYTE-IDENTICAL', m1 ? (await sha(m1)) === r.micSha : false);
  const ai = await a.ensureLocal(r.ai);
  check('restored interviewer is BYTE-IDENTICAL', ai ? (await sha(ai)) === r.aiSha : false);
  check('restored header is canonical (data at byte 36)',
    m1 ? (await readFile(m1)).subarray(36, 40).toString() === 'data' : false);
  check('no partial files left in the cache',
    (await readdir(join(dir, 'audio-cache'))).every((f) => !f.includes('partial')));
  check('second read served from cache', (await a.ensureLocal(r.mic)) === m1);

  const again = await a.archiveSession(r.id, { audioPath: r.mic, aiAudioPath: r.ai });
  check('re-archiving after the WAVs are gone reports archived from the bucket',
    again.archived && again.bytes === res.bytes && s.puts === 2);

  await rm(join(dir, 'audio-cache'), { recursive: true, force: true });
  const obj = s.objects.get(a.keyFor(r.mic))!;
  s.objects.set(a.keyFor(r.mic), { body: obj.body, meta: { [WAV_SHA_META]: '0'.repeat(40) } });
  check('a restore that does not match the archived sha1 throws', await throws(() => a.ensureLocal(r.mic)));
  check('...and leaves nothing a later read could pick up',
    !existsSync(join(dir, 'audio-cache', basename(r.mic))) &&
      (await readdir(join(dir, 'audio-cache'))).every((f) => !f.includes('partial')));
  check('an object absent from the bucket restores to null',
    (await a.ensureLocal(join(audio, 'never-archived.wav'))) === null);

  check('purgeSession removes both objects',
    (await a.purgeSession({ audioPath: r.mic, aiAudioPath: r.ai })) > 0 && s.objects.size === 0);

  const testArchive = new ArchiveService({ ...env, DATA_DIR: join(work, 'data-test') } as Env, s);
  check('a test data dir gets its own prefix', testArchive.keyFor('/x/abc.ai.wav') === 'test/audio/abc.ai.flac');
}

function envFromDotEnv(dir: string): Env {
  const file = join(APP_ROOT, '.env');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  return {
    ...BASE_ENV,
    DATA_DIR: dir,
    R2_ACCOUNT_ID: get('R2_ACCOUNT_ID'),
    R2_BUCKET: get('R2_BUCKET'),
    R2_ENDPOINT: get('R2_ENDPOINT'),
    R2_ACCESS_KEY_ID: get('R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: get('R2_SECRET_ACCESS_KEY'),
  } as Env;
}

async function online(work: string) {
  const env = envFromDotEnv(join(work, 'online'));
  const storage = new StorageService(env);
  console.log('\nONLINE\n');
  if (!storage.isEnabled()) {
    console.log('  R2 not configured in apps/api/.env — online half skipped.\n');
    return;
  }
  const runId = `verify/${Date.now().toString(36)}-${randomBytes(3).toString('hex')}/`;
  class VerifyArchive extends ArchiveService {
    override keyFor(wavPath: string) {
      return `${runId}${basename(wavPath).replace(/\.wav$/, '.flac')}`;
    }
  }
  const archive = new VerifyArchive(env, storage);
  const written = new Set<string>();

  try {
    console.log(`6. raw object round-trip under ${runId}`);
    const probeKey = `${runId}probe.bin`;
    const probe = Buffer.from('orvia archive probe '.repeat(64));
    written.add(probeKey);
    await storage.put(probeKey, probe, 'application/octet-stream', { probe: 'yes' });
    check('PUT accounted in budget', storage.usage().usedBytes === probe.length);
    check('HEAD reports the right size', (await storage.head(probeKey)) === probe.length);
    const got = await storage.getObject(probeKey);
    check('GET returns identical bytes', Boolean(got?.body.equals(probe)));
    check('metadata comes back', got?.meta.probe === 'yes', JSON.stringify(got?.meta));
    await storage.delete(probeKey, probe.length);
    check('DELETE removes it', (await storage.head(probeKey)) === null);
    check('budget released on delete', storage.usage().usedBytes === 0);

    console.log('\n7. archive a COPY of a real round, then restore it');
    const src = readdirSync(REAL_AUDIO).find((f) => f.endsWith('.ai.wav'));
    if (!src) {
      check('a real recording is available to copy', false, 'no .ai.wav in data/audio');
      return;
    }
    const audio = join(work, 'online', 'audio');
    await mkdir(audio, { recursive: true });
    const wav = join(audio, `copy-${randomBytes(4).toString('hex')}.ai.wav`);
    await copyFile(join(REAL_AUDIO, src), wav);
    const originalSha = await sha(wav);
    written.add(archive.keyFor(wav));

    const res = await archive.archiveSession('verify', { aiAudioPath: wav });
    check('archiveSession reports success', res.archived, `${(res.bytes / 1024 ** 2).toFixed(1)}MB`);
    check('the COPY is gone', !existsSync(wav));
    check('object is in the bucket at the right size', (await storage.head(archive.keyFor(wav))) === res.bytes);
    const restored = await archive.ensureLocal(wav);
    check('restored file is BYTE-IDENTICAL', restored ? (await sha(restored)) === originalSha : false);
    check('restored header is canonical', restored
      ? (await readFile(restored)).subarray(36, 40).toString() === 'data' : false);

    console.log('\n8. budget guard refuses before the network');
    storage.setUsedBytes(Math.floor(FREE_TIER_BYTES * CEILING));
    const refusedKey = `${runId}should-not-exist`;
    written.add(refusedKey);
    check('put throws at the ceiling',
      await throws(() => storage.put(refusedKey, Buffer.alloc(1024), 'application/octet-stream')));
    check('nothing was uploaded', (await storage.head(refusedKey)) === null);
    storage.setUsedBytes(0);
  } finally {
    for (const key of written) await storage.delete(key).catch(() => {});
    let left = 0;
    for (const key of written) if ((await storage.head(key).catch(() => null)) !== null) left++;
    check('every object this run wrote is gone from the bucket', left === 0, `${left} left`);
  }
}

async function main() {
  if (!process.argv.includes('--verbose')) Logger.overrideLogger(['error']);
  const work = await mkdtemp(join(tmpdir(), 'verify-archive-'));
  try {
    await offline(work);
    if (!OFFLINE) await online(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
