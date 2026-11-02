import { DELIVERY_DIMENSIONS } from '@orvia/shared';
import { scoreColor } from '../../lib/colors';

/**
 * Latest delivery scores with movement against the previous round.
 *
 * A horizontal bar per dimension rather than a radar: radar charts make area
 * look meaningful when it is not, and are hard to read against a baseline.
 * Bars share one axis, so "is this improving" is answerable at a glance.
 */
export function DimensionBars({
  latest, previous,
}: { latest: Record<string, number>; previous?: Record<string, number> }) {
  const rows = DELIVERY_DIMENSIONS
    .map((d) => ({ ...d, score: latest[d.id], prev: previous?.[d.id] }))
    .filter((r) => typeof r.score === 'number')
    .sort((a, b) => a.score! - b.score!);

  if (rows.length === 0) {
    return <p className="text-sm text-fg-subtle">No delivery scores yet.</p>;
  }

  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const delta = r.prev != null ? r.score! - r.prev : null;
        return (
          /* The label column narrows on a phone rather than the bar doing so:
             a bar squeezed to twenty pixels stops encoding anything, and the
             numeral beside it carries the exact value regardless. */
          <div key={r.id} className="flex items-center gap-2 sm:gap-3">
            <span className="w-24 shrink-0 truncate text-xs text-fg-muted sm:w-32" title={r.label}>
              {r.label}
            </span>

            {/* 2px surface gap does the separating — no border around the mark. */}
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-alt">
              <div className="absolute inset-y-0 left-0 rounded-full"
                   style={{ width: `${(r.score! / 5) * 100}%`, background: scoreColor(r.score! / 5) }} />
            </div>

            <span className="w-7 shrink-0 text-right text-xs font-semibold tabular-nums text-fg">
              {r.score}
            </span>

            {/* Direction is stated in text, never by colour alone. */}
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums sm:w-12"
                  style={{ color: delta == null ? 'var(--orvia-color-fg-subtle)'
                    : delta > 0 ? 'var(--orvia-color-success)'
                    : delta < 0 ? 'var(--orvia-color-danger)' : 'var(--orvia-color-fg-subtle)' }}>
              {delta == null ? '—' : delta === 0 ? 'same' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
