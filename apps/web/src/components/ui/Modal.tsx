import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal on the native `<dialog>`: `showModal()` gives the top layer, the
 * focus trap, Escape and inert page content without a library. Closing is
 * always reported through `onClose`, whichever of those closed it.
 */
export function Modal({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (!open) return;
    // The page behind would otherwise scroll under a wheel or a swipe.
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, [open]);

  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose}
      // The dialog box has no padding, so a click that lands on the dialog
      // itself rather than its content landed on the backdrop.
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto w-[min(40rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-surface p-0 text-fg
                 shadow-lg backdrop:bg-bg/70 backdrop:backdrop-blur-sm">
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
            <h2 id={titleId} className="min-w-0 text-base font-semibold text-fg">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close"
              className="-mr-1 shrink-0 rounded-md px-2 py-0.5 text-lg leading-none text-fg-muted hover:bg-surface-hover hover:text-fg">
              ×
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
          {footer && <footer className="border-t border-border px-4 py-3 sm:px-5">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
