/** Renders `backticked` spans as code — the only markup the static guides support. */
export function RichText({ children }: { children: string }) {
  const parts = children.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-surface-alt px-1 py-0.5 font-mono text-[0.95em] text-fg">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
