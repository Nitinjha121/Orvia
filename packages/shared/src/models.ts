/**
 * Gemini model registry. Centralizes model identifiers, fallback chains,
 * capability quirks, and Live API parameter definitions.
 */
export const MODELS = {
  /**
   * The interviewer, coach, and mentor model. Native audio-to-audio over the
   * Live API WebSocket. Context grows with every streamed second.
   */
  interviewer: 'gemini-3.8-live',

  /**
   * Walked in order on failure, quota or deafness. 2.5 stays last: it has its
   * own quota and a larger window, but needs every quirk below.
   */
  interviewerChain: [
    'gemini-3.8-live',
    'gemini-3.1-flash-live-preview',
    'gemini-2.5-flash-native-audio-preview-12-2025',
  ],

  /**
   * Narrator model for prebuilding spoken feed audio cache.
   * Pinned to ensure consistent voice output and faithful verbatim delivery.
   */
  narrator: 'gemini-3.1-flash-live-preview',

  /**
   * Post-session verbatim re-transcription of the candidate's recording, over
   * the Live API. VERBATIM mode keeps the fillers and false starts the
   * interviewer's own transcript drops. The live endpoint and not the batch
   * `gemini-3.5-transcribe`, which is capped at 3 RPM and 25 RPD on the free
   * tier. It returns no word timestamps (`wordTimestamp` yields zero word
   * objects on live models), so the only timing is per segment.
   */
  transcriber: 'gemini-3.5-transcribe-live',

  /**
   * Prioritized fallback chain for evaluation.
   * Steps down through capable audio-hearing models (Flash to Flash-Lite) to
   * handle quota exhaustion (429) or transient capacity limits (503).
   */
  evaluator: 'gemini-3.6-flash',
  evaluatorChain: [
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ],

  /**
   * Listens to a recording for the coach and the mentor and describes how the
   * candidate sounded (`ListeningService`). The 500-a-day Lite models FIRST:
   * the evaluator chain leads with the one that allows twenty, and every coach
   * opening would otherwise spend one of the day's reports. Both Lite models
   * accept audio; Flash stays behind them for when both are cooling.
   */
  listenerChain: [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
  ],

  /**
   * Structured extraction chain (parsing job descriptions, resume experience, and questions).
   * Steps down sequentially through available Flash model versions on quota or capacity limits.
   */
  extractor: 'gemini-3.6-flash',
  extractorChain: [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    // 500/day rather than 20 — the only models that can carry a bulk job.
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ],
} as const;

export type ModelRole = keyof typeof MODELS;

/**
 * Model-specific quirks and capabilities across Live API model generations,
 * including voice sensitivity, empty turn handling, subword spacing, and context budgets.
 */
export type LiveModelQuirks = {
  lowStartSensitivity: boolean;
  bareTurnComplete: boolean;
  subwordTranscripts: boolean;
  contextBudget: { renewAt: number; renewAtHandover: number };
  /**
   * Maximum speed multiplier for replaying buffered mic audio to a fresh socket
   * without dropping end-of-speech detection.
   */
  replaySpeed: number;
};

const LIVE_QUIRKS: Record<string, LiveModelQuirks> = {
  'gemini-3.8-live': {
    lowStartSensitivity: true,
    bareTurnComplete: true,
    subwordTranscripts: false,
    contextBudget: { renewAt: 20_000, renewAtHandover: 12_000 },
    replaySpeed: 4,
  },
  'gemini-3.1-flash-live-preview': {
    lowStartSensitivity: true,
    bareTurnComplete: true,
    subwordTranscripts: false,
    contextBudget: { renewAt: 20_000, renewAtHandover: 12_000 },
    replaySpeed: 4,
  },
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    lowStartSensitivity: false,
    bareTurnComplete: false,
    subwordTranscripts: true,
    contextBudget: { renewAt: 48_000, renewAtHandover: 32_000 },
    replaySpeed: 1,
  },
};

/** Anything not listed is taken to behave like the primary interviewer. */
export const liveModelQuirks = (model: string): LiveModelQuirks =>
  LIVE_QUIRKS[model] ?? LIVE_QUIRKS[MODELS.interviewer]!;

/** Live API wire formats — fixed by the API, not by us. */
export const AUDIO = {
  /** What we must send: raw little-endian 16-bit PCM mono. */
  inputSampleRate: 16_000,
  inputMimeType: 'audio/pcm;rate=16000',
  /** What the model sends back. */
  outputSampleRate: 24_000,
  /** Bytes per sample, both directions. */
  bytesPerSample: 2,
} as const;

/**
 * Live API prebuilt voices. `Charon` and `Kore` read as the most
 * measured/professional, which suits an interviewer.
 */
export const VOICES = ['Kore', 'Charon', 'Aoede', 'Puck', 'Fenrir'] as const;
export type Voice = (typeof VOICES)[number];

/**
 * Maps voice presets across model generations to maintain consistent pitch and timbre
 * when falling back between model families.
 */
const LIVE_VOICE_STAND_INS: Record<string, Partial<Record<string, string>>> = {
  'gemini-3.8-live': { Charon: 'Alnilam', Aoede: 'Callirrhoe', Kore: 'Achernar' },
};

/** The preset to request from `model` for a voice the user chose by name. */
export const liveVoiceFor = (model: string, voice: string): string =>
  LIVE_VOICE_STAND_INS[model]?.[voice] ?? voice;

/**
 * Live API limits and token ceilings. Token counts include the cumulative context
 * of open sessions, managed via context compression and session resumption.
 */
export const LIVE_LIMITS = {
  /** Audio-only session cap WITHOUT context window compression. */
  audioOnlySessionSeconds: 15 * 60,
  /** A single WebSocket connection is recycled at roughly this age. */
  connectionLifetimeSeconds: 10 * 60,
  /** Resumption handles stay valid this long after a session ends. */
  resumptionHandleValiditySeconds: 2 * 60 * 60,
} as const;
