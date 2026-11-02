import { scoreColor } from '../../lib/colors';

export type TopicRow = { topic: string; questions: number; average: number };

/**
 * Horizontal bar chart displaying performance by subject, sorted weakest first.
 * Uses a three-band status color signal to highlight performance tiers.
 */
export function TopicBars({ rows, limit = 10 }: { rows: TopicRow[]; limit?: number }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-fg-subtle">
        Not enough data yet — a topic needs at least two questions before its average means anything.
      </p>
    );
  }

  const shown = rows.slice(0, limit);

  return (
    <>
      <div className="space-y-2.5">
        {shown.map((r) => (
          /* Label column narrows on a phone rather than the bar — see the same
             trade-off in `DimensionBars`. */
          <div key={r.topic} className="flex items-center gap-2 sm:gap-3">
            <span className="w-24 shrink-0 truncate text-xs text-fg-muted sm:w-36" title={r.topic}>
              {r.topic}
            </span>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-alt">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${(r.average / 10) * 100}%`, background: scoreColor(r.average / 10) }}
              />
            </div>
            <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-fg">
              {r.average}
            </span>
            {/* Sample size is shown because an average over two questions and
                an average over twenty deserve very different confidence. */}
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-fg-subtle sm:w-14">
              {r.questions} q
            </span>
          </div>
        ))}
      </div>
      {rows.length > limit && (
        <p className="mt-3 text-xs text-fg-subtle">
          Showing the {limit} weakest of {rows.length} topics.
        </p>
      )}
    </>
  );
}
