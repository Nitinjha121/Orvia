import { FILLER_PATTERNS, type SpeechMetrics } from '@orvia/shared';
import type { AudioAnalysis } from './audio-analysis';
import { align, type TurnLike } from './alignment';

export type { TurnLike };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function countFillers(transcript: string) {
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const { id, pattern } of FILLER_PATTERNS) {
    const n = (transcript.match(pattern) ?? []).length;
    if (n > 0) {
      breakdown[id] = n;
      total += n;
    }
  }
  return { total, breakdown };
}

/**
 * Selects whichever transcript detected more filler words per word. ASR passes
 * frequently miss fillers but rarely invent them, so the higher rate is more accurate.
 */
function pickFillerSource(live: string, verbatim: string) {
  const a = { ...countFillers(live), text: live, source: 'live' as const };
  if (!verbatim) return a;
  const b = { ...countFillers(verbatim), text: verbatim, source: 'verbatim' as const };

  const rate = (c: { total: number; text: string }) => {
    const w = words(c.text);
    return w > 0 ? c.total / w : 0;
  };
  return rate(b) > rate(a) ? b : a;
}

/**
 * Share of the live transcript's word count a verbatim transcript must reach
 * before it is trusted. Verbatim transcripts preserve disfluencies and should
 * be comparable in length; materially shorter transcripts indicate truncation.
 */
export const VERBATIM_MIN_COVERAGE = 0.6;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Measures how the candidate spoke, from the two waveforms and the transcript.
 *
 * Model-free, so the numbers stay comparable across model swaps and rubric
 * revisions. Every field is handed to the evaluator as FACT, so one that
 * cannot be measured is null rather than estimated from turn timestamps —
 * which are when a transcript burst ARRIVED, not when anything was said.
 */
export function computeSpeechMetrics(
  turns: TurnLike[],
  /** The candidate's waveform — the only source of speaking duration. */
  audio: AudioAnalysis | null,
  /** Interviewer audio forwarded, pauses included. Used only without `aiAudio`. */
  aiSpeakingMs: number,
  verbatim?: string | null,
  /** The interviewer's waveform. Latency and dead air need both voices. */
  aiAudio?: AudioAnalysis | null,
): SpeechMetrics {
  const mine = turns.filter((t) => t.speaker === 'user');

  /**
   * Turn timestamps cannot measure speaking duration: input transcription
   * lands in a burst after the candidate stops, so a turn's start and end are
   * milliseconds apart. Unguarded this once produced 574,286 words per minute
   * and a talk ratio of zero.
   */
  const totalSpeakingMs = audio ? audio.voicedMs : null;
  const theirSpeakingMs = aiAudio ? aiAudio.voicedMs : aiSpeakingMs > 0 ? aiSpeakingMs : null;

  const liveTranscript = mine.map((t) => t.text).join(' ');

  // A fragment is truthy, so `|| liveTranscript` would not guard truncation.
  const liveWords = words(liveTranscript);
  const verbatimText = verbatim?.trim() ?? '';
  const verbatimUsable = verbatimText.length > 0 && words(verbatimText) >= liveWords * VERBATIM_MIN_COVERAGE;

  const transcript = verbatimUsable ? verbatimText : liveTranscript;
  const wordCount = words(transcript);

  // `> 0` is not enough: 5ms is positive and yields a six-figure pace.
  const wordsPerMinute =
    totalSpeakingMs !== null && totalSpeakingMs >= 1000
      ? Math.round(wordCount / (totalSpeakingMs / 60_000))
      : null;

  const fillers = pickFillerSource(liveTranscript, verbatimUsable ? verbatimText : '');
  const fillerBase = words(fillers.text);

  /**
   * Requires dual waveforms. Fallbacks using turn gaps inaccurately measure
   * speech gaps when speech is quiet or overlaps with interviewer turns.
   */
  const alignment = align(turns, audio, aiAudio ?? null);
  const medianResponseLatencyMs = median(alignment.latenciesMs);
  const longestSilenceMs = alignment.longestDeadAirMs;

  const allSpeaking =
    totalSpeakingMs !== null && theirSpeakingMs !== null ? totalSpeakingMs + theirSpeakingMs : null;

  return {
    totalSpeakingMs,
    wordCount,
    wordsPerMinute,
    fillerCount: fillers.total,
    fillerRate: fillerBase > 0 ? Number(((fillers.total / fillerBase) * 100).toFixed(2)) : 0,
    fillerBreakdown: fillers.breakdown,
    medianResponseLatencyMs,
    longestSilenceMs,
    talkRatio:
      allSpeaking !== null && allSpeaking > 0 ? Number((totalSpeakingMs! / allSpeaking).toFixed(3)) : null,
    meanTurnWords: mine.length ? Number((wordCount / mine.length).toFixed(1)) : 0,
  };
}

