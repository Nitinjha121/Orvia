/** A one-of-N toggle row. Buttons with `aria-pressed`, so each option keeps its button role. */
export function Segmented<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  /** Accessible name for the group. */
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 rounded-md bg-surface-alt p-1">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onChange(o)} aria-pressed={value === o}
          className={`flex-1 rounded px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
            value === o ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}>
          {o}
        </button>
      ))}
    </div>
  );
}
