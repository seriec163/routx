import { useEffect } from 'react';

/**
 * Опрос с паузой в скрытой вкладке и немедленным обновлением при возврате.
 * Экономит батарею и запросы, когда панель открыта в фоне.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const tick = (): void => {
      if (!document.hidden) callback();
    };
    const timer = window.setInterval(tick, intervalMs);

    const onVisibility = (): void => {
      if (!document.hidden) callback();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [callback, intervalMs, enabled]);
}
