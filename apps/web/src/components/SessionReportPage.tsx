import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MODE_LABELS } from '@orvia/shared';
import type { SessionDetail } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { TranscriptView } from './TranscriptView';
import { RunAgainButton } from './RunAgainButton';
import { ReportSection } from './ReportSection';
import { ErrorNote } from './ui/ErrorNote';
import { isUuid } from '../lib/ids';

/** A past round's report, reachable from History. */
export function SessionReportPage() {
  const { id = '' } = useParams();
  const valid = isUuid(id);
  const sessionReq = useApi<SessionDetail>(valid ? `/api/sessions/${id}` : null);
  const session = sessionReq.data;
  const [showTranscript, setShowTranscript] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <Link to="/history" className="text-sm text-fg-muted hover:text-fg">← History</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">
              {session ? (MODE_LABELS[session.mode] ?? session.mode) : 'Round'}
            </h1>
            {session && (
              <p className="mt-1 text-sm text-fg-muted">
                {new Date(session.startedAt).toLocaleString()}
                {session.durationMs ? ` · ${(session.durationMs / 60000).toFixed(1)} min` : ''}
              </p>
            )}
          </div>
          {/* Held back until the session has loaded, so it cannot be pressed for a round that 404s. */}
          {session && <RunAgainButton sessionId={session.id} />}
        </div>
      </header>

      {!valid ? (
        <ErrorNote message="There is no round at this address. Open it from History instead." />
      ) : sessionReq.error ? (
        <ErrorNote message={`This round could not be loaded: ${sessionReq.error}`} onRetry={sessionReq.reload} />
      ) : (
        <ReportSection
          sessionId={id}
          waitingTitle="Loading report…"
          missingFallback="This round has no report."
        />
      )}

      {session && session.turns.length > 0 && (
        <div>
          <button onClick={() => setShowTranscript(!showTranscript)}
            className="text-sm font-medium text-brand hover:underline">
            {showTranscript ? 'Hide transcript' : 'Show full transcript'}
          </button>
          {showTranscript && (
            <div className="mt-3 flex h-96 flex-col">
              <TranscriptView entries={session.turns.map((t) => ({
                id: t.id, speaker: t.speaker, text: t.text, final: true, atMs: t.startMs,
              }))} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
