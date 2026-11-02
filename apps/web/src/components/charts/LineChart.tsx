import { useEffect, useMemo, useRef, useState } from 'react';

/** `x` is a timestamp: points are spaced by time, so a fortnight's gap reads as one. */
export type Point = { x: number; y: number; label: string };

/**
 * Single-series line chart rendered with inline SVG.
 * Multiple metrics use separate charts with individual axes rather than dual y-scales.
 */
export function LineChart({
  points, height = 140, color = 'var(--orvia-color-brand)',
  yMin, yMax, band, unit = '', format = (v: number) => String(Math.round(v)), title,
}: {
  points: Point[];
  /** What the chart measures, for its accessible name. */
  title: string;
  height?: number;
  color?: string;
  yMin?: number;
  yMax?: number;
  /** Shaded "healthy range", e.g. 110-180 wpm. Context the axis cannot give. */
  band?: { from: number; to: number; label: string };
  unit?: string;
  format?: (v: number) => string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e!.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // Right padding is measured from the endpoint label rather than fixed: a
  // constant 46px clipped "226 wpm" and "0.0/100w" mid-character, which is
  // worse than having no label at all.
  const endLabel = points.length ? format(points[points.length - 1]!.y) : '';
  const PAD = {
    top: 16,
    right: Math.max(30, endLabel.length * 7 + 14),
    bottom: 22,
    left: 36,
  };
  const plotW = Math.max(10, w - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);

  const { lo, hi, xy, ticks } = useMemo(() => {
    const ys = points.map((p) => p.y);
    let lo = yMin ?? Math.min(...ys, band?.from ?? Infinity);
    let hi = yMax ?? Math.max(...ys, band?.to ?? -Infinity);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const padY = (hi - lo) * 0.12;
    lo = yMin ?? lo - padY;
    hi = yMax ?? hi + padY;

    const xs = points.map((p) => p.x);
    const x0 = Math.min(...xs);
    const span = Math.max(...xs) - x0;
    const sx = (x: number) => (points.length <= 1 || span <= 0 ? plotW / 2 : ((x - x0) / span) * plotW);
    const sy = (v: number) => plotH - ((v - lo) / (hi - lo)) * plotH;

    return {
      lo, hi,
      xy: points.map((p) => ({ ...p, cx: sx(p.x), cy: sy(p.y) })),
      // Bottom, middle and top of the scale; they carry the values not directly labelled.
      ticks: [lo, (lo + hi) / 2, hi].map((v) => ({ v, y: sy(v) })),
      sy,
    };
  }, [points, plotW, plotH, yMin, yMax, band]);

  if (points.length === 0) {
    return <p className="py-8 text-center text-sm text-fg-subtle">Not enough data yet.</p>;
  }

  const path = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1]!;
  const active = hover !== null ? xy[hover] : null;
  const bandY = band
    ? { top: plotH - ((band.to - lo) / (hi - lo)) * plotH, bot: plotH - ((band.from - lo) / (hi - lo)) * plotH }
    : null;

  return (
    /* `min-w-0` so this can never become the thing that stops an ancestor
       shrinking: the svg below carries an explicit pixel width, which is a
       min-content floor until the observer above has measured for real. */
    <div ref={wrap} className="w-full min-w-0">
      <svg
        width={w} height={height} role="img"
        aria-label={`${title}: ${points.length} round${points.length === 1 ? '' : 's'}, latest ${endLabel}${unit}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const rel = e.clientX - box.left - PAD.left;
          // Nearest point rather than a strict hit box — a 2px line is an
          // unreasonably small target.
          let best = 0, bestD = Infinity;
          xy.forEach((p, i) => { const d = Math.abs(p.cx - rel); if (d < bestD) { bestD = d; best = i; } });
          setHover(best);
        }}
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {bandY && (
            <>
              <rect x={0} y={bandY.top} width={plotW} height={Math.max(0, bandY.bot - bandY.top)}
                    fill="var(--orvia-color-fg)" opacity={0.045} />
              {/* Anchored left, inside the band — the right edge belongs to the
                  endpoint label, and stacking the two there collides. */}
              <text x={4} y={bandY.top + 11} textAnchor="start"
                    className="fill-fg-subtle" style={{ fontSize: 9 }}>
                {band!.label}
              </text>
            </>
          )}

          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={0} y1={t.y} x2={plotW} y2={t.y}
                    stroke="var(--orvia-color-border)" strokeWidth={1} />
              <text x={-8} y={t.y + 3} textAnchor="end"
                    className="fill-fg-subtle" style={{ fontSize: 10 }}>
                {format(t.v)}
              </text>
            </g>
          ))}

          <path d={path} fill="none" stroke={color} strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" />

          {active && (
            <line x1={active.cx} y1={0} x2={active.cx} y2={plotH}
                  stroke="var(--orvia-color-border-strong)" strokeWidth={1} />
          )}

          {xy.map((p, i) => (
            <circle key={i} cx={p.cx} cy={p.cy}
                    r={hover === i ? 5 : points.length > 24 ? 0 : 3.5}
                    fill={color} stroke="var(--orvia-color-surface)" strokeWidth={2} />
          ))}

          {/* Endpoint only — selective labelling is why direct labels work.
              The unit lives in the card subtitle and the tooltip, so it does
              not have to fit here. */}
          <text x={last.cx + 9} y={last.cy + 4} className="fill-fg"
                style={{ fontSize: 11, fontWeight: 600 }}>
            {endLabel}
          </text>
        </g>
      </svg>

      {active && (
        <div className="mt-1 flex items-baseline gap-2 px-1 text-xs">
          <span className="h-2 w-2 rounded-full" style={{ background: color }} />
          <span className="font-medium text-fg">{format(active.y)}{unit}</span>
          <span className="text-fg-subtle">{active.label}</span>
        </div>
      )}
    </div>
  );
}
