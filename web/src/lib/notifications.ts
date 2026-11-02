import { useEffect, useRef } from 'react';
import { api } from './api';
import { useToast } from '../components/ui';

interface NotificationItem {
  id: number;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  router_name: string | null;
  created_at: string;
  read_at: string | null;
}

const POLL_MS = 10_000;

/**
 * Всплывающие уведомления о событиях роутера: пропала связь, VPN не работает,
 * связь вернулась, роутер перезагрузился. Старые уведомления при открытии
 * панели не показываем — только те, что появились, пока страница открыта.
 */
export function useNotificationToasts(): void {
  const toast = useToast();
  const lastId = useRef<number | null>(null);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const show = (item: NotificationItem): void => {
      const text = item.router_name ? `${item.router_name}: ${item.message}` : item.message;
      if (
        item.severity === 'critical' ||
        item.kind === 'router.offline' ||
        item.kind === 'proxy.offline'
      ) {
        toast.error(text);
        return;
      }
      if (
        item.kind === 'router.online' ||
        item.kind === 'router.rebooted' ||
        item.kind === 'proxy.online'
      ) {
        toast.success(text);
        return;
      }
      toast.info(text);
    };

    const poll = async (): Promise<void> => {
      try {
        const data = await api<{ items: NotificationItem[] }>('/api/v1/notifications?limit=20');
        if (cancelled) return;

        const newest = data.items.reduce((max, item) => Math.max(max, item.id), 0);
        if (lastId.current === null) {
          lastId.current = newest;
        } else {
          const fresh = data.items
            .filter((item) => item.id > (lastId.current ?? 0) && !seen.current.has(item.id))
            .sort((a, b) => a.id - b.id);
          for (const item of fresh) {
            seen.current.add(item.id);
            show(item);
          }
          lastId.current = Math.max(lastId.current, newest);
        }
      } catch {
        // Сервер недоступен — попробуем на следующем шаге.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [toast]);
}
