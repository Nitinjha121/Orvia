import type { AudioAnalysis, SpeechRun } from './audio-analysis';

/**
 * Aligns transcript turns with physical audio waveform timestamps.
 * Live transcript arrival timestamps reflect websocket receipt rather than
 * actual speech onset, requiring audio waveform analysis to measure true latency.
 */

export type TurnLike = {
  speaker: 'ai' | 'user';
  text: string;
  startMs: number;
  endMs: number | null;
};

export type Alignment = {
  /**
   * Interviewer-stops-speaking to candidate-starts-speaking, per handover.
   * This is a genuine hesitation measurement; the turn-gap version was the
   * length of the answer.
   */
  latenciesMs: number[];
  /** Longest stretch in which NEITHER side was speaking. */
  longestDeadAirMs: number | null;
  /** Contiguous candidate speaking stretches, in order, from the waveform. */
  candidateStretches: SpeechRun[];
  /** True when the candidate stretches zip 1:1 onto the candidate's turns. */
  stretchesMatchTurns: boolean;
};

/**
 * A handover longer than this is not hesitation — it is a gap in the round
 * (the candidate coding in silence, a reconnect, a break). Counting it would
 * swamp the median with something that is not a pause before answering.
 */
const MAX_PLAUSIBLE_LATENCY_MS = 90_000;

