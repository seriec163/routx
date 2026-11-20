import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from './api';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<T | null>;
  setData: (value: T | null) => void;
}

/** Простой загрузчик GET-ресурса с возможностью ручного обновления. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<T | null> => {
    if (!path) {
      setLoading(false);
      return null;
    }
    try {
      setLoading(true);
      const payload = await api<T>(path);
      setData(payload);
      setError(null);
      return payload;
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
}
