import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import { CODE_LANGUAGES, VOICES, type CodeLanguage } from '@orvia/shared';
import { api, type Profile, type JobDescription } from '../lib/api';
import { FIELD, LABEL } from './ui/styles';
import { Segmented } from './ui/Segmented';
import { ErrorNote } from './ui/ErrorNote';
import { ConfirmButton } from './ui/ConfirmButton';

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java',
  cpp: 'C++', go: 'Go', rust: 'Rust', sql: 'SQL', php: 'PHP',
};

/** Sliders save this long after the last change, so a drag is one request. */
const SLIDER_SAVE_MS = 400;

const CARD = 'space-y-5 rounded-lg border border-border bg-surface p-4 sm:p-5';

export function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [jds, setJds] = useState<JobDescription[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jdError, setJdError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sliderTimers = useRef(new Map<keyof Profile, ReturnType<typeof setTimeout>>());
  const sliderPending = useRef<Partial<Profile>>({});

  useEffect(() => {
    setLoadError(null);
    // A load never replaces a profile already on screen: in dev StrictMode two
    // GETs are in flight, and a late one wiped what test:browser had just typed.
    void api.get<Profile>('/api/profile').then((p) => setProfile((prev) => prev ?? p))
      .catch((e: Error) => setLoadError(e.message));
    void api.get<JobDescription[]>('/api/profile/job-descriptions').then(setJds)
      .catch((e: Error) => setJdError(`Saved job descriptions did not load: ${e.message}`));
  }, [attempt]);

  useEffect(() => {
    const timers = sliderTimers.current;
    const pending = sliderPending.current;
    // Leaving inside the debounce still saves the last value; no state is set after unmount.
    return () => {
      timers.forEach((t) => clearTimeout(t));
      if (Object.keys(pending).length) void api.put('/api/profile', pending).catch(() => {});
    };
  }, []);

  /**
   * Blur-saves read from the event rather than component state to avoid stale
   * closures when blurring rapidly.
   * Only patched keys are merged from the response to prevent overwriting
   * concurrent field edits.
   */
  async function save(patch: Partial<Profile>) {
    if (!profile) return;
    setError(null);
    try {
      const next = await api.put<Profile>('/api/profile', patch);
      const keys = Object.keys(patch) as (keyof Profile)[];
      setProfile((prev) =>
        prev ? { ...prev, ...Object.fromEntries(keys.map((k) => [k, next[k]])) } : next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!profile) {
    return loadError
      ? <ErrorNote className="mx-auto max-w-3xl" message={`Your profile did not load: ${loadError}`}
                   onRetry={() => setAttempt((n) => n + 1)} />
      : <p className="text-sm text-fg-muted">Loading…</p>;
  }

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) =>
    setProfile((prev) => (prev ? { ...prev, [k]: v } : prev));

  /**
   * Sliders save from the event's value on every change, debounced, supporting
   * keyboard navigation as well as pointer interactions.
   */
  const slide = (k: 'defaultDurationMinutes' | 'silenceDurationMs' | 'prefixPaddingMs') =>
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.currentTarget.value);
      set(k, v);
      const timers = sliderTimers.current;
      const pending = timers.get(k);
      if (pending) clearTimeout(pending);
      sliderPending.current[k] = v;
      timers.set(k, setTimeout(() => {
        timers.delete(k);
        delete sliderPending.current[k];
        void save({ [k]: v });
      }, SLIDER_SAVE_MS));
    };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Profile</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Filled in once. Every future round starts from this — you never paste it again.
          </p>
        </div>
        {saved && <span className="text-sm text-success">Saved</span>}
      </header>

      {error && <ErrorNote message={error} />}

      {/* ── experience ─────────────────────────────────────────────────────── */}
      <section className={CARD}>
        <div>
          <h2 className="text-sm font-semibold text-fg">Your experience</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Projects, what you built, decisions you made, numbers you can defend. This is what the
            experience round drills into — the more specific it is, the harder the follow-ups get.
          </p>
        </div>
        <textarea rows={12} value={profile.experience}
          onChange={(e) => set('experience', e.target.value)}
          onBlur={(e) => save({ experience: e.target.value })}
          placeholder={'e.g. Led the migration of our billing service from a monolith to…\n\n- Cut p99 checkout latency from 1.4s to 380ms by…\n- Owned the rollout, including the dual-write phase and…'}
          className={`${FIELD} resize-y font-mono text-xs leading-relaxed`} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="role">Target role</label>
            <input id="role" value={profile.targetRole ?? ''}
              onChange={(e) => set('targetRole', e.target.value)}
              onBlur={(e) => save({ targetRole: e.target.value })}
              placeholder="Senior Backend Engineer" className={FIELD} />
          </div>
          <div>
            <label className={LABEL} htmlFor="yrs">Years of experience</label>
            <input id="yrs" type="number" min={0} max={60} step={0.5}
              value={profile.yearsExperience ?? ''}
              onChange={(e) => set('yearsExperience', e.target.value === '' ? null : Number(e.target.value))}
              onBlur={(e) => save({ yearsExperience: e.target.value ? Number(e.target.value) : null })}
              className={FIELD} />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="resume">Resume text (optional)</label>
          <textarea id="resume" rows={6} value={profile.resume}
            onChange={(e) => set('resume', e.target.value)}
            onBlur={(e) => save({ resume: e.target.value })}
            placeholder="Paste your resume. Kept separate so re-pasting it never overwrites the notes above."
            className={`${FIELD} resize-y font-mono text-xs leading-relaxed`} />
        </div>
      </section>

      {/* ── saved job descriptions ─────────────────────────────────────────── */}
      {jdError && <ErrorNote message={jdError} />}
      <JobDescriptions jds={jds} setJds={setJds} />

      {/* ── interview defaults ─────────────────────────────────────────────── */}
      <section className={CARD}>
        <div>
          <h2 className="text-sm font-semibold text-fg">Interview defaults</h2>
          <p className="mt-1 text-xs text-fg-muted">Pre-selected every time you start a round.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            {/*
              `onChange` fires across mouse, touch, pen, and keyboard inputs,
              ensuring adjustments on touch devices are persisted.
            */}
            <label className={LABEL} htmlFor="dur">Length — {profile.defaultDurationMinutes} min</label>
            <input id="dur" type="range" min={5} max={90} step={5}
              value={profile.defaultDurationMinutes}
              onChange={slide('defaultDurationMinutes')}
              className="w-full accent-brand" />
          </div>
          <div>
            <label className={LABEL} htmlFor="voice">Interviewer voice</label>
            <select id="voice" value={profile.defaultVoice}
              onChange={(e) => { set('defaultVoice', e.target.value); void save({ defaultVoice: e.target.value }); }}
              className={FIELD}>
              {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <span className={LABEL}>Bar</span>
            <Segmented label="Bar" value={profile.defaultDifficulty} options={['warmup', 'standard', 'hard'] as const}
              onChange={(v) => { set('defaultDifficulty', v); void save({ defaultDifficulty: v }); }} />
          </div>
          <div>
            <span className={LABEL}>Manner</span>
            <Segmented label="Manner" value={profile.defaultPersona} options={['friendly', 'neutral', 'terse'] as const}
              onChange={(v) => { set('defaultPersona', v); void save({ defaultPersona: v }); }} />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="lang">Default coding language</label>
          <select id="lang" value={profile.preferredLanguage}
            onChange={(e) => {
              const v = e.currentTarget.value as CodeLanguage;
              set('preferredLanguage', v);
              void save({ preferredLanguage: v });
            }}
            className={FIELD}>
            {CODE_LANGUAGES.map((v) => (
              <option key={v} value={v}>{LANGUAGE_LABELS[v]}</option>
            ))}
          </select>
        </div>

        {/* The single most taste-dependent setting in the product. */}
        <div className="rounded-md border border-border bg-surface-alt p-4">
          <label className={LABEL} htmlFor="sil">
            Pause tolerance — {profile.silenceDurationMs} ms
          </label>
          <input id="sil" type="range" min={400} max={4000} step={100}
            value={profile.silenceDurationMs}
            onChange={slide('silenceDurationMs')}
            className="w-full accent-brand" />
          <p className="mt-2 text-xs text-fg-muted">
            How long you can go quiet mid-answer before the interviewer decides you have finished.
            Raise it if you get cut off while thinking; lower it if replies feel sluggish.
            The default of 1400 ms is already well above the API's own default, which is tuned for
            chatty assistants rather than people working through a problem.
          </p>

          <label className={`${LABEL} mt-5`} htmlFor="prefix">
            Interruption threshold — {profile.prefixPaddingMs} ms
          </label>
          <input id="prefix" type="range" min={100} max={2000} step={50}
            value={profile.prefixPaddingMs}
            onChange={slide('prefixPaddingMs')}
            className="w-full accent-brand" />
          <p className="mt-2 text-xs text-fg-muted">
            How much sustained sound counts as you starting to speak. If the interviewer stops
            mid-sentence while its text shows the whole question, a breath or a keystroke is
            triggering interruption — raise this.
          </p>
        </div>
      </section>
    </div>
  );
}