/** Merge overlapping/adjacent intervals into a sorted busy timeline. */
function union(runs: SpeechRun[]): SpeechRun[] {
  const sorted = [...runs].sort((a, b) => a.startMs - b.startMs);
  const out: SpeechRun[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Splits the candidate's speech runs into stretches, breaking wherever the
 * interviewer spoke. One stretch is one uninterrupted go at the floor, which is
 * what a conversational turn actually is.
 */
function groupIntoStretches(mine: SpeechRun[], theirs: SpeechRun[]): SpeechRun[] {
  const stretches: SpeechRun[] = [];
  for (const run of mine) {
    const last = stretches[stretches.length - 1];
    if (!last) {
      stretches.push({ ...run });
      continue;
    }
    const boundary = last.endMs;
    const interrupted = theirs.some((t) => t.startMs >= boundary && t.startMs < run.startMs);
    if (interrupted) stretches.push({ ...run });
    else last.endMs = run.endMs;
  }
  return stretches;
}

export function align(
  turns: TurnLike[],
  candidate: AudioAnalysis | null,
  interviewer: AudioAnalysis | null,
): Alignment {
  const empty: Alignment = {
    latenciesMs: [],
    longestDeadAirMs: null,
    candidateStretches: [],
    stretchesMatchTurns: false,
  };
  // Defensive on `runs`: callers hand this whatever they have, including
  // hand-built fixtures and analyses persisted before runs existed.
  if (!candidate?.runs?.length || !interviewer?.runs?.length) return empty;

  const mine = union(candidate.runs);
  const theirs = union(interviewer.runs);

  /**
   * A handover is only a handover when the candidate is the NEXT thing to
   * happen. The interviewer's speech arrives as several runs per turn (natural
   * pauses exceed the silence floor), so without this guard every intra-turn
   * breath would be scored as the candidate hesitating.
   */
  const latenciesMs: number[] = [];
  for (const t of theirs) {
    const next = mine.find((m) => m.startMs >= t.endMs);
    if (!next) continue;
    const theyResumedFirst = theirs.some(
      (o) => o.startMs > t.endMs && o.startMs < next.startMs,
    );
    if (theyResumedFirst) continue;
    const gap = next.startMs - t.endMs;
    if (gap > 0 && gap <= MAX_PLAUSIBLE_LATENCY_MS) latenciesMs.push(gap);
  }

  // Dead air: gaps in the union of both voices. Leading and trailing silence is
  // setup and teardown, not a pause anybody took.
  const busy = union([...mine, ...theirs]);
  let longestDeadAirMs: number | null = null;
  for (let i = 1; i < busy.length; i++) {
    const gap = busy[i]!.startMs - busy[i - 1]!.endMs;
    if (gap > (longestDeadAirMs ?? 0)) longestDeadAirMs = gap;
  }

  const candidateStretches = groupIntoStretches(mine, theirs);
  const userTurns = turns.filter((t) => t.speaker === 'user').length;

  return {
    latenciesMs,
    longestDeadAirMs,
    candidateStretches,
    stretchesMatchTurns: userTurns > 0 && candidateStretches.length === userTurns,
  };
}

/* ── locating a quote in time ──────────────────────────────────────────────── */

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Minimum bigram (word pair) overlap required to associate a quote with a turn.
 * Uses bigrams rather than unigrams to prevent spurious matches on frequent words.
 */
const MIN_QUOTE_OVERLAP = 0.35;

/** Ordered word pairs of a normalised string. */
function bigrams(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * Locates the audio offset where a quoted statement was spoken.
 * Replaces interpolated turn-start guesses with bigram-matched audio offsets,
 * returning null if the quote cannot be reliably placed.
 */
export function locateQuote(
  quote: string | null | undefined,
  turns: TurnLike[],
  alignment: Alignment,
  /**
   * Time-windowed verbatim transcript segments, used as a fallback when a quote
   * differs textually from live transcript turns.
   */
  verbatimSegments?: { startMs: number; endMs: number; text: string }[],
): number | null {
  if (!quote?.trim()) return null;

  const wanted = norm(quote).split(' ').filter(Boolean);
  if (wanted.length < 3) return null;
  const wantedPairs = new Set(bigrams(wanted));
  if (!wantedPairs.size) return null;

  const userTurns = turns.filter((t) => t.speaker === 'user');
  let best: { idx: number; score: number; offset: number } | null = null;

  /**
   * Best-matching WINDOW, not best-matching turn. A four-minute answer is
   * hundreds of words long, so knowing merely which turn a quote came from
   * still leaves the timestamp minutes out. Sliding a quote-sized window finds
   * where inside the answer it was said.
   */
  for (let idx = 0; idx < userTurns.length; idx++) {
    const words = norm(userTurns[idx]!.text).split(' ').filter(Boolean);
    const pairs = bigrams(words);
    if (!pairs.length) continue;

    // A shade wider than the quote, because the two transcripts of the same
    // speech disagree on exact wording and length.
    const win = Math.min(pairs.length, Math.max(wantedPairs.size, Math.round(wantedPairs.size * 1.3)));
    let bestHits = -1;
    let bestStart = 0;

    for (let s = 0; s === 0 || s + win <= pairs.length; s++) {
      const seen = new Set<string>();
      for (let k = s; k < Math.min(s + win, pairs.length); k++) {
        if (wantedPairs.has(pairs[k]!)) seen.add(pairs[k]!);
      }
      if (seen.size > bestHits) {
        bestHits = seen.size;
        bestStart = s;
      }
      if (s + win >= pairs.length) break;
    }

    const score = bestHits / wantedPairs.size;
    if (score > (best?.score ?? 0)) {
      best = { idx, score, offset: bestStart / pairs.length };
    }
  }

  if (best === null || best.score < MIN_QUOTE_OVERLAP) {
    return locateInSegments(wantedPairs, verbatimSegments);
  }
  const match: { idx: number; score: number; offset: number } = best;

  const stretch = alignment.stretchesMatchTurns
    ? alignment.candidateStretches[match.idx]
    : undefined;

  if (stretch) {
    return Math.round(stretch.startMs + match.offset * (stretch.endMs - stretch.startMs));
  }

  // No usable waveform alignment. The turn's own start is late by however long
  // the burst took to arrive, but it is measured rather than invented.
  const turn = userTurns[match.idx];
  return turn ? turn.startMs : null;
}

/**
 * Falls back to the verbatim transcript's own segment windows, for a quote that
 * the live turns simply do not contain.
 */
function locateInSegments(
  wantedPairs: Set<string>,
  segments?: { startMs: number; endMs: number; text: string }[],
): number | null {
  if (!segments?.length) return null;

  let best: { startMs: number; endMs: number; score: number; offset: number } | null = null;
  for (const seg of segments) {
    const words = norm(seg.text).split(' ').filter(Boolean);
    const pairs = bigrams(words);
    if (!pairs.length) continue;

    let firstHit = -1;
    const seen = new Set<string>();
    pairs.forEach((pair, i) => {
      if (!wantedPairs.has(pair)) return;
      seen.add(pair);
      if (firstHit < 0) firstHit = i;
    });

    const score = seen.size / wantedPairs.size;
    if (score > (best?.score ?? 0)) {
      best = {
        startMs: seg.startMs,
        endMs: seg.endMs,
        score,
        offset: firstHit >= 0 ? firstHit / pairs.length : 0,
      };
    }
  }

  if (best === null || best.score < MIN_QUOTE_OVERLAP) return null;
  const hit: { startMs: number; endMs: number; score: number; offset: number } = best;
  return Math.round(hit.startMs + hit.offset * (hit.endMs - hit.startMs));
}

/**
 * Bigram overlap threshold for matching paraphrased questions to interviewer turns.
 * The highest-scoring turn is selected to disambiguate from brief restatement confirmations.
 */
const MIN_ASKED_OVERLAP = 0.3;

/**
 * Locates when the interviewer asked a question by matching text against interviewer turns.
 * Picks the best-matching turn at or after `notBeforeMs`, ignoring turns flagged as premature.
 */
export function locateAsked(
  question: string | null | undefined,
  turns: TurnLike[],
  notBeforeMs = 0,
  skip: (turn: TurnLike) => boolean = () => false,
): number | null {
  if (!question?.trim()) return null;
  const wanted = new Set(bigrams(norm(question).split(' ').filter(Boolean)));
  if (wanted.size < 2) return null;

  const pick = (from: number) => {
    let best: { startMs: number; score: number } | null = null;
    for (const t of turns) {
      if (t.speaker !== 'ai' || t.startMs < from || skip(t)) continue;
      const pairs = new Set(bigrams(norm(t.text).split(' ').filter(Boolean)));
      let hits = 0;
      for (const p of wanted) if (pairs.has(p)) hits++;
      const score = hits / wanted.size;
      if (score >= MIN_ASKED_OVERLAP && score > (best?.score ?? 0)) best = { startMs: t.startMs, score };
    }
    return best?.startMs ?? null;
  };
  // Out of order only when nothing later matches: the report merges follow-ups
  // into their question, so its order is the conversation's but not strictly.
  return pick(notBeforeMs) ?? pick(0);
}
