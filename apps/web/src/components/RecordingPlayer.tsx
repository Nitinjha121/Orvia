import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { mmss } from '../lib/time';

/** Which voices to play. */
export type Track = 'both' | 'me' | 'interviewer';

type Ctx = {
  /** Play from a point in the round. Null when there is no recording. */
  playAt: ((ms: number) => void) | null;
  playingMs: number | null;
  /* ── transport, for the full controls ─────────────────────────────────── */
  playing: boolean;
  currentMs: number;
  durationMs: number;
  track: Track;
  rate: number;
  volume: number;
  hasInterviewer: boolean;
  toggle: () => void;
  seek: (ms: number) => void;
  setTrack: (t: Track) => void;
  setRate: (r: number) => void;
  setVolume: (v: number) => void;
};

const NOOP = () => {};
const RecordingCtx = createContext<Ctx>({
  playAt: null, playingMs: null, playing: false, currentMs: 0, durationMs: 0,
  track: 'both', rate: 1, volume: 1, hasInterviewer: false,
  toggle: NOOP, seek: NOOP, setTrack: NOOP, setRate: NOOP, setVolume: NOOP,
});

const RATES = [0.75, 1, 1.25, 1.5, 2];

/**
 * Plays back session audio using a single shared <audio> element.
 * Defaults to mixed audio of both participants with options to isolate either track.
 */
export function RecordingProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const el = useRef<HTMLAudioElement>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [hasInterviewer, setHasInterviewer] = useState(false);
  const [playingMs, setPlayingMs] = useState<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [track, setTrackState] = useState<Track>('both');
  const [rate, setRateState] = useState(1);
  const [volume, setVolumeState] = useState(1);

  const src = `/api/sessions/${sessionId}/audio?track=${track}`;

  useEffect(() => {
    let cancelled = false;
    // HEAD tells us what exists without pulling any audio down.
    const head = (t: Track) =>
      fetch(`/api/sessions/${sessionId}/audio?track=${t}`, { method: 'HEAD', credentials: 'include' })
        .then((r) => r.ok)
        .catch(() => false);

    void Promise.all([head('me'), head('interviewer')]).then(([mine, theirs]) => {
      if (cancelled) return;
      setAvailable(mine);
      setHasInterviewer(theirs);
      // Rounds recorded before the interviewer was captured only have one side.
      if (!theirs) setTrackState('me');
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  /**
   * Preserves playback position and play state when switching between audio tracks.
   */
  const setTrack = useCallback((next: Track) => {
    const a = el.current;
    const at = a?.currentTime ?? 0;
    const wasPlaying = !!a && !a.paused;
    setTrackState(next);
    requestAnimationFrame(() => {
      const b = el.current;
      if (!b) return;
      const resume = () => {
        b.currentTime = at;
        if (wasPlaying) void b.play().catch(() => {});
        b.removeEventListener('loadedmetadata', resume);
      };
      b.addEventListener('loadedmetadata', resume);
    });
  }, []);

  const playAt = useCallback((ms: number) => {
    const a = el.current;
    if (!a) return;
    a.currentTime = Math.max(0, ms / 1000);
    setPlayingMs(ms);
    void a.play().catch(() => setPlayingMs(null));
  }, []);

  const toggle = useCallback(() => {
    const a = el.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  }, []);

  const seek = useCallback((ms: number) => {
    const a = el.current;
    if (!a) return;
    a.currentTime = Math.max(0, ms / 1000);
    setCurrentMs(ms);
  }, []);

  const setRate = useCallback((r: number) => {
    setRateState(r);
    if (el.current) el.current.playbackRate = r;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    if (el.current) el.current.volume = v;
  }, []);

  return (
    <RecordingCtx.Provider
      value={{
        playAt: available ? playAt : null, playingMs,
        playing, currentMs, durationMs, track, rate, volume, hasInterviewer,
        toggle, seek, setTrack, setRate, setVolume,
      }}
    >
      <audio
        ref={el}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); setPlayingMs(null); }}
        onEnded={() => { setPlaying(false); setPlayingMs(null); }}
        onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          // A streamed WAV can report Infinity until it is fully buffered.
          if (Number.isFinite(d)) setDurationMs(d * 1000);
          e.currentTarget.playbackRate = rate;
          e.currentTarget.volume = volume;
        }}
        // ...and settles later, which only `durationchange` reports.
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDurationMs(d * 1000);
        }}
        className="hidden"
      />
      {children}
    </RecordingCtx.Provider>
  );
}

export const useRecording = () => useContext(RecordingCtx);

/** Small inline control beside a quote or a question. */
export function PlayFrom({ atMs, label }: { atMs: number | null | undefined; label?: string }) {
  const { playAt, playingMs } = useRecording();
  if (!playAt || atMs == null) return null;

  const active = playingMs === atMs;
  return (
    <button
      onClick={() => playAt(atMs)}
      title={`Play from ${mmss(atMs)}`}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium
                 text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
    >
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
        {active
          ? <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />
          : <path d="M3 2l7 4-7 4z" fill="currentColor" />}
      </svg>
      {label ?? mmss(atMs)}
    </button>
  );
}

/** Full transport for listening back to the whole round. */
export function RecordingBar() {
  const {
    playAt, playing, currentMs, durationMs, track, rate, volume,
    hasInterviewer, toggle, seek, setTrack, setRate, setVolume,
  } = useRecording();
  if (!playAt) return null;

  const total = durationMs || 0;

  return (
    <div className="rounded-md border border-border bg-surface-alt p-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play the whole round'}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full
                     bg-brand text-brand-fg transition-opacity hover:opacity-90"
        >
          <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden>
            {playing
              ? <path d="M3.5 2h2v8h-2zM6.5 2h2v8h-2z" fill="currentColor" />
              : <path d="M3.5 2l6 4-6 4z" fill="currentColor" />}
          </svg>
        </button>

        <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-muted">
          {mmss(currentMs)} / {total ? mmss(total) : '--:--'}
        </span>

        <input
          type="range"
          min={0}
          max={total || 1}
          value={Math.min(currentMs, total || 1)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek"
          className="h-1 min-w-40 flex-1 accent-[var(--orvia-color-brand)]"
        />

        {/* Which voices. Hidden entirely for rounds that only have one. */}
        {hasInterviewer && (
          <div className="flex shrink-0 overflow-hidden rounded-md border border-border">
            {([
              ['both', 'Both'],
              ['me', 'You'],
              ['interviewer', 'Interviewer'],
            ] as [Track, string][]).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTrack(id)}
                aria-pressed={track === id}
                className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                  track === id ? 'bg-brand text-brand-fg' : 'text-fg-muted hover:bg-surface-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <select
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          aria-label="Playback speed"
          className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-fg"
        >
          {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
        </select>

        <div className="flex shrink-0 items-center gap-1.5">
          <svg viewBox="0 0 12 12" className="h-3 w-3 text-fg-subtle" aria-hidden
               fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
            <path d="M2 4.5h2L6.5 2v8L4 7.5H2z" />
            <path d="M8.5 4.2a2.5 2.5 0 0 1 0 3.6" />
          </svg>
          <input
            type="range" min={0} max={1} step={0.05} value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
            className="h-1 w-16 accent-[var(--orvia-color-brand)]"
          />
        </div>
      </div>
    </div>
  );
}
