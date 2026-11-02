/**
 * Verifies the deterministic speech metrics against inputs whose correct
 * answers are known independently — ffmpeg's own silence detection for speech
 * duration, and hand-counted fillers and words for the rest.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeWav } from '../src/evaluation/audio-analysis';
import { computeSpeechMetrics, describeMetrics } from '../src/evaluation/metrics';
import { evaluationReportSchema } from '@orvia/shared';
import { evaluationSchema } from '../src/evaluation/evaluation.schema';
import { walkChain, type ChainAvailability } from '../src/evaluation/model-chain';
import { GeminiEvaluatorProvider, clampReportScores } from '../src/evaluation/providers/gemini.provider';
import { AudioRejectedError } from '../src/evaluation/providers/types';
import { EvaluationService, measureAskedAt, pickShownEvaluation, readFocus, readGuardEvents } from '../src/evaluation/evaluation.service';
import { readRoundConfig, readRoundOptions } from '../src/evaluation/round-config';
import { ExtractionService } from '../src/extraction/extraction.service';
import { align, locateQuote } from '../src/evaluation/alignment';
import { sanitiseSummary, sanitiseTopFixes } from '../src/evaluation/interviewer-blame';
import { buildEvaluatorPrompt, complexityClaims } from '../src/evaluation/rubric.prompt';
import { buildCodeCheckPrompt, CODE_CHECK_SCHEMA, codeCheckReplySchema } from '../src/evaluation/code-check.service';

const exec = promisify(execFile);
const TMP = '/tmp/orvia-metrics-verify';
let pass = 0; let skipped = 0; const fails: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++;
  else fails.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const near = (a: number, b: number, tolPct: number) => Math.abs(a - b) <= Math.abs(b) * tolPct;

async function makeWav(text: string, name: string, leadSilence = 0): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, `${name}.aiff`), sp = join(TMP, `${name}-s.wav`), out = join(TMP, `${name}.wav`);
  await exec('say', ['-v', 'Daniel', '-r', '170', '-o', aiff, text]);
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le', sp]);
  if (leadSilence > 0) {
    await exec('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-t', String(leadSilence), '-i', 'anullsrc=r=16000:cl=mono', '-i', sp,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[o]', '-map', '[o]',
      '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le', out]);
  } else await exec('cp', [sp, out]);
  await rm(aiff, { force: true });
  return out;
}

async function canSynthesise(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await exec('which', ['say']);
    await exec('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Ground truth for speech duration, from ffmpeg rather than from our own code. */
async function ffmpegVoicedMs(path: string): Promise<number> {
  const { stderr } = await exec('ffmpeg', ['-i', path, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'])
    .catch((e: { stderr: string }) => ({ stderr: e.stderr }));
  const total = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)?.slice(1)
    .reduce((a, v, i) => a + Number(v) * [3600, 60, 1][i]!, 0) ?? 0) * 1000;
  let silence = 0;
  for (const m of stderr.matchAll(/silence_duration: ([\d.]+)/g)) silence += Number(m[1]) * 1000;
  return Math.max(0, total - silence);
}

