import { useState } from 'react';
import { api, type ConversationDetail, type ConversationSummary, type MentorMemory } from '../lib/api';
import { mmss } from '../lib/time';
import { speakerColor } from '../lib/colors';
import { useApi } from '../hooks/useApi';
import { ErrorNote } from './ui/ErrorNote';
import { ConfirmButton } from './ui/ConfirmButton';

/**
 * Displays persistent mentor memory notes across conversations.
 * Kept visible with delete controls even if conversation history fails to load.
 */

const KIND_ORDER = ['goal', 'pattern', 'preference', 'context'];
const KIND_BLURB: Record<string, string> = {
  goal: 'What you are working towards',
  pattern: 'Behaviour it has seen more than once',
  preference: 'How you want to be coached',
  context: 'Your circumstances — the role, the timeline',
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function MentorMemory() {
  const mem = useApi<MentorMemory[]>('/api/mentor/memories');
  const conv = useApi<ConversationSummary[]>('/api/mentor/conversations');
  const [open, setOpen] = useState<ConversationDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const forget = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.del(`/api/mentor/memories/${id}`);
      mem.setData((prev) => prev?.filter((m) => m.id !== id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const show = async (id: string) => {
    setError(null);
    try {
      setOpen(await api.get<ConversationDetail>(`/api/mentor/conversations/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const memories = mem.data ?? [];
  const conversations = conv.data;

  const grouped = [
    ...KIND_ORDER.map((k) => ({ kind: k, rows: memories.filter((m) => m.kind === k) })),
    { kind: 'other', rows: memories.filter((m) => !KIND_ORDER.includes(m.kind)) },
  ].filter((g) => g.rows.length);

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-fg">What your mentor remembers</h3>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
        Written by the mentor, not by you, and used in every conversation you have with it. Scores
        and metrics are not here — those are recomputed each time, so a saved copy could only go
        stale. Delete anything that is wrong; it will not be missed.
      </p>

      {error && <ErrorNote className="mt-3" message={error} />}

      {mem.error ? (
        <ErrorNote className="mt-4" message={`Could not load what the mentor remembers: ${mem.error}`}
                   onRetry={mem.reload} />
      ) : mem.loading && !mem.data ? (
        <p className="mt-4 text-sm text-fg-subtle">Loading…</p>
      ) : grouped.length === 0 ? (
        <p className="mt-4 text-sm text-fg-subtle">
          Nothing yet. The mentor writes a note when it learns something the numbers cannot tell it
          — a deadline you are working to, a habit it has now seen more than once, how you want to
          be coached.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {grouped.map((g) => (
            <div key={g.kind}>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                {g.kind}
                {KIND_BLURB[g.kind] && (
                  <span className="ml-2 font-normal normal-case tracking-normal text-fg-subtle">
                    · {KIND_BLURB[g.kind]}
                  </span>
                )}
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {g.rows.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-start gap-3 rounded-md border border-border bg-surface-alt px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-relaxed text-fg">{m.content}</p>
                      <p className="mt-1 text-[11px] text-fg-subtle">
                        {m.timesObserved > 1 && (
                          <span className="text-fg-muted">seen {m.timesObserved}× · </span>
                        )}
                        updated {day(m.updatedAt)}
                      </p>
                    </div>
                    <ConfirmButton
                      label="Forget"
                      question="Forget this note?"
                      confirmLabel="Yes, forget"
                      onConfirm={() => forget(m.id)}
                      busy={busy === m.id}
                      ariaLabel={`Forget: ${m.content.slice(0, 60)}`}
                      className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium
                                 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg
                                 disabled:opacity-50"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ── past conversations ────────────────────────────────────────────── */}
      <h4 className="mt-6 text-sm font-semibold text-fg">Past conversations</h4>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
        Coaching and mentor conversations are kept as text so the mentor can look back at what you
        agreed. It only reads one when it needs to — they are never loaded automatically. No audio
        of these is recorded.
      </p>

      {conv.error ? (
        <ErrorNote className="mt-3" message={`Could not load past conversations: ${conv.error}`}
                   onRetry={conv.reload} />
      ) : !conversations ? (
        <p className="mt-3 text-sm text-fg-subtle">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="mt-3 text-sm text-fg-subtle">None saved yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-md border border-border">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => void show(c.id)}
                className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left
                           transition-colors hover:bg-surface-hover"
              >
                <span className="text-sm text-fg">
                  {c.scope === 'account' ? 'Mentor' : 'Coach'}
                  <span className="ml-2 text-xs text-fg-muted">{day(c.startedAt)}</span>
                </span>
                <span className="font-mono text-xs tabular-nums text-fg-subtle">
                  {mmss(c.durationMs)} · {c.messageCount} msg
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 rounded-md border border-border bg-surface-alt p-4">
          <div className="mb-3 flex items-center justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              {open.scope === 'account' ? 'Mentor' : 'Coach'} · {day(open.startedAt)} ·{' '}
              {mmss(open.durationMs)}
            </p>
            <button
              onClick={() => setOpen(null)}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg
                         transition-colors hover:bg-surface-hover"
            >
              Close
            </button>
          </div>
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {open.messages.map((m) => (
              <div key={m.idx}>
                <span
                  className="text-xs font-semibold uppercase tracking-wide"
                  style={{ color: speakerColor(m.speaker) }}
                >
                  {m.speaker === 'ai' ? (open.scope === 'account' ? 'Mentor' : 'Coach') : 'You'}
                </span>
                <p className="mt-0.5 text-sm leading-relaxed text-fg">{m.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