function JobDescriptions({
  jds, setJds,
}: { jds: JobDescription[]; setJds: Dispatch<SetStateAction<JobDescription[]>> }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [company, setCompany] = useState('');
  const [content, setContent] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setErr(null);
    try {
      const row = await api.post<JobDescription>('/api/profile/job-descriptions', {
        label, company: company || null, content,
      });
      setJds([row, ...jds]);
      setLabel(''); setCompany(''); setContent(''); setAdding(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <section className={CARD}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Saved job descriptions</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Roles you are actively interviewing for. Pick one when starting a JD round.
          </p>
        </div>
        <button onClick={() => setAdding(!adding)}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg
                     transition-colors hover:bg-surface-hover">
          {adding ? 'Cancel' : 'Add'}
        </button>
      </div>

      {adding && (
        <div className="space-y-3 rounded-md border border-border bg-surface-alt p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Label, e.g. Senior BE — Stripe" className={FIELD} />
            <input value={company} onChange={(e) => setCompany(e.target.value)}
              placeholder="Company (optional)" className={FIELD} />
          </div>
          <textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)}
            placeholder="Paste the full job description…"
            className={`${FIELD} resize-y font-mono text-xs`} />
          {err && <p className="text-xs text-danger">{err}</p>}
          <button onClick={() => void add()} disabled={label.length < 1 || content.length < 50}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg
                       transition-opacity hover:opacity-90 disabled:opacity-40">
            Save job description
          </button>
        </div>
      )}

      {err && !adding && <p className="text-xs text-danger">{err}</p>}

      {jds.length === 0 && !adding && (
        <p className="text-sm text-fg-subtle">Nothing saved yet.</p>
      )}

      <div className="space-y-1.5">
        {jds.map((jd) => (
          <div key={jd.id}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-fg">{jd.label}</p>
              <p className="truncate text-xs text-fg-subtle">
                {jd.company ? `${jd.company} · ` : ''}{jd.content.length} characters
              </p>
            </div>
            <ConfirmButton label="Remove" question={`Remove "${jd.label}"?`} confirmLabel="Yes, remove"
              ariaLabel={`Remove ${jd.label}`}
              onConfirm={() => {
                setErr(null);
                return api.del(`/api/profile/job-descriptions/${jd.id}`)
                  .then(() => setJds((prev) => prev.filter((x) => x.id !== jd.id)))
                  .catch((e: Error) => setErr(`Could not remove "${jd.label}": ${e.message}`));
              }}
              className="ml-3 shrink-0 text-xs text-fg-subtle transition-colors hover:text-danger" />
          </div>
        ))}
      </div>
    </section>
  );
}
