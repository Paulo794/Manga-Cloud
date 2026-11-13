import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { errorMessage } from '../domain';

interface Result<T> { url: string; version: number; data: T | null; error: string; }
interface UseLoadOptions { onError?: (error: unknown) => void; }

export function useLoad<T>(url: string | null, options?: UseLoadOptions) {
  const [result, setResult] = useState<Result<T> | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const onErrorRef = useRef(options?.onError);

  useEffect(() => {
    onErrorRef.current = options?.onError;
  }, [options?.onError]);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    api.get<T>(url, { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setResult({ url, version, data: response.data, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) {
        setResult({ url, version, data: null, error: errorMessage(error) });
        onErrorRef.current?.(error);
      }
    });
    return () => controller.abort();
  }, [url, version]);

  const current = url && result?.url === url && result.version === version ? result : null;
  return { data: current?.data ?? null, loading: !!url && !current, error: current?.error ?? '', reload };
}
