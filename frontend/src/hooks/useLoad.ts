import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { errorMessage } from '../domain';

interface Result<T> { url: string; version: number; data: T | null; error: string; }

export function useLoad<T>(url: string | null) {
  const [result, setResult] = useState<Result<T> | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    api.get<T>(url, { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setResult({ url, version, data: response.data, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ url, version, data: null, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [url, version]);

  const current = url && result?.url === url && result.version === version ? result : null;
  return { data: current?.data ?? null, loading: !!url && !current, error: current?.error ?? '', reload };
}
