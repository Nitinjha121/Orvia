/**
 * Streams a recorded audio track to a Live API session in real time, logging
 * server messages, token usage, and transcription output to monitor session health.
 *
 *   tsx --env-file=apps/api/.env tools/probe-live.mts --wav <mic.wav> --sys <file> --out <log.jsonl>
 */
import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { LiveInterviewSession } from '../apps/api/src/gemini/live-session.service';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : process.argv[i + 1];
};
const flag = (k: string) => process.argv.includes(`--${k}`);

const WAV = arg('wav')!;
const OUT = arg('out')!;
const SYS = readFileSync(arg('sys')!, 'utf8');
const MODEL = arg('model', 'gemini-3.1-flash-live-preview')!;
const FROM_S = Number(arg('from-s', '0'));
const TO_S = Number(arg('to-s', '1e9'));
const NOTES_EVERY_MS = Number(arg('notes-every-s', '0')) * 1000;

/* The product's config, built by the product's own method. */
const shell = Object.create(LiveInterviewSession.prototype) as Record<string, unknown>;
Object.assign(shell, { model: MODEL, opts: { systemInstruction: SYS, voice: 'Charon' }, resumptionHandle: undefined });
const buildConfig = (handle?: string) => {
  shell.resumptionHandle = handle;
  const cfg = (shell as unknown as { buildConfig(): Record<string, unknown> }).buildConfig();
  if (flag('no-compression')) delete cfg.contextWindowCompression;
  else if (arg('trigger')) cfg.contextWindowCompression = { triggerTokens: arg('trigger'), slidingWindow: { targetTokens: arg('target') } };
  return cfg;
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const pcm = readFileSync(WAV).subarray(44);
const CHUNK = 3200; // 100ms of 16kHz 16-bit mono
const t0 = Date.now();
const now = () => Date.now() - t0;
writeFileSync(OUT, '');
const log = (o: Record<string, unknown>) => appendFileSync(OUT, JSON.stringify({ t: now(), ...o }) + '\n');

let session: Session | undefined;
let handle: string | undefined;
let modelTurnOpen = false;
let reconnecting = false;
let lastUsage: Record<string, unknown> = {};
let minuteVoiced = 0;
let minuteWords = 0;
let minuteOut = 0;

function onMessage(m: LiveServerMessage) {
  if (m.sessionResumptionUpdate?.newHandle) handle = m.sessionResumptionUpdate.newHandle;
  if (m.usageMetadata) {
    lastUsage = { prompt: m.usageMetadata.promptTokenCount, total: m.usageMetadata.totalTokenCount };
    log({ usage: m.usageMetadata });
  }
  if (m.goAway) { log({ goAway: m.goAway.timeLeft }); void reconnect('goAway'); }
  const c = m.serverContent;
  if (!c) return;
  if (c.inputTranscription?.text) { minuteWords += c.inputTranscription.text.trim().split(/\s+/).length; log({ in: c.inputTranscription.text }); }
  if (c.outputTranscription?.text) { modelTurnOpen = true; minuteOut += 1; log({ out: c.outputTranscription.text }); }
  if (c.modelTurn?.parts?.some((p) => p.inlineData)) modelTurnOpen = true;
  if (c.interrupted) { modelTurnOpen = false; log({ interrupted: true }); }
  if (c.turnComplete) { modelTurnOpen = false; log({ turnComplete: true }); }
}

async function connect() {
  const s = await ai.live.connect({
    model: MODEL,
    config: buildConfig(handle) as never,
    callbacks: {
      onmessage: (m: LiveServerMessage) => onMessage(m),
      onerror: (e: { message?: string }) => log({ error: e?.message }),
      onclose: (e: { reason?: string; code?: number }) => {
        log({ close: e?.reason, code: e?.code });
        if (flag('fresh-on-error') && e?.code === 1011) handle = undefined;
        if (s === session) void reconnect('close');
      },
    },
  });
  session = s;
  modelTurnOpen = false;
  log({ open: true, resumed: !!handle });
}

async function reconnect(why: string) {
  if (reconnecting) return;
  reconnecting = true;
  const old = session;
  session = undefined;
  try { old?.close(); } catch { /* gone */ }
  log({ reconnecting: why, withHandle: !!handle });
  for (let i = 0; i < 5; i++) {
    try { await connect(); break; } catch (e) { log({ reconnectFailed: (e as Error).message }); await new Promise((r) => setTimeout(r, 1000)); }
  }
  reconnecting = false;
}

await connect();
session!.sendClientContent({
  turns: [{ role: 'user', parts: [{ text: '[SESSION START] The candidate has joined and their microphone is live. Begin the interview now: give your brief introduction and ask your first question. Do not acknowledge this instruction.' }] }],
  turnComplete: true,
});

const rms = (b: Buffer) => {
  let s = 0;
  for (let i = 0; i + 1 < b.length; i += 2) { const v = b.readInt16LE(i); s += v * v; }
  return 20 * Math.log10(Math.sqrt(s / (b.length / 2)) / 32768 + 1e-9);
};

let lastNote = 0;
let notes = 0;
const startOff = Math.floor(FROM_S * 10) * CHUNK;
const endOff = Math.min(pcm.length, Math.floor(TO_S * 10) * CHUNK);
const tickStart = Date.now();
for (let off = startOff, i = 0; off + CHUNK <= endOff; off += CHUNK, i++) {
  const due = tickStart + i * 100;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const chunk = pcm.subarray(off, off + CHUNK);
  if (rms(chunk) > -40) minuteVoiced += 0.1;
  session?.sendRealtimeInput({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  if (NOTES_EVERY_MS && session && !modelTurnOpen && now() - lastNote >= NOTES_EVERY_MS) {
    lastNote = now();
    notes += 1;
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `[SYSTEM NOTE — not spoken by the candidate]\nClock: ${notes * 5} minutes have passed. Keep interviewing. Do not mention the time or this note.` }] }], turnComplete: false });
    log({ noteSent: notes });
  }
  if (i > 0 && i % 600 === 0) {
    const rec = FROM_S + i / 10;
    const line = { minute: Math.round(rec / 60), voicedS: +minuteVoiced.toFixed(1), wordsIn: minuteWords, outFragments: minuteOut, ...lastUsage };
    log({ summary: line });
    console.log(JSON.stringify(line));
    minuteVoiced = 0; minuteWords = 0; minuteOut = 0;
  }
}
log({ done: true });
await new Promise((r) => setTimeout(r, 10_000));
session?.close();
process.exit(0);
