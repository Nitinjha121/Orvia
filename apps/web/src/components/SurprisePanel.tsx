import { useState, type ReactNode } from 'react';
import type { DrawRules } from '@orvia/shared';
import { LABEL } from './ui/styles';

/**
 * "Surprise me", for every mode that draws.
 *
 * It is the same control in three places — DSA, concepts and system design —
 * and the only things that differ are the facets you can filter on and the
 * noun in the prose. Those are props; nothing about the rotation is.
 */

/** One filterable dimension: difficulty, topic, target level. */
export type SurpriseFacet = {
  /** Key into `DrawRules.facets` — must match what the candidate carries. */
  key: string;
  label: string;
  options: { value: string; label: string }[];
  /** Optional value → colour, for difficulty chips. */
  colors?: Record<string, string>;
  /** Scroll the chip list past this many options rather than growing the card. */
  scroll?: boolean;
};

export function SurprisePanel({
  unit, poolSize, tally, note, assigned, facets, rules, onRules, onDraw, onReset,
  outcomes = true, error,
}: {
  /** The noun this mode uses: "question", "problem". */
  unit: string;
  poolSize: number;
  tally: { solved: number; retry: number; pending: number; asked: number };
  /** Why the pool is empty, in the user's terms. Null when it is not. */
  note: string | null;
  /** What was just drawn, already formatted by the caller. */
  assigned: ReactNode;
  facets: SurpriseFacet[];
  rules: DrawRules;
  onRules: (next: DrawRules) => void;
  onDraw: () => void;
  onReset: () => void;
  /**
   * Whether the round provides per-question evaluation verdicts.
   * False for open-ended modes like system design.
   */
  outcomes?: boolean;
  /** Why the draw's history could not be read. */
  error?: string | null;
}) {
  const [showRules, setShowRules] = useState(false);
  const ruleCount = facets.reduce((n, f) => n + (rules.facets[f.key]?.length ?? 0), 0);

  const set = (key: string, value: string) => {
    const cur = rules.facets[key] ?? [];
    const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    onRules({ ...rules, facets: { ...rules.facets, [key]: next } });
  };

  return (
    <div className="rounded-md border border-border bg-surface-alt p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={onDraw} disabled={poolSize === 0}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg
                     transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
          Surprise me
        </button>

        <span className="text-xs tabular-nums text-fg-muted">
          {poolSize} to draw from
          {outcomes ? (
            <>
              {tally.solved > 0 && <> · {tally.solved} solved</>}
              {tally.retry > 0 && <> · {tally.retry} to retry</>}
              {tally.pending > 0 && <> · {tally.pending} awaiting a report</>}
            </>
          ) : (
            tally.asked > 0 && <> · {tally.asked} already used this cycle</>
          )}
          {tally.asked === 0 && <> · none asked yet this cycle</>}
        </span>

        <div className="ml-auto flex items-center gap-3">
          {tally.asked > 0 && (
            <button type="button" onClick={onReset}
              className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline">
              Reset cycle
            </button>
          )}
          <button type="button" onClick={() => setShowRules((v) => !v)} aria-expanded={showRules}
            className="text-xs text-fg-subtle hover:text-fg">
            {showRules ? 'Hide rules' : ruleCount ? `Rules (${ruleCount})` : 'Rules'}
          </button>
        </div>
      </div>

      {/* Announced, because the whole point is that the choice was not yours:
          a sighted user watches it appear in the list below, and a screen
          reader has to be told. */}
      <div aria-live="polite" className="mt-2 space-y-0.5 empty:mt-0">
        {assigned}
        {note && <p className="text-xs text-warning">{note}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>

      {showRules && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {facets.map((f) => (
            f.options.length === 0 ? null : (
              <div key={f.key}>
                <span className={LABEL}>{f.label}</span>
                <div className={`flex flex-wrap gap-1.5 ${f.scroll ? 'max-h-24 overflow-y-auto' : ''}`}>
                  {f.options.map((o) => (
                    <Chip key={o.value} on={(rules.facets[f.key] ?? []).includes(o.value)}
                      color={f.colors?.[o.value]} onClick={() => set(f.key, o.value)}>
                      {o.label}
                    </Chip>
                  ))}
                </div>
              </div>
            )
          ))}

          <p className="text-[11px] leading-relaxed text-fg-subtle">
            Nothing selected means no constraint. A {unit} qualifies if it carries
            <em> any</em> value you picked within a group, so two topics widens the draw rather
            than narrowing it to whatever carries both.
          </p>

          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <input type="checkbox" className="accent-brand" checked={rules.avoidRepeats}
              onChange={(e) => onRules({ ...rules, avoidRepeats: e.target.checked })} />
            Never ask the same {unit} twice until the list runs out
          </label>

          {outcomes && (
            <>
              <label className="flex items-center gap-2 text-sm text-fg-muted">
                <input type="checkbox" className="accent-brand" checked={rules.repeatUnsolved}
                  disabled={!rules.avoidRepeats}
                  onChange={(e) => onRules({ ...rules, repeatUnsolved: e.target.checked })} />
                Keep asking until I actually get it right
              </label>

              <p className="text-[11px] leading-relaxed text-fg-subtle">
                Your report says how each {unit} went. With this on, only one you got
                <em> right</em> leaves the rotation — a half answer, or one you could not defend
                when pushed, comes back. A round whose report has not arrived yet stays out until
                it does.
              </p>
            </>
          )}

          <p className="text-[11px] leading-relaxed text-fg-subtle">
            Which {unit}s you have had comes from your round history, so it follows you to another
            browser. Resetting the cycle deletes nothing — it only moves the line for what counts
            as a repeat.
          </p>

        </div>
      )}
    </div>
  );
}

function Chip({ on, color, onClick, children }: {
  on: boolean;
  color?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      style={on && color ? { color } : undefined}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        on ? 'border-brand bg-brand-muted text-fg' : 'border-border text-fg-muted hover:bg-surface-hover'}`}>
      {children}
    </button>
  );
}