async function main() {
  console.log('\n\x1b[1mSpeech metrics verification\x1b[0m\n');

  /* ── 1. speech duration from the waveform ───────────────────────────────── */
  console.log('\x1b[1m1. voice activity detection\x1b[0m');
  // Sections 1 and 2's pace checks need real speech, synthesised by macOS
  // `say` and converted by ffmpeg. Neither is on CI's ubuntu runner.
  const synth = await canSynthesise();
  if (synth) {
    const SPEECH = 'The approach here is to use a hash map so that lookups are constant time on average, which gives us linear overall.';
    const wav = await makeWav(SPEECH, 'plain');
    const a = (await analyzeWav(wav))!;
    const truth = await ffmpegVoicedMs(wav);
    check('analyzeWav returns a result', !!a);
    check('voiced duration matches ffmpeg silencedetect', near(a.voicedMs, truth, 0.12),
      `ours ${(a.voicedMs / 1000).toFixed(1)}s vs ffmpeg ${(truth / 1000).toFixed(1)}s`);
    check('voiced time never exceeds the recording', a.voicedMs <= a.totalMs,
      `${(a.voicedMs / 1000).toFixed(1)}s of ${(a.totalMs / 1000).toFixed(1)}s`);

    const padded = await makeWav(SPEECH, 'padded', 5);
    const ap = (await analyzeWav(padded))!;
    check('5s of leading silence is excluded from speaking time', near(ap.voicedMs, a.voicedMs, 0.3),
      `padded ${(ap.voicedMs / 1000).toFixed(1)}s vs plain ${(a.voicedMs / 1000).toFixed(1)}s`);
    check('leading silence is detected as a pause', ap.longestSilenceMs >= 3000,
      `longest silence ${(ap.longestSilenceMs / 1000).toFixed(1)}s`);

    /* ── 2. pace ────────────────────────────────────────────────────────────── */
    console.log('\n\x1b[1m2. words per minute\x1b[0m');
    const words = SPEECH.trim().split(/\s+/).length;
    const turns = [
      { speaker: 'ai' as const, text: 'How would you approach this?', startMs: 0, endMs: 3000 },
      { speaker: 'user' as const, text: SPEECH, startMs: 4000, endMs: 4100 },
    ];
    const m = computeSpeechMetrics(turns, a, 3000);
    const expectedWpm = Math.round(words / (a.voicedMs / 60000));
    check('pace derived from the waveform, not turn timestamps', m.wordsPerMinute === expectedWpm,
      `${m.wordsPerMinute} wpm (${words} words / ${(a.voicedMs / 1000).toFixed(1)}s)`);
    check('pace is plausible for speech', (m.wordsPerMinute ?? 0) > 60 && (m.wordsPerMinute ?? 0) < 400, `${m.wordsPerMinute} wpm`);
  } else {
    console.log('  \x1b[33mSKIPPED\x1b[0m voice activity and pace: needs macOS `say` and ffmpeg');
    skipped += 7;
    console.log('\n\x1b[1m2. words per minute\x1b[0m');
  }

  const degenerate = computeSpeechMetrics(
    [{ speaker: 'user', text: 'hi', startMs: 0, endMs: 5 }],
    { totalMs: 5, voicedMs: 5, longestSilenceMs: 0, segments: 1, runs: [] }, 0);
  check('a near-zero duration cannot produce a nonsense pace', degenerate.wordsPerMinute === null,
    `${degenerate.wordsPerMinute} wpm (this used to report 574,286)`);

  /**
   * No candidate waveform: turn timestamps are all that is left, and they land
   * milliseconds apart. Speaking time, pace and talk ratio must be ABSENT, not
   * derived from them, because the evaluator is handed them as fact.
   */
  const noMic = computeSpeechMetrics(
    [{ speaker: 'ai', text: 'Tell me about it.', startMs: 0, endMs: 3000 },
     { speaker: 'user', text: 'We sharded by tenant and moved reads to replicas.', startMs: 90_000, endMs: 90_040 }],
    null, 3000);
  check('no candidate waveform: no speaking time', noMic.totalSpeakingMs === null, `${noMic.totalSpeakingMs}`);
  check('no candidate waveform: no pace', noMic.wordsPerMinute === null,
    `${noMic.wordsPerMinute} (turn timing would give ${Math.round(9 / (40 / 60_000))} wpm)`);
  check('no candidate waveform: no talk ratio', noMic.talkRatio === null, `${noMic.talkRatio}`);
  check('...but the words are still counted', noMic.wordCount === 9, `${noMic.wordCount}`);

  /* ── 3. fillers ─────────────────────────────────────────────────────────── */
  console.log('\n\x1b[1m3. filler words\x1b[0m');
  const FILLER = 'Um, so I think we could, uh, basically use a hash map, you know, and like, actually that is, um, sort of the standard approach, right?';
  const fm = computeSpeechMetrics(
    [{ speaker: 'user', text: FILLER, startMs: 0, endMs: 10_000 }],
    { totalMs: 10_000, voicedMs: 10_000, longestSilenceMs: 0, segments: 1, runs: [] }, 0);
  // Hand-counted: um x2, uh x1, so, x1, basically x1, you know x1, like x1,
  // actually x1, sort of x1, right? x1 = 11
  check('fillers counted', fm.fillerCount >= 9 && fm.fillerCount <= 12,
    `${fm.fillerCount} found: ${Object.entries(fm.fillerBreakdown).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  check('"um" detected', (fm.fillerBreakdown['um'] ?? 0) >= 2, `um ×${fm.fillerBreakdown['um'] ?? 0}`);
  check('"you know" detected as one phrase', (fm.fillerBreakdown['you know'] ?? 0) === 1);
  check('filler rate is per 100 words',
    near(fm.fillerRate, (fm.fillerCount / FILLER.split(/\s+/).length) * 100, 0.02),
    `${fm.fillerRate} per 100 words`);

  const clean = computeSpeechMetrics(
    [{ speaker: 'user', text: 'We use a hash map for constant time lookups.', startMs: 0, endMs: 3000 }],
    { totalMs: 3000, voicedMs: 3000, longestSilenceMs: 0, segments: 1, runs: [] }, 0);
  check('clean speech reports zero fillers', clean.fillerCount === 0, `${clean.fillerCount}`);

  /* ── 4. talk ratio, latency, verbosity ──────────────────────────────────── */
  console.log('\n\x1b[1m4. talk ratio, latency, answer length\x1b[0m');
  const conv = [
    { speaker: 'ai' as const, text: 'Question one?', startMs: 0, endMs: 5000 },
    { speaker: 'user' as const, text: 'one two three four five', startMs: 7000, endMs: 7100 },
    { speaker: 'ai' as const, text: 'Question two?', startMs: 12_000, endMs: 15_000 },
    { speaker: 'user' as const, text: 'six seven eight', startMs: 18_000, endMs: 18_100 },
  ];
  const cm = computeSpeechMetrics(conv,
    { totalMs: 20_000, voicedMs: 8000, longestSilenceMs: 3000, segments: 2, runs: [] }, 8000);
  check('talk ratio uses measured speech on both sides', cm.talkRatio === 0.5,
    `${cm.talkRatio} (8s you / 8s interviewer)`);
  check('talk ratio stays within 0..1', cm.talkRatio !== null && cm.talkRatio > 0 && cm.talkRatio <= 1);
  // Turn gaps here are 2000 and 3000ms. Without the interviewer's waveform
  // that is all there is, and it measures the answer, not the pause.
  check('no interviewer recording: no latency rather than a turn gap', cm.medianResponseLatencyMs === null,
    `${cm.medianResponseLatencyMs}`);

  /**
   * Forwarded interviewer bytes include the model's own pauses. With its
   * waveform available the denominator is its VOICED time: 8s of the
   * candidate against 4s voiced of 8s forwarded is 67%, not 50%.
   */
  const vr = computeSpeechMetrics(conv,
    { totalMs: 20_000, voicedMs: 8000, longestSilenceMs: 3000, segments: 2, runs: [] }, 8000, null,
    { totalMs: 20_000, voicedMs: 4000, longestSilenceMs: 0, segments: 2, runs: [] });
  check('talk ratio divides by the interviewer\'s voiced time when its recording exists',
    vr.talkRatio === 0.667, `${vr.talkRatio} (forwarded bytes would say 0.5)`);
  check('mean answer length correct', cm.meanTurnWords === 4,
    `${cm.meanTurnWords} words (5 and 3 across 2 answers)`);
  check('word count sums both answers', cm.wordCount === 8, `${cm.wordCount}`);

  /* ── 5. verbatim transcript preferred ───────────────────────────────────── */
  console.log('\n\x1b[1m5. transcript source\x1b[0m');
  const vm = computeSpeechMetrics(
    [{ speaker: 'user', text: 'We use a hash map.', startMs: 0, endMs: 5000 }],
    { totalMs: 5000, voicedMs: 5000, longestSilenceMs: 0, segments: 1, runs: [] }, 0,
    'Um, we, uh, use a hash map, you know.');
  check('verbatim re-transcription is preferred for filler counting', vm.fillerCount >= 3,
    `${vm.fillerCount} fillers found in the verbatim text, 0 in the live one`);

  /**
   * Higher filler count is preferred between verbatim and live passes,
   * since ASR passes miss fillers rather than hallucinating them.
   */
  const lm = computeSpeechMetrics(
    [{ speaker: 'user', text: 'Uh, so, uh, we, uh, use a hash map, um, like, you know.', startMs: 0, endMs: 5000 }],
    { totalMs: 5000, voicedMs: 5000, longestSilenceMs: 0, segments: 1, runs: [] }, 0,
    'We use a hash map.');
  check('a verbatim pass that heard FEWER fillers is not trusted over the live one',
    lm.fillerCount >= 5, `${lm.fillerCount} fillers (verbatim text contains none)`);

  /* ── 6. response latency and dead air, from both waveforms ──────────────── */
  console.log('\n\x1b[1m6. latency and dead air from the waveforms\x1b[0m');

  /**
   * The failure this replaces: a user turn's startMs is when its transcript
   * burst ARRIVED, so the turn-gap "pause" is really the length of the answer.
   * Here the interviewer stops at 5s, the candidate starts at 7s and talks for
   * a full minute — a 2s pause that the turn timings would report as 62s.
   */
  const mineRuns = { totalMs: 70_000, voicedMs: 60_000, longestSilenceMs: 0, segments: 1,
    runs: [{ startMs: 7000, endMs: 67_000 }] };
  const theirRuns = { totalMs: 70_000, voicedMs: 5000, longestSilenceMs: 0, segments: 1,
    runs: [{ startMs: 0, endMs: 5000 }] };
  const wm = computeSpeechMetrics(
    [{ speaker: 'ai', text: 'How would you approach this?', startMs: 0, endMs: 5000 },
     { speaker: 'user', text: 'A long answer that arrives all at once at the end.', startMs: 67_000, endMs: 67_100 }],
    mineRuns, 5000, null, theirRuns);
  check('latency is the pause, not the length of the answer', wm.medianResponseLatencyMs === 2000,
    `${wm.medianResponseLatencyMs}ms (turn gap would have said 62000ms)`);

  /**
   * Dead air must exclude the interviewer talking. Candidate speaks 0-2s and
   * 20-22s; the interviewer fills 5-18s. The candidate-only view calls that an
   * 18s silence; nobody was actually silent for more than 2s at a stretch.
   */
  const dm = computeSpeechMetrics(
    [{ speaker: 'user', text: 'one two three', startMs: 0, endMs: 2000 },
     { speaker: 'ai', text: 'and then?', startMs: 5000, endMs: 18_000 },
     { speaker: 'user', text: 'four five six', startMs: 20_000, endMs: 22_000 }],
    { totalMs: 22_000, voicedMs: 4000, longestSilenceMs: 18_000, segments: 2,
      runs: [{ startMs: 0, endMs: 2000 }, { startMs: 20_000, endMs: 22_000 }] },
    13_000, null,
    { totalMs: 22_000, voicedMs: 13_000, longestSilenceMs: 0, segments: 1,
      runs: [{ startMs: 5000, endMs: 18_000 }] });
  check('dead air does not count the interviewer talking as your silence',
    dm.longestSilenceMs === 3000, `${dm.longestSilenceMs}ms (candidate-only view said 18000ms)`);
  check('latency and dead air stay consistent with each other',
    dm.medianResponseLatencyMs !== null && dm.longestSilenceMs !== null &&
      dm.medianResponseLatencyMs <= dm.longestSilenceMs,
    `median pause ${dm.medianResponseLatencyMs}ms vs longest ${dm.longestSilenceMs}ms`);

  /**
   * Without an interviewer recording, response latency and dead air are omitted
   * rather than estimated from turn gaps.
   */
  const fb = computeSpeechMetrics(
    [{ speaker: 'ai', text: 'go', startMs: 0, endMs: 1000 },
     { speaker: 'user', text: 'ok then', startMs: 4000, endMs: 5000 }],
    { totalMs: 5000, voicedMs: 1000, longestSilenceMs: 4000, segments: 1,
      runs: [{ startMs: 4000, endMs: 5000 }] }, 1000);
  check('no interviewer track: no latency', fb.medianResponseLatencyMs === null, `${fb.medianResponseLatencyMs}`);
  check('no interviewer track: no dead air', fb.longestSilenceMs === null, `${fb.longestSilenceMs}`);

  const described = describeMetrics(fb);
  check('describeMetrics says the pause was not measured',
    /Median pause before answering: not measured/.test(described) && !/measured from the interviewer's voice/.test(described),
    described.split('\n').find((l) => l.includes('pause')) ?? '');
  check('...and the dead air', /neither person speaking: not measured/.test(described));
  const describedNoMic = describeMetrics(noMic);
  check('describeMetrics says pace, speaking time and talk ratio were not measured',
    /Pace: not measured/.test(describedNoMic) && /Speaking time: not measured/.test(describedNoMic) &&
      /Talk ratio: not measured/.test(describedNoMic) && !/NaN|null/.test(describedNoMic),
    describedNoMic.split('\n')[1] ?? '');

  /* ── 7. placing a quote in the recording ────────────────────────────────── */
  console.log('\n\x1b[1m7. locating an evidence quote\x1b[0m');

  const longTurn =
    'Okay so let me start with the brute force way first ' +
    Array.from({ length: 60 }, (_, i) => `filler word number ${i}`).join(' ') +
    ' and so do I have to explain it again';
  const qTurns = [
    { speaker: 'ai' as const, text: 'How would you approach this?', startMs: 0, endMs: 5000 },
    { speaker: 'user' as const, text: longTurn, startMs: 200_000, endMs: 200_100 },
  ];
  const qAlign = align(qTurns,
    { totalMs: 210_000, voicedMs: 190_000, longestSilenceMs: 0, segments: 1,
      runs: [{ startMs: 10_000, endMs: 200_000 }] },
    { totalMs: 210_000, voicedMs: 5000, longestSilenceMs: 0, segments: 1,
      runs: [{ startMs: 0, endMs: 5000 }] });

  check('candidate stretches zip onto candidate turns', qAlign.stretchesMatchTurns,
    `${qAlign.candidateStretches.length} stretches, 1 turn`);

  const early = locateQuote('let me start with the brute force way first', qTurns, qAlign);
  const late = locateQuote('so do I have to explain it again', qTurns, qAlign);
  check('a quote from the start of an answer lands near its start',
    early !== null && early < 40_000, `${early}ms`);
  check('a quote from the end of an answer lands near its end',
    late !== null && late > 150_000, `${late}ms`);
  check('a quote is placed inside the audible stretch, not at the turn timestamp',
    early !== null && early >= 10_000 && early <= 200_000, `${early}ms within 10000-200000ms`);
  check('a quote that was never said returns nothing rather than a guess',
    locateQuote('the mitochondria is the powerhouse of the cell', qTurns, qAlign) === null);
  check('a quote too short to place returns nothing', locateQuote('okay', qTurns, qAlign) === null);

  /**
   * The evaluator quotes the verbatim transcript, which may contain lines absent
   * from live turns. Segment timestamps place quotes that lack per-turn alignment.
   */
  const segs = [
    { startMs: 0, endMs: 120_000, text: 'nothing relevant in this first stretch at all' },
    { startMs: 120_000, endMs: 240_000, text: 'padding padding padding this is fine it will work this is the solution padding' },
  ];
  const viaSegment = locateQuote('this is fine it will work this is the solution', qTurns, qAlign, segs);
  check('a quote only in the verbatim transcript is placed from its segment',
    viaSegment !== null && viaSegment >= 120_000 && viaSegment < 240_000, `${viaSegment}ms`);
  check('the segment fallback still refuses a quote nobody said',
    locateQuote('entirely unrelated words about marine biology', qTurns, qAlign, segs) === null);


  /* ── 8. the response schema agrees with the zod contract ────────────────── */
  console.log('\n\x1b[1m8. response schema vs contract\x1b[0m');
  {
    /**
     * Fields required by the zod schema must be declared required in the response schema;
     * nullable fields must be explicitly required so null is emitted rather than omitted.
     */
    type Def = { type: string; innerType?: Z; element?: Z; shape?: Record<string, Z> };
    type Z = { _zod: { def: Def }; minValue?: number | null; maxValue?: number | null; shape?: Record<string, Z> };
    type S = { type?: string; nullable?: boolean; properties?: Record<string, S>; required?: string[];
      items?: S; minimum?: number; maximum?: number };
    const problems: string[] = [];
    const unwrap = (z: Z) => {
      let optional = false, nullable = false, cur = z;
      for (;;) {
        const t = cur._zod.def.type;
        if (t === 'optional' || t === 'default' || t === 'prefault') optional = true;
        else if (t === 'nullable') nullable = true;
        else return { optional, nullable, core: cur };
        cur = cur._zod.def.innerType!;
      }
    };
    const walk = (z: Z, sch: S, path: string) => {
      const { core } = unwrap(z);
      const t = core._zod.def.type;
      if (t === 'array') return walk(core._zod.def.element!, sch.items ?? {}, `${path}[]`);
      if (t === 'number') {
        if (Number.isFinite(core.minValue) && sch.minimum !== core.minValue) problems.push(`${path}: minimum ${sch.minimum} vs zod ${core.minValue}`);
        if (Number.isFinite(core.maxValue) && sch.maximum !== core.maxValue) problems.push(`${path}: maximum ${sch.maximum} vs zod ${core.maxValue}`);
        return;
      }
      if (t !== 'object') return;
      const shape = core.shape ?? core._zod.def.shape ?? {};
      const props = sch.properties ?? {};
      const req = new Set(sch.required ?? []);
      for (const key of Object.keys(props)) if (!(key in shape)) problems.push(`${path}.${key}: in the response schema, stripped by zod`);
      for (const [key, field] of Object.entries(shape)) {
        const f = unwrap(field);
        const p = props[key];
        const at = `${path}.${key}`;
        if (!p) { if (!f.optional) problems.push(`${at}: zod requires it, the response schema never asks`); continue; }
        if (!f.optional && !req.has(key)) problems.push(`${at}: zod requires it, the response schema does not`);
        if (f.nullable && !p.nullable) problems.push(`${at}: nullable in zod, not in the response schema`);
        if (p.nullable && !f.nullable) problems.push(`${at}: nullable in the response schema, zod rejects null`);
        if (f.nullable && !f.optional && !req.has(key)) problems.push(`${at}: nullable-required, so it must be in required`);
        if (/quote/i.test(key) && !(f.nullable && req.has(key))) problems.push(`${at}: quotes the candidate, must be required AND nullable`);
        walk(field, p, at);
      }
    };
    walk(evaluationReportSchema as unknown as Z, evaluationSchema(['two-sum'], ['commitment-1']) as S, 'report');
    check('every field agrees between the zod contract and the response schema', problems.length === 0,
      problems.join('; ') || 'presence, required, nullable, bounds');
    const complexity = (evaluationSchema() as S).properties!.questions!.items!.properties!.complexity!.items!;
    check('complexity statedQuote must be emitted as an explicit null', complexity.required!.includes('statedQuote'));

    const out = clampReportScores({ overallScore: 104, questions: [{ score: -1 }], delivery: [{ score: 0 }, { score: 6 }] }) as
      { overallScore: number; questions: { score: number }[]; delivery: { score: number }[] };
    check('one out-of-range score is clamped instead of discarding the report',
      out.overallScore === 100 && out.questions[0]!.score === 0 && out.delivery[0]!.score === 1 && out.delivery[1]!.score === 5,
      JSON.stringify(out));
  }

  /* ── 9. walking a model chain ───────────────────────────────────────────── */
  console.log('\n\x1b[1m9. the shared chain walker\x1b[0m');
  const stubAvailability = () => {
    const notes: string[] = [];
    const a: ChainAvailability & { notes: string[] } = {
      notes,
      order: (c) => [...c],
      noteQuotaError: (m) => { notes.push(`quota:${m}`); },
      noteError: (m) => { notes.push(`error:${m}`); },
      noteSuccess: (m) => { notes.push(`ok:${m}`); },
    };
    return a;
  };
  const apiError = (status: number, text: string) => Object.assign(new Error(`{"error":{"code":${status},"status":"${text}"}}`), { status });
  {
    const av = stubAvailability();
    const calls: string[] = [];
    const sleeps: number[] = [];
    const r = await walkChain(['a', 'b'], av, async (m) => {
      calls.push(m);
      if (m === 'a' && calls.length < 3) throw apiError(503, 'UNAVAILABLE');
      return m;
    }, { sleep: async (ms) => { sleeps.push(ms); } });
    check('a 503 backs off and retries the SAME model', r.ok && r.model === 'a' && calls.join() === 'a,a,a',
      `${calls.join()} with sleeps ${sleeps.join()}ms`);
  }
  {
    const av = stubAvailability();
    const r = await walkChain(['a', 'b'], av, async (m) => {
      if (m === 'a') throw apiError(429, 'RESOURCE_EXHAUSTED');
      return m;
    });
    check('a 429 notes the quota and moves to the next model', r.ok && r.model === 'b' && av.notes.includes('quota:a'),
      av.notes.join());
  }
  {
    const av = stubAvailability();
    const r = await walkChain(['a', 'b'], av, async (m) => {
      if (m === 'a') return evaluationReportSchema.parse({ nonsense: true });
      return m;
    });
    check('unparseable output moves on WITHOUT a shared cooldown',
      r.ok && r.model === 'b' && !av.notes.some((n) => n.startsWith('error:a')), av.notes.join());
  }
  {
    const av = stubAvailability();
    const r = await walkChain(['a', 'b'], av, async () => { throw apiError(400, 'INVALID_ARGUMENT'); });
    check('a 400 is the payload, not the model: no cooldown on either',
      !r.ok && r.failures.every((f) => f.kind === 'invalid_request') && !av.notes.some((n) => n.startsWith('error')),
      av.notes.join() || 'no cooldowns');
  }
  {
    const av = stubAvailability();
    let aborted = false;
    const t0 = Date.now();
    const r = await walkChain(['a', 'b'], av, (m, signal) => {
      if (m === 'b') return Promise.resolve(m);
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise<string>(() => {});
    }, { callTimeoutMs: 200 });
    check('a hung call is abandoned at its deadline and the next model tried',
      r.ok && r.model === 'b' && aborted && Date.now() - t0 < 2000, `${Date.now() - t0}ms, aborted=${aborted}`);
  }
  {
    const av = stubAvailability();
    let calls = 0;
    const r = await walkChain(['a', 'b', 'c'], av, () => { calls++; return new Promise<string>(() => {}); },
      { callTimeoutMs: 150, budgetMs: 250 });
    check('the walk budget stops it before every model has hung', !r.ok && calls === 2, `${calls} calls`);
  }

  /* ── 10. the evaluator: a request rejected with the recording attached ──── */
  console.log('\n\x1b[1m10. a recording the evaluator will not accept\x1b[0m');
  {
    const av = stubAvailability();
    const seen: boolean[] = [];
    const ai = { models: { generateContent: async (req: { contents: { parts: unknown[] }[] }) => {
      seen.push(req.contents[0]!.parts.length > 1);
      throw apiError(400, 'INVALID_ARGUMENT');
    } } };
    const provider = new GeminiEvaluatorProvider(ai as never, av);
    const err = await provider.evaluate('p', { data: 'AAAA', mimeType: 'audio/wav', path: '/x' }).catch((e: Error) => e);
    check('every model rejecting the payload with audio attached raises AudioRejected',
      (err as Error).name === 'AudioRejectedError', `${(err as Error).name}`);
    check('...without putting any evaluator model on a cooldown', !av.notes.some((n) => n.startsWith('error')));

    const prompts: string[] = [];
    const audios: (unknown | null)[] = [];
    const svc = new EvaluationService({} as never, { GEMINI_API_KEY: 'test' } as never, {} as never,
      {} as never, {} as never, {} as never, {} as never);
    (svc as unknown as { provider: unknown }).provider = {
      name: 'stub', supportsAudio: true,
      evaluate: async (prompt: string, audio: unknown) => {
        prompts.push(prompt); audios.push(audio);
        if (audio) throw new AudioRejectedError('400 with audio');
        return { report: {}, provider: 'stub', model: 'm', audioAnalysed: false };
      },
    };
    const input = {
      mode: 'dsa' as const, durationMinutes: 30, actualMinutes: 30, difficulty: 'standard',
      transcript: [{ speaker: 'ai' as const, text: 'Hello.', startMs: 0 }],
      metrics: fb, referenceMaterial: '', writtenContext: null, assignedQuestions: [],
    };
    const res = await (svc as unknown as { callEvaluator: (i: unknown, a: unknown, ids: string[]) => Promise<{ audioAnalysed: boolean }> })
      .callEvaluator(input, { data: 'AAAA', mimeType: 'audio/wav', path: '/x' }, []);
    check('the evaluation is retried once, transcript-only', audios.length === 2 && audios[1] === null && !res.audioAnalysed);
    check('...with the prompt REBUILT to say there is no recording', prompts[0] !== prompts[1],
      'the prompt tells the model whether it can hear the audio');
  }

  /* ── 11. which report is shown, and what can be stored ──────────────────── */
  console.log('\n\x1b[1m11. the report a failed re-run must not hide\x1b[0m');
  {
    const good = { id: 'e1', status: 'complete' };
    const failedRerun = { id: 'e2', status: 'failed' };
    const running = { id: 'e3', status: 'evaluating' };
    const a = pickShownEvaluation(failedRerun, good);
    check('a failed re-run shows the earlier complete report', a.shown.id === 'e1' && a.superseded?.id === 'e2');
    const b = pickShownEvaluation(running, good);
    check('an in-flight re-run is shown, so the report screen keeps polling for it',
      b.shown.id === 'e3' && b.superseded === null);
    const c = pickShownEvaluation(failedRerun, null);
    check('a failure with nothing earlier is shown as the failure', c.shown.id === 'e2');

  }

  /* ── 12. reading a stored round config ──────────────────────────────────── */
  console.log('\n\x1b[1m12. stored round config\x1b[0m');
  {
    // Fails `interviewConfigSchema` (jobDescription under 50 chars); only the
    // bad field may be lost, never the whole config.
    const cfg = readRoundConfig({ mode: 'jd', jobDescription: 'short', questionIds: 'not-a-list', problemId: 'rate-limiter' });
    check('a malformed field costs only that field', cfg.jobDescription === 'short' &&
      cfg.questionIds === undefined && cfg.problemId === 'rate-limiter', JSON.stringify(cfg));
    check('a config that is not an object reads as empty', Object.keys(readRoundConfig('garbage')).length === 0);
    const opts = readRoundOptions({ durationMinutes: 'forty', difficulty: 'hard' });
    check('options degrade per field to null, never to an invented value',
      opts.durationMinutes === null && opts.difficulty === 'hard', JSON.stringify(opts));
  }

  /* ── 13. extraction replies are validated before they are cached ─────────── */
  console.log('\n\x1b[1m13. extraction output\x1b[0m');
  {
    const av = stubAvailability();
    let calls = 0;
    const ex = new ExtractionService({ GEMINI_API_KEY: 'test' } as never, av as never);
    (ex as unknown as { ai: unknown }).ai = { models: { generateContent: async () => {
      calls++;
      return { text: JSON.stringify({ role: 'Backend engineer', seniority: 'senior' }) };
    } } };
    const jd = 'We need a senior backend engineer to own our payments ledger and its reconciliation jobs.';
    const first = await ex.jobDescription(jd);
    check('a reply missing required fields is refused, not cached', first === null, `${calls} calls`);
    const before = calls;
    await ex.jobDescription(jd);
    check('...so the next round asks again rather than reusing it', calls > before);
  }

  /* ── 14. what the report measures instead of believing ───────────────────── */
  console.log('\n\x1b[1m14. the report on a round the interviewer broke\x1b[0m');
  {
    // Sample interviewer turns with repeated questions and timestamps.
    const ai = (startMs: number, endMs: number, text: string) => ({ speaker: 'ai' as const, startMs, endMs, text });
    const PARTITION = 'Given an integer array nums, return true if you can partition the array into two subsets such that the sum of the elements in both subsets is equal, or false otherwise.';
    const MERGE = 'Given a list of intervals represented by start and end times, merge all overlapping intervals and return a list of non-overlapping intervals that cover the same overall ranges. Note that intervals touching at an endpoint, like one ending at four and another starting at four, are considered overlapping.';
    const turns = [
      ai(48155, 66505, "Hello. I'm an engineer here, and today we'll be working through some problems together. Right, let's move on to question one. You are given an array of non-negative integers where each element represents your maximum jump length from that position. Starting at the first index, determine if you can reach the final index of the array."),
      ai(143815, 154134, "That's correct, though the values are non-negative, which includes zero. You are starting at the first index, and you need to determine if you can reach the final index. What's your approach?"),
      ai(357077, 369835, `Understood. Let's move on to question two. ${PARTITION} What are your thoughts on this one?`),
      ai(910303, 913401, `Understood. Right, let's move on to question two. ${PARTITION} What are your initial thoughts on this`),
      ai(965086, 979160, `Right. Understood. Let's move on to question two. ${PARTITION} What's your approach?`),
      ai(997770, 1005796, "Yes, you need to partition the array into two subsets such that the sum of the elements in both subsets is equal. What's your approach for doing that?"),
      ai(2294642, 2371690, "Right, let's move on to question three. You are given an array of non-overlapping intervals intervals where intervals i equals starting i, ending i, representing the start and the end of the i-th interval, and intervals is sorted in ascending order by starting i. You are also given an interval newInterval equals start, end, that represents the start and end of another interval. Two intervals are considered overlapping if they share at least one point. Insert newInterval into intervals such that intervals is still sorted in ascending order by starting i, and intervals still does not have any overlapping intervals, merging overlapping intervals if necessary. Return intervals after the insertion."),
      ai(2806218, 2812212, `Right, let's move on to question four. ${MERGE} What's your approach for this one?`),
      ai(3423084, 3442651, `Right, let's move on to question four. ${MERGE} What's your approach for solving this?`),
      ai(3500279, 3507581, "That's correct, you need to merge all overlapping intervals and return a list of non-overlapping intervals. What's your approach for achieving that?"),
      ai(3682821, 3714623, "Right, let's move on to question five. There is an m by n rectangular island that borders both the Pacific Ocean and Atlantic Ocean. The Pacific Ocean touches the island's left and top edges, and the Atlantic Ocean touches the island's right and bottom edges. Water can flow from any cell adjacent to an ocean into the ocean. Return a 2D list of grid coordinates where rain water can flow from that cell to both the Pacific and Atlantic oceans. How would you solve this problem?"),
      ai(4677362, 4681749, `Right, let's move on to question two. ${PARTITION}`),
    ];
    // The evaluator's own paraphrases, verbatim from that report.
    const questions = [
      { question: 'You are given an array of non-negative integers where each element represents your maximum jump length from that position. Starting at the first index, determine if you can reach the final index of the array.' },
      { question: PARTITION },
      { question: 'You are given an array of non-overlapping intervals sorted by start time and a new interval. Insert the new interval into intervals such that the intervals remain sorted and non-overlapping, merging if necessary.' },
      { question: 'Given a list of intervals, merge all overlapping intervals and return a list of non-overlapping intervals that cover the same overall ranges.' },
      { question: 'There is an m by n rectangular island bordering Pacific and Atlantic oceans. Return a 2D list of grid coordinates where rain water can flow to both oceans.' },
    ];
    const asked = measureAskedAt(questions, turns, [], 4699408);
    check('each question is placed at the interviewer turn that read it',
      JSON.stringify(asked) === JSON.stringify([48155, 357077, 2294642, 2806218, 3682821]), JSON.stringify(asked));
    check('...never at the backward re-read of a finished problem at 77:57', !asked.includes(4677362));

    const flagged = measureAskedAt(questions, turns,
      [{ atMs: 369000, kind: 'premature_advance', said: 'move on to question two', corrected: true }], 4699408);
    check('a reading the live guard flagged as premature is not when the question was asked',
      flagged[1] === 910303, String(flagged[1]));
    check('a question the transcript never read gets no time rather than a guess',
      measureAskedAt([{ question: 'Design a URL shortener that scales to a billion users.' }], turns, [], 4699408)[0] === null);

    check('stored guard events that do not parse read as none',
      readGuardEvents([{ atMs: -1, kind: 'nonsense' }]).length === 0 && readGuardEvents(null).length === 0);

    const f836Fixes = [
      'Always trace your code line by line with a small example to catch scope errors like missing variables before moving on.',
      'Carefully review the exact boundary conditions for interval merging rather than relying on inverted comparison operators.',
      'Maintain composure and continue methodically when the interviewer repeats questions or experiences prolonged silence.',
    ];
    const fixes = sanitiseTopFixes(f836Fixes, ['State the greedy approach and time/space complexities upfront before writing code.']);
    check("a fix about reacting to the interviewer is dropped",
      fixes.dropped.length === 1 && fixes.dropped[0] === f836Fixes[2], JSON.stringify(fixes.dropped));
    check('...and refilled from the report\'s own advice, so there are still three',
      fixes.fixes.length === 3 && fixes.fixes[2]!.startsWith('State the greedy'));
    check('a fix that merely mentions the interviewer survives',
      sanitiseTopFixes(['Ask the interviewer for the input size before you pick an approach.'], []).fixes.length === 1);
    check("a fix about the CANDIDATE's own silences survives",
      sanitiseTopFixes(['Avoid long silences while you think; narrate your reasoning so the interviewer can follow.'], []).fixes.length === 1);
    check('a fix that uses "connection" in its technical sense survives',
      sanitiseTopFixes(['Make the connection between subset sum and the 0/1 knapsack before you code.'], []).fixes.length === 1);
    check('a fix about the interviewer going silent is still dropped',
      sanitiseTopFixes(['Keep going when the interviewer goes silent for a long stretch.'], []).fixes.length === 0);

    const f836Summary =
      'You demonstrated strong algorithmic intuition on several problems. However, you struggled with implementation details on three problems. ' +
      "Your communication was generally collaborative, but you allowed the interviewer's technical glitches and repetitive questioning to occasionally disrupt your focus. " +
      'To reach the next level, you must focus on meticulously tracing your code.';
    const s = sanitiseSummary(f836Summary, {
      deadMs: 828039,
      guardEvents: [
        { atMs: 4019000, kind: 'false_close', said: "We're about out of time", corrected: true },
        { atMs: 4522000, kind: 'false_close', said: 'Thanks for your time today', corrected: true },
      ],
    });
    check('the summary sentence blaming the candidate for our glitches is removed',
      !/allowed the interviewer/.test(s.summary) && s.dropped.length === 1, s.dropped.join(' | '));
    check('...and the measured faults are stated in its place',
      /stopped responding for 13m48s in total/.test(s.summary) && /announced the round was over twice/.test(s.summary), s.summary);
    check('a summary sentence praising composure under a dead line is kept',
      /composure/.test(sanitiseSummary('You kept excellent composure while the interviewer was silent.', { deadMs: 0, guardEvents: [] }).summary));
    check('a clean round gets no fault sentence',
      sanitiseSummary('You solved it.', { deadMs: 0, guardEvents: [] }).summary === 'You solved it.');

    const schema = evaluationSchema() as unknown as { properties: { questions: { items: { properties: Record<string, { properties?: unknown; items?: { properties: Record<string, unknown> } }> } } } };
    const qProps = schema.properties.questions.items.properties;
    check('the model is no longer asked for startMs or statedAtMs',
      !('startMs' in qProps) && !('statedAtMs' in (qProps.complexity!.items!.properties)));

    const base = {
      mode: 'dsa' as const, durationMinutes: 80, actualMinutes: 78, difficulty: 'standard',
      transcript: [
        { speaker: 'user' as const, text: 'Time complexity of the solution is n log n space. Complexity is. O of n.', startMs: 2762000 },
        { speaker: 'user' as const, text: 'Yeah, now I think I came up with the solution using which I can do this in O of n time complexity and constant space. So, instead of doing the sort again.', startMs: 3010000 },
      ],
      metrics: fb, referenceMaterial: '', writtenContext: null, assignedQuestions: [], hasAudio: false,
    };
    const claims = complexityClaims(base.transcript);
    check('every complexity claim is extracted in order, the revision last',
      claims.length >= 2 && /O of n time complexity and constant space/.test(claims.at(-1)!), claims.join(' || '));
    const prompt = buildEvaluatorPrompt({
      ...base,
      guardEvents: [{ atMs: 2806218, kind: 'premature_advance', said: "Right, let's move on to question four.", corrected: true }],
      codeChecks: [{
        questionId: 'partition-equal-subset-sum', title: 'Partition Equal Subset Sum', verdict: 'incomplete',
        failingInput: 'nums = [1, 5, 11, 5]', expected: 'true', actual: 'NameError', whatBreaks: '`total` is read but never assigned.',
        otherFaults: ['`hset` is never reassigned to `newSet`, so the set of reachable sums never grows past single elements.'],
      }],
    });
    check('a measured premature advance reaches the evaluator as a fact',
      /moved on to the next problem while this one was still unfinished/.test(prompt));
    check('every fault the code check found reaches the evaluator, not only the first',
      prompt.includes('never reassigned to `newSet`') && /Also broken, independently/.test(prompt));
    check('the rubric forbids fixes about reacting to the interviewer', prompt.includes('No `topFixes` entry'));
    check('a round with no guard events gets no guard section',
      !buildEvaluatorPrompt(base).includes('caught by the app while the round ran'));

    const cc = CODE_CHECK_SCHEMA as { required: readonly string[]; properties: Record<string, unknown> };
    check('the code check must return otherFaults, as an explicit list',
      cc.required.includes('otherFaults') && 'otherFaults' in cc.properties);
    check('...and is told to find every fault, not the first',
      /Find EVERY fault, not just the first/.test(buildCodeCheckPrompt({ title: 't', prompt: 'p' }, 'x', 'python')));
    check('a stored code-check reply from before otherFaults still parses',
      codeCheckReplySchema.safeParse({ trace: 't', verdict: 'correct', failingInput: null, expected: null, actual: null, whatBreaks: null }).success);

    // Large WAV recordings exceeding the cap are compressed. Needs ffmpeg,
    // which CI's runner has; a 33-minute tone is ~63MB of WAV.
    const svc = new EvaluationService({} as never, { GEMINI_API_KEY: 'test' } as never, {} as never,
      {} as never, {} as never, {} as never, {} as never);
    const load = (p: string | null) => (svc as unknown as {
      loadAudio: (p: string | null) => Promise<{ payload: { mimeType: string; data: string } | null; reason: string | null }>;
    }).loadAudio(p);
    const missing = await load(join(TMP, 'no-such-round.wav'));
    check('a missing recording says why, for the report', missing.payload === null && !!missing.reason, missing.reason ?? '');
    const hasFfmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);
    if (hasFfmpeg) {
      await mkdir(TMP, { recursive: true });
      const long = join(TMP, 'long-round.wav');
      await exec('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-t', '1980', '-i', 'sine=frequency=220:sample_rate=16000',
        '-ac', '1', '-acodec', 'pcm_s16le', long]);
      const got = await load(long);
      check('a recording past the cap is compressed and SENT, not dropped',
        got.payload?.mimeType === 'audio/mp3' && got.reason === null,
        got.payload ? `${(Buffer.from(got.payload.data, 'base64').length / 1e6).toFixed(1)}MB of mp3` : got.reason ?? '');
      await rm(long, { force: true });
    } else {
      skipped++;
      console.log('  \x1b[33m-\x1b[0m SKIPPED: no ffmpeg, so the long-recording compression path is untested here');
    }
  }

  /* ── 15. what the candidate was working on ──────────────────────────────── */
  console.log('\n\x1b[1m15. focus checks: commitments and drills\x1b[0m');
  {
    type S = { properties: Record<string, { items: { properties: Record<string, { enum?: string[] }> } }>; required: string[] };
    const keys = ['c-1', 'c-2'];
    const withFocus = evaluationSchema(['two-sum'], keys) as unknown as S;
    check('a round carrying focus must return a check per item, keyed by a CLOSED enum',
      withFocus.required.includes('focusChecks') &&
        JSON.stringify(withFocus.properties.focusChecks!.items.properties.key!.enum) === JSON.stringify(keys));
    check('...and still returns its assigned-problem outcomes beside them',
      withFocus.required.includes('assignedQuestions'));
    const plain = evaluationSchema(['two-sum']) as unknown as S;
    check('a round with no focus is not asked for any checks',
      !('focusChecks' in plain.properties) && !plain.required.includes('focusChecks'));

    const base = {
      mode: 'dsa' as const, durationMinutes: 30, actualMinutes: 30, difficulty: 'standard',
      transcript: [{ speaker: 'ai' as const, text: 'Hello.', startMs: 0 }],
      metrics: fb, referenceMaterial: '', writtenContext: null, hasAudio: false,
    };
    const focus = [
      { key: 'c-1', text: 'State the complexity before writing code', source: 'commitment' as const },
      { key: 'c-2', text: 'Lead with the approach', source: 'commitment' as const },
    ];
    const withF = buildEvaluatorPrompt({ ...base, focus });
    check('the evaluator is told every focus item with its key',
      focus.every((f) => withF.includes(f.key) && withF.includes(f.text)));
    check('...and that the checks must not move any score',
      /SEPARATE verdict/.test(withF) && /must not move any score/.test(withF));
    check('a round with no focus gets no focus section',
      !buildEvaluatorPrompt(base).includes('What the candidate was working on'));
    check('a drill is described as a drill, to the evaluator only',
      /short drill/.test(buildEvaluatorPrompt({ ...base, focus, isDrill: true })) &&
        /short DRILL of one question/.test(buildEvaluatorPrompt({ ...base, focus, isDrill: true })));
    check('an interviewer style is named, with the anchors unchanged',
      /Interviewer style: Amazon/.test(buildEvaluatorPrompt({ ...base, style: 'amazon' })) &&
        /never the anchors/.test(buildEvaluatorPrompt({ ...base, style: 'amazon' })));
    check('no line at all for general, none, or a style that is not one',
      !/Interviewer style/.test(buildEvaluatorPrompt({ ...base, style: 'general' })) &&
        !/Interviewer style/.test(buildEvaluatorPrompt(base)) &&
        !/Interviewer style/.test(buildEvaluatorPrompt({ ...base, style: 'netflix' })));

    check('a stored focus that does not parse is read as none, never half-read',
      readFocus([{ key: 'k', text: 't', source: 'commitment' }, { key: 1 }]).length === 0 &&
        readFocus(null).length === 0 && readFocus(focus).length === 2);

    const inserted: Record<string, unknown>[][] = [];
    const svc = new EvaluationService({} as never, { GEMINI_API_KEY: 'test' } as never, {} as never,
      {} as never, {} as never, {} as never, {} as never);
    const writer = { insert: () => ({ values: async (rows: Record<string, unknown>[]) => { inserted.push(rows); } }) };
    await (svc as unknown as {
      persistFocusChecks: (db: unknown, evalId: string, reported: unknown[], focus: unknown[]) => Promise<void>;
    }).persistFocusChecks(writer, 'e1', [
      { key: 'c-1', result: 'no_chance', evidenceQuote: 'invented quote', note: 'no code' },
      { key: 'c-1', result: 'applied', evidenceQuote: 'dup', note: 'dup' },
      { key: 'not-carried', result: 'applied', evidenceQuote: 'x', note: 'x' },
      { key: 'c-2', result: 'applied', evidenceQuote: '  ', note: 'said so' },
    ], focus);
    const rows = inserted[0] ?? [];
    check('a check for a key the round never carried is dropped', !rows.some((r) => r.key === 'not-carried'));
    check('the first of a duplicate wins', rows.filter((r) => r.key === 'c-1').length === 1 && rows[0]!.result === 'no_chance');
    check('no_chance never keeps a quote', rows[0]!.evidenceQuote === null);
    check('applied with no quote is not kept — it is what closes a commitment, and nobody could audit it',
      !rows.some((r) => r.key === 'c-2'), `${rows.length} row(s)`);
    inserted.length = 0;
    await (svc as unknown as {
      persistFocusChecks: (db: unknown, evalId: string, reported: unknown[], focus: unknown[]) => Promise<void>;
    }).persistFocusChecks(writer, 'e2', [
      { key: 'c-1', result: 'not_applied', evidenceQuote: null, note: 'never stated it' },
    ], focus);
    const second = inserted[0] ?? [];
    check('not_applied may be quote-less: an omission has nothing to quote',
      second.length === 1 && second[0]!.result === 'not_applied');
    check('an item the evaluator skipped gets NO row, so it reads unjudged rather than missed',
      !second.some((r) => r.key === 'c-2'), `${second.length} row(s)`);

    const sent: unknown[][] = [];
    (svc as unknown as { provider: unknown }).provider = {
      name: 'stub', supportsAudio: true,
      evaluate: async (...args: unknown[]) => { sent.push(args); return { report: {}, provider: 'stub', model: 'm', audioAnalysed: false }; },
    };
    await (svc as unknown as { callEvaluator: (i: unknown, a: unknown, ids: string[], keys: string[]) => Promise<unknown> })
      .callEvaluator({ ...base, focus }, null, ['two-sum'], keys);
    check('the focus keys travel to the provider, where the response schema is built from them',
      JSON.stringify(sent[0]?.[3]) === JSON.stringify(keys));

    const o = readRoundOptions({ durationMinutes: 30, difficulty: 'hard', persona: 'terse' });
    check('a round recorded before styles reads its style as null, not its whole options',
      o.style === null && o.difficulty === 'hard', JSON.stringify(o));
    check('a stored style is read back', readRoundOptions({ style: 'google' }).style === 'google');
  }

  await rm(TMP, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(56)}`);
  const skipNote = skipped ? ` (${skipped} SKIPPED: no speech synthesis on this machine)` : '';
  if (!fails.length) { console.log(`\x1b[32m\x1b[1mALL ${pass} METRIC CHECKS PASSED\x1b[0m${skipNote}\n`); process.exit(0); }
  console.log(`\x1b[31m\x1b[1m${fails.length} FAILED\x1b[0m, ${pass} passed${skipNote}`);
  fails.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  process.exit(1);
}
void main().catch((e) => { console.error(e); process.exit(1); });
