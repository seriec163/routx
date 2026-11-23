import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<T | null>;
  setData: (value: T | null) => void;
}

/**
 * Загружает GET-эндпоинт и отменяет устаревшие запросы.
 *
 * Без этого ответ от предыдущего path мог прийти позже нового и перезаписать
 * данные (например, при быстром переключении роутеров).
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const reload = useCallback(async (): Promise<T | null> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    controllerRef.current?.abort();
    if (!path) {
      setLoading(false);
      return null;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      setLoading(true);
      const payload = await api<T>(path, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return null;
      setData(payload);
      setError(null);
      return payload;
    } catch (caught) {
      if (requestId !== requestIdRef.current || controller.signal.aborted) return null;
      setError(errorMessage(caught));
      return null;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    return () => {
      controllerRef.current?.abort();
    };
  }, [reload]);

  return { data, loading, error, reload, setData };
}
