/**
 * End-to-end playback test for archived rounds stored in object storage,
 * verifying that rounds whose local audio files have been removed still stream,
 * seek, and fulfill HTTP range requests transparently.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { assertTestApi, assertTestDatabase } from './guard';

const API = process.env.E2E_API ?? 'http://localhost:8788';
const REPO = resolve(import.meta.dirname, '../..');
const REAL_AUDIO = join(REPO, 'apps/api/data/audio');
const TEST_AUDIO = join(REPO, 'apps/api/data-test/audio');
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');

async function main() {
  assertTestDatabase(DB_URL);
  await assertTestApi(API);
  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  console.log(`\nAPI ${API} · target ${JSON.stringify(health.target)}\n`);

  const sql = postgres(DB_URL, { max: 1 });

  const sessionId = randomUUID();
  const mic = join(TEST_AUDIO, `${sessionId}.wav`);
  const ai = join(TEST_AUDIO, `${sessionId}.ai.wav`);
  const email = `e2e-archive+${process.pid}-${sessionId.slice(0, 8)}@orvia.local`;

  try {
    /* 1. an account ------------------------------------------------------- */
    console.log('1. account');
    const reg = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Archive E2E', email, password: 'e2e-password-123' }),
    });
    check('registered', reg.ok, email);
    const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const userId = (await fetch(`${API}/api/auth/me`, { headers: { cookie } }).then((r) => r.json())).id;
    check('have a user id', Boolean(userId));

    /* 2. a session built from a copy of a real recording ------------------- */
    console.log('\n2. a round on local disk');
    await mkdir(TEST_AUDIO, { recursive: true });
    const srcMic = (await import('node:fs')).readdirSync(REAL_AUDIO).find((f) => /^[0-9a-f-]+\.wav$/.test(f));
    const srcAi = srcMic ? srcMic.replace(/\.wav$/, '.ai.wav') : undefined;
    if (!srcMic || !srcAi || !existsSync(join(REAL_AUDIO, srcAi))) {
      check('a real round is available to copy', false, 'need a mic+ai pair in data/audio');
      return;
    }
    await copyFile(join(REAL_AUDIO, srcMic), mic);
    await copyFile(join(REAL_AUDIO, srcAi), ai);
    const micSha = sha(await readFile(mic));
    const micBytes = (await stat(mic)).size;
    check('copied a real pair', true, `${(micBytes / 1024 ** 2).toFixed(1)}MB mic`);

    await sql`
      insert into sessions (id, user_id, mode, status, config, options, model, voice,
        started_at, ended_at, duration_ms, audio_path, ai_audio_path, ai_speaking_ms,
        current_question_idx, dead_ms)
      values (${sessionId}, ${userId}, 'dsa', 'completed', '{}'::jsonb, '{}'::jsonb, 'm', 'v',
        now(), now(), 60000, ${mic}, ${ai}, 0, 0, 0)`;
    check('session row written', true, sessionId.slice(0, 8));

    /* 3. playback while local --------------------------------------------- */
    console.log('\n3. playback BEFORE archiving (the behaviour we must not change)');
    const beforeRes = await fetch(`${API}/api/sessions/${sessionId}/audio?track=me`, { headers: { cookie } });
    const beforeBody = Buffer.from(await beforeRes.arrayBuffer());
    check('200 from local disk', beforeRes.ok, `HTTP ${beforeRes.status}`);
    check('bytes match the file', sha(beforeBody) === micSha, `${beforeBody.length} bytes`);

    const rangeLocal = await fetch(`${API}/api/sessions/${sessionId}/audio?track=me`, {
      headers: { cookie, range: 'bytes=100-199' },
    });
    check('range request honoured locally', rangeLocal.status === 206,
      `HTTP ${rangeLocal.status} ${rangeLocal.headers.get('content-range') ?? ''}`);

    /* 4. archive it -------------------------------------------------------- */
    console.log('\n4. archive to R2 and drop the local copies');
    const { StorageService } = await import('../../apps/api/dist/storage/storage.service.js');
    const { ArchiveService } = await import('../../apps/api/dist/storage/archive.service.js');
    const dotenv = (await import('node:fs')).readFileSync(join(REPO, 'apps/api/.env'), 'utf8');
    const g = (k: string) => dotenv.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    const env = {
      DATA_DIR: './data-test',
      R2_ACCOUNT_ID: g('R2_ACCOUNT_ID'), R2_BUCKET: g('R2_BUCKET'), R2_ENDPOINT: g('R2_ENDPOINT'),
      R2_ACCESS_KEY_ID: g('R2_ACCESS_KEY_ID'), R2_SECRET_ACCESS_KEY: g('R2_SECRET_ACCESS_KEY'),
    } as never;
    const storage = new StorageService(env);
    const archive = new ArchiveService(env, storage);
    const res = await archive.archiveSession(sessionId, { audioPath: mic, aiAudioPath: ai });
    check('archived', res.archived, `${(res.bytes / 1024 ** 2).toFixed(1)}MB in R2`);
    check('local mic wav deleted', !existsSync(mic));
    check('local interviewer wav deleted', !existsSync(ai));
    await sql`update sessions set archived_at = now(), archive_bytes = ${res.bytes} where id = ${sessionId}`;

    /* 5. playback from R2 -------------------------------------------------- */
    console.log('\n5. playback AFTER archiving — same route, same client, no local file');
    const afterRes = await fetch(`${API}/api/sessions/${sessionId}/audio?track=me`, { headers: { cookie } });
    const afterBody = Buffer.from(await afterRes.arrayBuffer());
    check('200 from the bucket', afterRes.ok, `HTTP ${afterRes.status}`);
    check('IDENTICAL bytes to the local playback', sha(afterBody) === micSha,
      sha(afterBody) === micSha ? `${afterBody.length} bytes` : `${sha(afterBody).slice(0,8)} vs ${micSha.slice(0,8)}`);
    check('content-type still audio/wav', afterRes.headers.get('content-type') === 'audio/wav');

    const rangeR2 = await fetch(`${API}/api/sessions/${sessionId}/audio?track=me`, {
      headers: { cookie, range: 'bytes=100-199' },
    });
    const rangeBody = Buffer.from(await rangeR2.arrayBuffer());
    check('range request honoured from R2', rangeR2.status === 206,
      `HTTP ${rangeR2.status} ${rangeR2.headers.get('content-range') ?? ''}`);
    check('ranged bytes match the original slice', rangeBody.equals(beforeBody.subarray(100, 200)));

    const bothRes = await fetch(`${API}/api/sessions/${sessionId}/audio`, { headers: { cookie } });
    check('the mixed "both" track builds from restored files', bothRes.ok, `HTTP ${bothRes.status}`);
    const interviewerRes = await fetch(`${API}/api/sessions/${sessionId}/audio?track=interviewer`,
      { headers: { cookie } });
    check('interviewer track serves from R2', interviewerRes.ok, `HTTP ${interviewerRes.status}`);

    /* 6. ownership still enforced ------------------------------------------ */
    console.log('\n6. an archived round is still private');
    const anon = await fetch(`${API}/api/sessions/${sessionId}/audio?track=me`);
    check('unauthenticated playback rejected', anon.status === 401, `HTTP ${anon.status}`);
  } finally {
    await sql`delete from sessions where id = ${sessionId}`.catch(() => {});
    await sql`delete from users where email = ${email}`.catch(() => {});
    await sql.end().catch(() => {});
    await rm(mic, { force: true });
    await rm(ai, { force: true });
    // Remove what this test put in the bucket. Keys come from the same
    // ArchiveService the test API uses, so the prefix cannot disagree.
    try {
      const { StorageService } = await import('../../apps/api/dist/storage/storage.service.js');
      const { ArchiveService } = await import('../../apps/api/dist/storage/archive.service.js');
      const dotenv = (await import('node:fs')).readFileSync(join(REPO, 'apps/api/.env'), 'utf8');
      const g = (k: string) => dotenv.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
      const env = {
        DATA_DIR: './data-test',
        R2_ACCOUNT_ID: g('R2_ACCOUNT_ID'), R2_BUCKET: g('R2_BUCKET'), R2_ENDPOINT: g('R2_ENDPOINT'),
        R2_ACCESS_KEY_ID: g('R2_ACCESS_KEY_ID'), R2_SECRET_ACCESS_KEY: g('R2_SECRET_ACCESS_KEY'),
      } as never;
      const s = new StorageService(env);
      await new ArchiveService(env, s).purgeSession({ audioPath: mic, aiAudioPath: ai });
    } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
