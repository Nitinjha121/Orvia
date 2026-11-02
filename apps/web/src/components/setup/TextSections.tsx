import type { JobDescription } from '../../lib/api';
import { FIELD, LABEL } from '../ui/styles';

export function JdSection({
  jds, jd, setJd,
}: { jds: readonly JobDescription[]; jd: string; setJd: (v: string) => void }) {
  return (
    <div className="space-y-3">
      {jds.length > 0 && (
        <div>
          <span className={LABEL}>Saved roles</span>
          <div className="flex flex-wrap gap-1.5">
            {jds.map((j) => (
              <button key={j.id} type="button" onClick={() => setJd(j.content)}
                aria-pressed={jd === j.content}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted
                           transition-colors hover:bg-surface-hover hover:text-fg">
                {j.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className={LABEL} htmlFor="jd">Job description</label>
        <textarea id="jd" rows={12} value={jd} onChange={(e) => setJd(e.target.value)}
          placeholder="Paste the job description, or pick a saved role above…"
          className={`${FIELD} resize-y font-mono text-xs leading-relaxed`} />
        <p className="mt-1.5 text-xs text-fg-subtle">
          {jd.trim().length} characters · 50 minimum · save roles on the Profile page
        </p>
      </div>
    </div>
  );
}

export function ExperienceSection({
  experience, setExperience, fromProfile, jds, jd, setJd,
}: {
  experience: string; setExperience: (v: string) => void; fromProfile: boolean;
  jds: readonly JobDescription[]; jd: string; setJd: (v: string) => void;
}) {
  const roleLength = jd.trim().length;
  return (
    <div className="space-y-4">
      <div>
        <label className={LABEL} htmlFor="exp">Your experience</label>
        <textarea id="exp" rows={12} value={experience} onChange={(e) => setExperience(e.target.value)}
          placeholder="Projects, decisions, numbers you can defend…"
          className={`${FIELD} resize-y font-mono text-xs leading-relaxed`} />
        <p className="mt-1.5 text-xs text-fg-subtle">
          {fromProfile
            ? 'Pre-filled from your profile. Edits here apply to this round only.'
            : 'Tip: save this on the Profile page so you never paste it again.'}
        </p>
      </div>
      <div className="space-y-2">
        {jds.length > 0 && (
          <div>
            <span className={LABEL}>Saved roles</span>
            <div className="flex flex-wrap gap-1.5">
              {jds.map((j) => (
                <button key={j.id} type="button" onClick={() => setJd(jd === j.content ? '' : j.content)}
                  aria-pressed={jd === j.content}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted
                             transition-colors hover:bg-surface-hover hover:text-fg">
                  {j.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className={LABEL} htmlFor="exp-jd">Role you are preparing for (optional)</label>
          <textarea id="exp-jd" rows={6} value={jd} onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the job description. Questions stay on your own work; the role picks which parts get dug into."
            className={`${FIELD} resize-y font-mono text-xs leading-relaxed`} />
          <p className="mt-1.5 text-xs text-fg-subtle">
            {roleLength === 0
              ? 'Leave empty for a plain experience deep-dive.'
              : roleLength < 50
                ? `${roleLength} characters · 50 minimum, or leave it empty`
                : `${roleLength} characters · the report also judges your answers against this role`}
          </p>
        </div>
      </div>
    </div>
  );
}