/**
 * Renders the metrics for the evaluator prompt, with the interpretation the
 * model would otherwise have to guess at. Ranges are the conventional
 * interview-coaching bands, stated so the model does not invent its own.
 */
export function describeMetrics(m: SpeechMetrics): string {
  /**
   * Energy VAD splits speech from silence in the trough of the frame-level
   * histogram, and on a real microphone that trough is wide — around 100
   * seconds of a 14-minute round sits in it — so pace carries roughly +/-20 wpm.
   */
  const BAND_SLOP = 20;
  const wpm = m.wordsPerMinute;
  const paceNote =
    wpm === null ? null
    : wpm === 0 ? 'no speech measured'
    : wpm < 110 - BAND_SLOP ? 'slow — may read as hesitant'
    : wpm > 180 + BAND_SLOP ? 'fast — may read as rushed or nervous'
    : wpm < 110 ? 'just below the normal band of 110-180, within measurement error of it'
    : wpm > 180 ? 'just above the normal band of 110-180, within measurement error of it — do not call this rushed on its own, check the recording'
    : 'within the normal conversational band of 110-180';

  const fillerNote =
    m.fillerRate < 2 ? 'low' : m.fillerRate < 5 ? 'noticeable' : 'high enough to distract';

  const talk = m.talkRatio;
  const talkNote =
    talk === null ? null
    : talk < 0.5 ? 'the candidate spoke LESS than the interviewer, which is a warning sign in an interview'
    : talk > 0.85 ? 'the candidate dominated, leaving little room for the interviewer'
    : 'a healthy split';

  const NO_MIC = 'not measured — no usable recording of the candidate, so do not comment on it';
  const NO_BOTH = 'not measured — this needs both recordings, so do not comment on it';

  return [
    m.totalSpeakingMs !== null
      ? `- Speaking time: ${(m.totalSpeakingMs / 1000).toFixed(0)}s across ${m.wordCount} words`
      : `- Speaking time: ${NO_MIC} (${m.wordCount} words were transcribed)`,
    wpm !== null ? `- Pace: ${wpm} words per minute (${paceNote})` : `- Pace: ${NO_MIC}`,
    `- Filler words: ${m.fillerCount} total, ${m.fillerRate} per 100 words (${fillerNote})` +
      (Object.keys(m.fillerBreakdown).length
        ? ` — ${Object.entries(m.fillerBreakdown).map(([k, v]) => `"${k}" x${v}`).join(', ')}`
        : ''),
    m.medianResponseLatencyMs !== null
      ? `- Median pause before answering: ${(m.medianResponseLatencyMs / 1000).toFixed(1)}s ` +
        `(measured from the interviewer's voice stopping to the candidate's starting)`
      : `- Median pause before answering: ${NO_BOTH}`,
    m.longestSilenceMs !== null
      ? `- Longest stretch with neither person speaking: ${(m.longestSilenceMs / 1000).toFixed(1)}s`
      : `- Longest stretch with neither person speaking: ${NO_BOTH}`,
    talk !== null
      ? `- Talk ratio: ${(talk * 100).toFixed(0)}% of speaking time was the candidate (${talkNote})`
      : `- Talk ratio: ${NO_MIC}`,
    `- Mean answer length: ${m.meanTurnWords} words`,
  ].join('\n');
}
