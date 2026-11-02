import type { CollectionInfo } from '../lib/api';

/**
 * Section selector rail for question banks.
 * Displays sections in a sidebar on desktop and as a horizontal scrolling chip row
 * on smaller viewports to keep the main question list visible.
 */
export function CollectionRail({
  collections, collection, onCollection, pickedCount, onClear,
  heading = 'Lists', unit = 'questions',
}: {
  collections: CollectionInfo[];
  collection: string;
  onCollection: (id: string) => void;
  pickedCount: number;
  onClear: () => void;
  /**
   * What the sections ARE. The rail is the same control for DSA lists, concept
   * topics and behavioural competencies — only the noun changes, so only the
   * noun is a prop. Defaults keep every existing call site unchanged.
   */
  heading?: string;
  unit?: string;
}) {
  return (
    <aside aria-label={heading} className="min-w-0 lg:sticky lg:top-8">
      <p className="mb-2 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle lg:px-2">
        {heading}
      </p>

      <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:block lg:space-y-0.5 lg:overflow-x-visible lg:pb-0">
        {collections.map((c) => {
          const active = collection === c.id;
          return (
            /* `shrink-0` keeps a chip at its natural width so the row scrolls
               instead of crushing nine labels into the viewport. */
            <li key={c.id} className="shrink-0 lg:shrink">
              <button
                onClick={() => onCollection(c.id)}
                aria-current={active ? 'true' : undefined}
                className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors lg:border-0 ${
                  active ? 'border-brand bg-brand-muted' : 'border-border hover:bg-surface-hover'
                }`}
              >
                <span className={`block truncate text-sm font-medium ${active ? 'text-fg' : 'text-fg-muted'}`}>
                  {c.label}
                </span>
                <span className="block text-[11px] tabular-nums text-fg-subtle">
                  {c.count} {unit}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {collections.length > 0 && (
        <p className="mt-2 px-0.5 text-[11px] leading-relaxed text-fg-subtle lg:mt-3 lg:px-2.5">
          {collections.find((c) => c.id === collection)?.blurb}
        </p>
      )}

      {pickedCount > 0 && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border px-0.5 pt-2 lg:mt-4 lg:px-2.5 lg:pt-3">
          <span className="text-xs text-fg-muted">{pickedCount} selected</span>
          <button onClick={onClear} className="text-xs text-fg-subtle hover:text-fg">Clear</button>
        </div>
      )}
    </aside>
  );
}
