import { useEffect, useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  Empty,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Stat,
  StatusBadge,
  Switch,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMs, formatRelative, proxyHealth, ROUTER_STATUS } from '../lib/format';
import type { MonitoringOverview } from '../lib/types';
import { useApi } from '../lib/useApi';

const HEALTH_LABEL: Record<string, string> = {
  ok: 'Норма',
  degraded: 'Деградация',
  failed: 'Ошибка',
  unknown: 'Неизвестно',
  running: 'Работает',
  stopped: 'Остановлен',
  'running but disabled': 'Работает, автозапуск выключен',
  'stopped & disabled': 'Остановлен и отключён',
};

export function MonitoringPage() {
  const toast = useToast();
  const overview = useApi<MonitoringOverview>('/api/v1/monitoring/overview');
  const [auto, setAuto] = useState(true);
  const [checking, setChecking] = useState(false);
  const [proxyFilter, setProxyFilter] = useState<'all' | 'healthy' | 'degraded' | 'dead'>('all');

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void overview.reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [auto, overview.reload]);

  async function checkNow(): Promise<void> {
    const online = (overview.data?.items ?? []).filter((item) => item.status === 'online');
    if (online.length === 0) {
      toast.info('Нет роутеров в сети');
      return;
    }
    setChecking(true);
    try {
      for (const item of online) {
        await api(`/api/v1/routers/${item.id}/monitor`, { method: 'POST' });
      }
      toast.info(`Проверка запущена: ${online.length} роутер(ов)`);
      window.setTimeout(() => void overview.reload(), 5000);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setChecking(false);
    }
  }

  const summary = overview.data?.summary;
  const items = (overview.data?.items ?? []).filter((item) =>
    proxyFilter === 'all' ? true : item.proxy_health === proxyFilter,
  );

  return (
    <div className="page">
      <PageHeader
        title="Мониторинг"
        subtitle="Раз в минуту: доступность роутера, состояние службы и реальная задержка прокси через Clash API. Прокси-здоровье считается отдельно от доступности."
        actions={
          <>
            <Button variant="ghost" onClick={() => void checkNow()} busy={checking}>
              Проверить сейчас
            </Button>
            <Button variant="ghost" onClick={() => void overview.reload()} busy={overview.loading}>
              Обновить
            </Button>
          </>
        }
      />

      {overview.error ? <ErrorBanner message={overview.error} onRetry={() => void overview.reload()} /> : null}

      <div className="stat-grid">
        <Stat label="Всего" value={summary?.total ?? 0} />
        <Stat label="В сети" value={summary?.online ?? 0} tone="ok" />
        <Stat label="Не в сети" value={summary?.offline ?? 0} tone="bad" />
        <Stat label="Прокси в норме" value={summary?.proxy_healthy ?? 0} tone="ok" />
        <Stat label="Деградация" value={summary?.proxy_degraded ?? 0} tone="warn" />
        <Stat label="Прокси мёртв" value={summary?.proxy_dead ?? 0} tone="bad" />
      </div>

      <Panel
        title="Состояние роутеров"
        actions={
          <div className="toolbar">
            <div className="segmented">
              {(['all', 'healthy', 'degraded', 'dead'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={proxyFilter === value ? 'seg-active' : ''}
                  onClick={() => setProxyFilter(value)}
                >
                  {value === 'all'
                    ? 'Все'
                    : value === 'healthy'
                      ? 'В норме'
                      : value === 'degraded'
                        ? 'Деградация'
                        : 'Мёртв'}
                </button>
              ))}
            </div>
            <Switch checked={auto} onChange={setAuto} label="Автообновление 30 с" />
          </div>
        }
      >
        {overview.loading && !overview.data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty>Нет роутеров в выбранном фильтре.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Роутер</th>
                  <th>Доступность</th>
                  <th>Служба</th>
                  <th>Прокси</th>
                  <th>Задержка</th>
                  <th>Теги</th>
                  <th>Последний замер</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link to={`/routers/${item.id}`}>{item.name}</Link>
                      <div className="muted-text small">
                        {item.product} {item.product_version ?? ''}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={item.status} label={ROUTER_STATUS[item.status] ?? item.status} />
                      {item.offline_since ? (
                        <div className="muted-text small">с {formatRelative(item.offline_since)}</div>
                      ) : null}
                    </td>
                    <td className="small">
                      {item.health ? HEALTH_LABEL[item.health] ?? item.health : '—'}
                      {item.service_state && item.service_state !== 'ok' ? (
                        <div className="muted-text small">
                          {HEALTH_LABEL[item.service_state] ?? item.service_state}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge
                        status={item.proxy_health ?? 'unknown'}
                        label={proxyHealth(item.proxy_health)}
                      />
                      {item.detail ? <div className="muted-text small">{item.detail}</div> : null}
                    </td>
                    <td>{formatMs(item.latency_ms)}</td>
                    <td className="small">
                      {item.total_tags !== null && item.failed_tags !== null
                        ? `${item.total_tags - item.failed_tags}/${item.total_tags}`
                        : '—'}
                    </td>
                    <td className="muted-text small">{formatRelative(item.ts)}</td>
                    <td className="small">{item.last_error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Как это работает">
        <ul className="bullets">
          <li>
            Раз в 60 секунд сервер просит агент проверить роутер. Кнопка «Проверить сейчас»
            запускает проверку немедленно.
          </li>
          <li>
            Доступность — отвечает ли агент. Роутер считается офлайн после 3 пропущенных проверок
            подряд (около 3 минут).
          </li>
          <li>
            Служба — состояние Prokop/Forkop из <code>get_health_status</code>: норма, деградация
            или ошибка.
          </li>
          <li>
            Прокси — реальные задержки через Clash API. Все теги ответили — «в норме», часть —
            «деградация», ни один — «мёртв». Если Clash API недоступен, показывается «нет данных»,
            а не ложное «мёртв».
          </li>
          <li>Задержка выше 1500 мс тоже считается деградацией.</li>
          <li>Метрики, отчёты и журналы хранятся не более 30 дней.</li>
        </ul>
      </Panel>
    </div>
  );
}
