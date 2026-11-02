/**
 * Measures speech run boundary drift between original WAV audio and transcoded
 * Opus/FLAC copies, verifying that audio alignment metrics remain stable.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { analyzeWav, type SpeechRun } from '../apps/api/src/evaluation/audio-analysis';

const run = promisify(execFile);
const AUDIO_DIR = join(import.meta.dirname, '../apps/api/data/audio');

/** Transcoding settings for Opus and FLAC codecs. */
const CODECS = {
  opus: ['-c:a', 'libopus', '-b:a', '24k', '-application', 'voip'],
  flac: ['-c:a', 'flac'],
};

/**
 * Pairs runs by index and reports the worst boundary movement. Index pairing is
 * only meaningful when both analyses found the same NUMBER of runs — a codec
 * that splits or merges a run has already failed, and `segments` catches that.
 */
function driftMs(a: SpeechRun[], b: SpeechRun[]) {
  const n = Math.min(a.length, b.length);
  let worstStart = 0;
  let worstEnd = 0;
  let sumStart = 0;
  for (let i = 0; i < n; i++) {
    const ds = Math.abs(a[i]!.startMs - b[i]!.startMs);
    const de = Math.abs(a[i]!.endMs - b[i]!.endMs);
    worstStart = Math.max(worstStart, ds);
    worstEnd = Math.max(worstEnd, de);
    sumStart += ds;
  }
  return { worstStart, worstEnd, meanStart: n ? sumStart / n : 0, paired: n };
}

async function transcode(src: string, dir: string, codec: keyof typeof CODECS) {
  const inter = join(dir, `${basename(src, '.wav')}.${codec === 'opus' ? 'opus' : 'flac'}`);
  const back = join(dir, `${basename(src, '.wav')}.${codec}.wav`);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, ...CODECS[codec], inter]);
  // -bitexact -map_metadata -1 prevents ffmpeg from writing a LIST/INFO
  // chunk where the data chunk normally sits, ensuring samples begin
  // at byte 44 as expected by analyzeWav without adding container
  // metadata padding.
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', inter,
    '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-map_metadata', '-1',
    back,
  ]);
  return back;
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

async function main() {
  const { stdout } = await run('bash', [
    '-c',
    `ls "${AUDIO_DIR}"/*.ai.wav 2>/dev/null | head -12`,
  ]);
  const files = stdout.trim().split('\n').filter(Boolean);
  if (!files.length) throw new Error('no interviewer tracks found');

  const dir = await mkdtemp(join(tmpdir(), 'codec-drift-'));
  console.log(`\nInterviewer-track drift, ${files.length} rounds\n`);
  console.log(
    `${pad('round', 10)} ${pad('codec', 5)} ${pad('segs', 6)} ${pad('voiced Δms', 11)} ` +
      `${pad('worst start Δ', 14)} ${pad('worst end Δ', 12)} ${pad('mean start Δ', 13)}`,
  );
  console.log('-'.repeat(78));

  const worst = { opus: { start: 0, voiced: 0, segs: 0 }, flac: { start: 0, voiced: 0, segs: 0 } };
  try {
    for (const src of files) {
      const base = await analyzeWav(src);
      if (!base) {
        console.log(`${pad(basename(src).slice(0, 8), 10)}  — unreadable, skipped`);
        continue;
      }
      for (const codec of ['flac', 'opus'] as const) {
        const back = await transcode(src, dir, codec);
        const got = await analyzeWav(back);
        if (!got) {
          console.log(`${pad(basename(src).slice(0, 8), 10)} ${pad(codec, 5)}  — decode failed`);
          continue;
        }
        const d = driftMs(base.runs, got.runs);
        const dSegs = got.segments - base.segments;
        const dVoiced = got.voicedMs - base.voicedMs;
        console.log(
          `${pad(basename(src).slice(0, 8), 10)} ${pad(codec, 5)} ${pad(dSegs > 0 ? `+${dSegs}` : dSegs, 6)} ` +
            `${pad(dVoiced > 0 ? `+${dVoiced}` : dVoiced, 11)} ${pad(`${d.worstStart}`, 14)} ` +
            `${pad(`${d.worstEnd}`, 12)} ${pad(d.meanStart.toFixed(1), 13)}`,
        );
        worst[codec].start = Math.max(worst[codec].start, d.worstStart);
        worst[codec].voiced = Math.max(worst[codec].voiced, Math.abs(dVoiced));
        worst[codec].segs = Math.max(worst[codec].segs, Math.abs(dSegs));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log('\nWorst case across all rounds:');
  for (const codec of ['flac', 'opus'] as const) {
    const w = worst[codec];
    console.log(
      `  ${codec}: run boundary ${w.start}ms · voiced total ${w.voiced}ms · segment count ${w.segs}`,
    );
  }
  console.log(
    '\nFLAC must be 0/0/0 — anything else means this harness is wrong, not the codec.',
  );
  console.log('Opus is acceptable if boundaries hold well inside a turn gap (median 2.2s).\n');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
