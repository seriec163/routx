import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../components/ui';
import {
  disablePush,
  enablePush,
  getPushStatus,
  sendTestPush,
  type PushStatus,
} from './push';

interface NotificationItem {
  id: string;
  router_id: string | null;
  router_name: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  created_at: string;
  read_at: string | null;
}

interface NotificationsResponse {
  items: NotificationItem[];
  unread: number;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Колокольчик в шапке и история уведомлений в мобильном листе.
 * Здесь же включается Web Push для установленного PWA.
 */
export function NotificationsHub() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api<NotificationsResponse>('/api/v1/notifications?limit=100');
      setItems(data.items);
      setUnread(data.unread);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPush = useCallback(async (): Promise<void> => {
    try {
      setPush(await getPushStatus());
    } catch {
      setPush(null);
    }
  }, []);

  // Счётчик непрочитанных обновляется и при закрытом листе.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void load();
    void loadPush();
  }, [open, load, loadPush]);

  async function markAll(): Promise<void> {
    try {
      await api('/api/v1/notifications/read', { method: 'POST', body: { all: true } });
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => ({ ...item, read_at: item.read_at ?? now })));
      setUnread(0);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function markOne(item: NotificationItem): Promise<void> {
    if (item.read_at) return;
    setItems((current) =>
      current.map((row) =>
        row.id === item.id ? { ...row, read_at: new Date().toISOString() } : row,
      ),
    );
    setUnread((value) => Math.max(0, value - 1));
    try {
      await api('/api/v1/notifications/read', { method: 'POST', body: { ids: [item.id] } });
    } catch (caught) {
      toast.error(errorMessage(caught));
      void load();
    }
  }

  async function remove(item: NotificationItem): Promise<void> {
    try {
      await api(`/api/v1/notifications/${item.id}`, { method: 'DELETE' });
      setItems((current) => current.filter((row) => row.id !== item.id));
      if (!item.read_at) setUnread((value) => Math.max(0, value - 1));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function togglePush(): Promise<void> {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (push?.subscribed) {
        await disablePush();
        toast.info('Push-уведомления отключены');
      } else {
        await enablePush();
        toast.success('Push-уведомления включены');
      }
      await loadPush();
    } catch (caught) {
      toast.error(errorMessage(caught));
      await loadPush();
    } finally {
      setPushBusy(false);
    }
  }

  async function testPush(): Promise<void> {
    if (testBusy) return;
    setTestBusy(true);
    try {
      await sendTestPush();
      toast.success('Тестовое уведомление отправлено');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="m-iconbtn m-bell"
        aria-label={unread > 0 ? `Уведомления, непрочитанных: ${unread}` : 'Уведомления'}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z" />
          <path d="M10 21h4" />
        </svg>
        {unread > 0 ? <span className="m-bell-badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <div className="m-overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div
            className="m-sheet m-sheet-tall"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="m-sheet-grip" />
            <div className="m-sheet-head">
              <h2 className="m-sheet-title">Уведомления</h2>
              {unread > 0 ? (
                <button type="button" className="m-mini" onClick={() => void markAll()}>
                  Прочитать все
                </button>
              ) : null}
            </div>

            {push ? (
              <div className="m-pushbox">
                <div className="m-pushbox-text">
                  <strong>
                    {push.subscribed
                      ? 'Push включён'
                      : push.supported
                        ? 'Push-уведомления'
                        : 'Push не поддерживается'}
                  </strong>
                  <span>
                    {push.subscribed
                      ? 'События придут, даже когда приложение закрыто.'
                      : !push.enabled
                        ? 'На сервере не настроены ключи push. История ниже работает.'
                        : !push.supported
                          ? 'Этот браузер не умеет push. История ниже работает.'
                          : 'Включите, чтобы получать события при закрытом приложении.'}
                  </span>
                  {push.supported && push.enabled && !isStandalone() ? (
                    <span className="m-pushbox-hint">
                      На iPhone push работает только из установленного приложения.
                    </span>
                  ) : null}
                </div>
                {push.supported && push.enabled ? (
                  <button
                    type="button"
                    className="m-mini"
                    onClick={() => void togglePush()}
                    disabled={pushBusy || push.permission === 'denied'}
                  >
                    {pushBusy ? '…' : push.subscribed ? 'Отключить' : 'Включить'}
                  </button>
                ) : null}
                {push.subscribed ? (
                  <button
                    type="button"
                    className="m-mini"
                    onClick={() => void testPush()}
                    disabled={testBusy}
                  >
                    {testBusy ? '…' : 'Проверить'}
                  </button>
                ) : null}
                {push.permission === 'denied' ? (
                  <span className="m-pushbox-hint">
                    Уведомления запрещены в настройках браузера для этого сайта.
                  </span>
                ) : null}
              </div>
            ) : null}

            {error ? <p className="m-note m-note-warn">{error}</p> : null}

            {loading && items.length === 0 ? (
              <p className="m-note">Загружаем…</p>
            ) : items.length === 0 ? (
              <p className="m-note">Пока нет уведомлений.</p>
            ) : (
              <div className="m-notiflist">
                {items.map((item) => (
                  <div
                    className={`m-notifrow ${item.read_at ? '' : 'm-notif-unread'}`}
                    key={item.id}
                  >
                    <span
                      className={`m-dot m-dot-${item.severity === 'critical' ? 'bad' : item.severity === 'warning' ? 'warn' : 'ok'}`}
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      className="m-notif-main"
                      onClick={() => void markOne(item)}
                    >
                      <span className="m-notif-message">{item.message}</span>
                      <span className="m-notif-meta">
                        {item.router_name ? `${item.router_name} · ` : ''}
                        {formatWhen(item.created_at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="m-mini m-mini-danger"
                      aria-label="Удалить уведомление"
                      onClick={() => void remove(item)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <p className="m-footnote">
              Нажмите на уведомление, чтобы отметить прочитанным. Старые записи удаляются
              автоматически по сроку хранения.
            </p>
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => setOpen(false)}
            >
              Закрыть
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
