import { RETIRING_OUTCOMES, type QuestionOutcomeKind } from '@orvia/shared';
import { LABEL } from '../ui/styles';

/**
 * Question picker for spoken rounds, displaying full prompts for context.
 */
export function PickList({
  items, picked, onToggle, empty, metaColor,
}: {
  items: {
    id: string;
    title: string;
    prompt: string;
    meta?: string;
    /** This cycle's verdict, where the mode has a draw. */
    cycle?: { asked: boolean; outcome: QuestionOutcomeKind | null };
  }[];
  picked: string[];
  onToggle: (id: string) => void;
  empty: string;
  metaColor?: Record<string, string>;
}) {
  return (
    <div className="max-h-[20rem] space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5 sm:max-h-[26rem]">
      {items.length === 0 && <p className="p-3 text-sm text-fg-subtle">{empty}</p>}
      {items.map((q) => {
        const on = picked.includes(q.id);
        return (
          <button key={q.id} onClick={() => onToggle(q.id)} aria-pressed={on}
            className={`w-full rounded px-3 py-2 text-left transition-colors ${
              on ? 'bg-brand-muted' : 'hover:bg-surface-hover'}`}>
            <span className="flex items-baseline gap-2">
              <span className={`min-w-0 flex-1 text-sm font-medium ${on ? 'text-fg' : 'text-fg-muted'}`}>
                {q.title}
              </span>
              {q.cycle && <CycleMark {...q.cycle} />}
              {q.meta && (
                <span className="shrink-0 text-[11px] font-semibold capitalize"
                      style={metaColor ? { color: metaColor[q.meta] } : undefined}>
                  {q.meta}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-fg-subtle">{q.prompt}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The picked questions, in the order they will be asked.
 *
 * Resolves each title from the WHOLE bank rather than from what is on screen,
 * because these rounds are normally a mix of topics and a list that blanks out
 * half its rows when you switch the rail is worse than no list.
 */
export function PickedOrder({
  label, ids, titleOf, subtitleOf, onRemove,
}: {
  label: string;
  ids: string[];
  titleOf: (id: string) => string | undefined;
  subtitleOf?: (id: string) => string | undefined;
  onRemove: (id: string) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <div>
      <span className={LABEL}>{label} ({ids.length})</span>
      <ol className="space-y-1.5">
        {ids.map((id, i) => (
          <li key={id} className="flex items-center gap-2.5 rounded-md bg-surface-alt px-3 py-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                             bg-brand text-[11px] font-semibold text-brand-fg">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{titleOf(id) ?? id}</span>
            {subtitleOf?.(id) && (
              <span className="hidden shrink-0 text-[11px] text-fg-subtle sm:block">
                {subtitleOf(id)}
              </span>
            )}
            <button onClick={() => onRemove(id)}
                    className="shrink-0 text-xs text-fg-subtle hover:text-danger">Remove</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What this cycle already knows about a question.
 *
 * Deliberately not colour alone: each state carries its own glyph and its own
 * title text, because "solved" and "come back to this" is exactly the
 * distinction a red/green pair fails to convey to a colour-blind reader.
 */
export function CycleMark({
  asked, outcome, verdicts = true,
}: {
  asked: boolean;
  outcome: QuestionOutcomeKind | null;
  /**
   * False where no per-question verdict will ever arrive — a system design
   * round is scored by phase, not solved or not. Without this the mark would
   * promise a report that is never coming.
   */
  verdicts?: boolean;
}) {
  if (!asked) return <span className="w-4 shrink-0" aria-hidden />;

  const state = !verdicts
    ? { glyph: '•', label: 'Used this cycle — not in the draw', color: 'text-fg-subtle' }
    : outcome === null
    ? { glyph: '…', label: 'Asked this cycle — report not in yet', color: 'text-fg-subtle' }
    : RETIRING_OUTCOMES.includes(outcome)
      ? { glyph: '✓', label: 'Solved this cycle', color: 'text-success' }
      : { glyph: '↻', label: 'Asked but not solved — still in the rotation', color: 'text-warning' };

  return (
    <span className={`w-4 shrink-0 text-center text-xs font-semibold ${state.color}`}
          title={state.label} aria-label={state.label}>
      {state.glyph}
    </span>
  );
}
