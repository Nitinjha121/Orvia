import { useEffect, useState } from 'react';
import type { RephraseItem, RephraseView } from '@orvia/shared';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { ErrorNote } from './ui/ErrorNote';

const SHOWN = 6;
const POLL_MS = 4000;

/**
 * Each substantial thing you said, with a tighter version of the same content
 * under it. "Try it first" hides the rewrites so you can say your own better
 * version aloud before reading one.
 */
export function SayItBetter({ sessionId }: { sessionId: string }) {
  const path = `/api/sessions/${sessionId}/rephrase`;
  const { data, error, reload, setData } = useApi<RephraseView>(path);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [tryFirst, setTryFirst] = useState(false);

  const writing = data?.status === 'writing';
  useEffect(() => {
    if (!writing) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [writing, reload]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      setData(await api.post<RephraseView>(path));
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  if (error) return <ErrorNote message={`The rewrites did not load: ${error}`} onRetry={reload} />;
  if (!data) return null;

  const rewritten = data.items.filter((i) => i.better !== null);
  const saidWords = rewritten.reduce((a, i) => a + i.saidWords, 0);
  const betterWords = rewritten.reduce((a, i) => a + (i.betterWords ?? 0), 0);
  const shown = all ? data.items : data.items.slice(0, SHOWN);

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">Say it better</h3>
          <p className="mt-1 text-xs text-fg-muted">
            What you said, and the same ideas said tighter. Only the wording changes; whether
            the content was right is judged in the report above.
          </p>
        </div>
        {data.status === 'complete' && data.items.length > 0 && (
          <label className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={tryFirst} onChange={(e) => setTryFirst(e.target.checked)} />
            Try it first
          </label>
        )}
      </div>

      {startError && <div className="mt-3"><ErrorNote message={startError} /></div>}

      {data.status === 'none' && (
        <button onClick={start} disabled={starting}
          className="mt-4 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
          {starting ? 'Starting…' : 'Rewrite my answers'}
        </button>
      )}

      {writing && (
        <div className="mt-4 flex items-center gap-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
          <p className="text-sm text-fg">Rewriting your answers… usually under a minute.</p>
        </div>
      )}

      {data.status === 'failed' && (
        <div className="mt-4">
          <p className="text-sm text-fg-muted">The rewrite failed{data.error ? `: ${data.error}` : '.'}</p>
          <button onClick={start} disabled={starting}
            className="mt-3 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
            {starting ? 'Starting…' : 'Try again'}
          </button>
        </div>
      )}

      {data.status === 'complete' && data.items.length === 0 && (
        <p className="mt-4 text-sm text-fg-muted">You said nothing long enough in this round to rewrite.</p>
      )}

      {data.status === 'complete' && data.items.length > 0 && (
        <>
          {rewritten.length > 0 && (
            <p className="mt-3 text-sm text-fg">
              {rewritten.length} of {data.items.length} answers could be tighter:{' '}
              <span className="tabular-nums">{saidWords}</span> words said,{' '}
              <span className="tabular-nums">{betterWords}</span> needed.
            </p>
          )}
          <ol className="mt-4 space-y-5">
            {shown.map((item) => <Paragraph key={item.idx} item={item} hidden={tryFirst} />)}
          </ol>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {data.items.length > SHOWN ? (
              <button onClick={() => setAll(!all)} className="text-xs font-medium text-brand hover:underline">
                {all ? 'Show fewer' : `Show all ${data.items.length}`}
              </button>
            ) : <span />}
            <button onClick={start} disabled={starting}
              className="text-xs text-fg-subtle hover:text-fg disabled:opacity-50">
              {starting ? 'Starting…' : 'Rewrite again'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Paragraph({ item, hidden }: { item: RephraseItem; hidden: boolean }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => setRevealed(false), [hidden]);

  return (
    <li className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      {item.asked && (
        <p className="text-xs leading-relaxed text-fg-subtle">
          <span className="font-semibold uppercase tracking-wide">Interviewer</span> · {item.asked}
        </p>
      )}
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          What you said <span className="font-normal normal-case tabular-nums">· {item.saidWords} words</span>
        </h4>
        <p className="rounded-md p-3 text-sm leading-relaxed text-fg" style={{ background: 'var(--orvia-color-surface-alt)' }}>
          {item.said}
        </p>
      </div>
      {item.better === null ? (
        <p className="text-xs text-fg-subtle">Clear enough as you said it.</p>
      ) : hidden && !revealed ? (
        <button onClick={() => setRevealed(true)} className="text-xs font-medium text-brand hover:underline">
          Say it aloud your way, then show the rewrite
        </button>
      ) : (
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Say it like this <span className="font-normal normal-case tabular-nums">· {item.betterWords} words</span>
          </h4>
          <p className="rounded-md p-3 text-sm leading-relaxed text-fg" style={{ background: 'var(--orvia-color-brand-muted)' }}>
            {item.better}
          </p>
          {item.why && <p className="mt-1.5 text-xs text-fg-muted">{item.why}</p>}
        </div>
      )}
    </li>
  );
}
