import { useCallback, useEffect, useRef, useState } from 'react';
import type { EvaluationView, NoEvaluation } from '@orvia/shared';
import { ApiError, api } from '../lib/api';

type Response = EvaluationView | NoEvaluation;

/**
 * Polls for a session's evaluation report with exponential backoff.
 * `waiting` remains true only while evaluation is actively pending or in flight.
 * Retries restart polling, and non-transient 4xx errors terminate polling immediately.
 */
export function useEvaluation(sessionId: string | null) {
  const [report, setReport] = useState<EvaluationView | null>(null);
  const [missing, setMissing] = useState<NoEvaluation | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);

  /** Resolves true when there is nothing further to wait for. */
  const fetchOnce = useCallback(async (id: string) => {
    const res = await api.get<Response>(`/api/sessions/${id}/evaluation`);
    if (res.status === 'none') {
      setReport(null);
      setMissing(res);
      return !res.pending;
    }
    setMissing(null);
    setReport(res as EvaluationView);
    return res.status === 'complete' || res.status === 'failed';
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setWaiting(true);
    setError(null);

    // Backs off from 2s to 10s: the first report usually lands inside a minute,
    // but a long round with a lot of audio can take several.
    let delay = 2000;
    const tick = async () => {
      if (cancelled) return;
      try {
        const done = await fetchOnce(sessionId);
        if (done) {
          setWaiting(false);
          return;
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          setError(e.message || `The report could not be loaded (${e.status}).`);
          setWaiting(false);
          return;
        }
        /* network or 5xx — keep polling */
      }
      delay = Math.min(delay * 1.4, 10_000);
      timer.current = setTimeout(tick, delay);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [sessionId, attempt, fetchOnce]);

  const retry = useCallback(async () => {
    if (!sessionId) return;
    setRetrying(true);
    setError(null);
    try {
      await api.post(`/api/sessions/${sessionId}/evaluation`);
    } catch (e) {
      setError(`Could not start a new evaluation: ${(e as Error).message}`);
      return;
    } finally {
      setRetrying(false);
    }
    setReport(null);
    setMissing(null);
    // Re-runs the effect above, which is what actually polls. Fetching here
    // instead would read the row before the run has created it.
    setAttempt((n) => n + 1);
  }, [sessionId]);

  return { report, missing, waiting, error, retrying, retry };
}
