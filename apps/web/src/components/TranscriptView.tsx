import { useEffect, useRef, useState } from 'react';
import type { TranscriptEntry } from '../lib/transcript';
import { speakerColor } from '../lib/colors';
import { mmss } from '../lib/time';

export function TranscriptView({ entries }: { entries: TranscriptEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Auto-scroll only while the user is already at the bottom, so scrolling back
  // to re-read an earlier answer is not yanked away on the next fragment.
  useEffect(() => {
    if (pinned) ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [entries, pinned]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      }}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-4"
    >
      {entries.length === 0 && (
        <p className="text-sm text-fg-subtle">Waiting for the interviewer to begin…</p>
      )}
      {entries.map((e) => (
        <div key={e.id}>
          <div className="mb-1 flex items-baseline gap-2">
            <span
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: speakerColor(e.speaker) }}
            >
              {e.speaker === 'ai' ? 'Interviewer' : 'You'}
            </span>
            <span className="font-mono text-[10px] text-fg-subtle">{mmss(e.atMs)}</span>
          </div>
          <p className={`text-sm leading-relaxed ${e.final ? 'text-fg' : 'italic text-fg-muted'}`}>
            {e.text}
          </p>
        </div>
      ))}
    </div>
  );
}
