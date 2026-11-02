import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../lib/api';

export type ApiState<T> = {
  data: T | null;
  /** The failure message. A failed fetch is an error on screen, never an empty state. */
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** For optimistic local edits (a delete, an insert) without a refetch. */
  setData: Dispatch<SetStateAction<T | null>>;
};

/**
 * GET `path` and keep the latest answer. A null path fetches nothing.
 *
 * A response that lands after `path` has changed or the component has unmounted
 * is dropped, so switching quickly never renders the previous request's data.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);
    api
      .get<T>(path)
      .then((res) => {
        if (!stale) setData(res);
      })
      .catch((e: unknown) => {
        if (!stale) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      // Invalidates this request whether the path changed or the page left.
      stale = true;
    };
  }, [path, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { data, error, loading, reload, setData };
}
