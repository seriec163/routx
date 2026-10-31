import { Link } from '../components/link';
import { ErrorBanner, Empty, PageHeader, Panel, Spinner, Stat, StatusBadge } from '../components/ui';
import { formatRelative, JOB_STATUS, JOB_TYPE, ROUTER_STATUS } from '../lib/format';
import type { Job, MonitoringOverview, RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';
import { greetingName, useSession } from '../session';

export function DashboardPage() {
  const { me } = useSession();
  const overview = useApi<MonitoringOverview>('/api/v1/monitoring/overview');
  const jobs = useApi<{ items: Job[] }>('/api/v1/jobs?limit=8');
  const routers = useApi<{ items: RouterRecord[] }>('/api/v1/routers?limit=200');

  const names = new Map<string, string>();
  for (const router of routers.data?.items ?? []) names.set(router.id, router.name);
  for (const item of overview.data?.items ?? []) names.set(item.id, item.name);

  const summary = overview.data?.summary;
  const attention = (overview.data?.items ?? []).filter(
    (item) =>
      item.status !== 'online' ||
      item.proxy_health === 'dead' ||
      item.proxy_health === 'degraded' ||
      item.last_error,
  );

  if (overview.loading && !overview.data) return <Spinner />;

  const greeting = greetingName(me?.user);
  return (
    <div className="page">
      <PageHeader
        title={`Здравствуйте${greeting ? `, ${greeting}` : ''}`}
        subtitle="Сводка по парку роутеров, состоянию прокси и последним задачам."
        actions={
          <>
            <Link className="btn btn-ghost" to="/routers">
              Роутеры
            </Link>
            <Link className="btn btn-primary" to="/templates">
              Шаблоны
            </Link>
          </>
        }
      />

      {overview.error ? <ErrorBanner message={overview.error} onRetry={() => void overview.reload()} /> : null}

      <div className="stat-grid">
        <Stat label="Всего роутеров" value={summary?.total ?? 0} hint="Без архивных" />
        <Stat label="В сети" value={summary?.online ?? 0} tone="ok" hint="Отвечали за последние 3 минуты" />
        <Stat label="Не в сети" value={summary?.offline ?? 0} tone="bad" hint="Пропущено 3 опроса подряд" />
        <Stat label="Ожидают привязки" value={summary?.pending ?? 0} tone="warn" hint="Агент ещё не подключался" />
        <Stat
          label="Прокси в норме"
          value={summary?.proxy_healthy ?? 0}
          tone="ok"
          hint="Отдельно от доступности роутера"
        />
        <Stat
          label="Прокси деградировал"
          value={(summary?.proxy_degraded ?? 0) + (summary?.proxy_dead ?? 0)}
          tone="warn"
          hint="p95 > порога или есть мёртвые теги"
        />
      </div>

      <div className="grid-2">
        <Panel
          title="Требуют внимания"
          subtitle="Офлайн, конфликты, ошибки или проблемы с прокси"
          actions={
            <Link className="btn btn-ghost btn-sm" to="/monitoring">
              Мониторинг
            </Link>
          }
        >
          {overview.loading && !overview.data ? (
            <Spinner />
          ) : attention.length === 0 ? (
            <Empty>Проблем не обнаружено. Все роутеры в норме.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Роутер</th>
                  <th>Статус</th>
                  <th>Прокси</th>
                  <th>Последний контакт</th>
                </tr>
              </thead>
              <tbody>
                {attention.slice(0, 8).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link to={`/routers/${item.id}`}>{item.name}</Link>
                    </td>
                    <td>
                      <StatusBadge status={item.status} label={ROUTER_STATUS[item.status] ?? item.status} />
                    </td>
                    <td>
                      {item.proxy_health ? (
                        <StatusBadge
                          status={item.proxy_health}
                          label={
                            item.proxy_health === 'healthy'
                              ? 'В норме'
                              : item.proxy_health === 'degraded'
                                ? 'Деградация'
                                : 'Не работает'
                          }
                        />
                      ) : (
                        <span className="muted-text">нет данных</span>
                      )}
                    </td>
                    <td className="muted-text">{formatRelative(item.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Последние задачи"
          actions={
            <Link className="btn btn-ghost btn-sm" to="/jobs">
              Все задачи
            </Link>
          }
        >
          {jobs.loading && !jobs.data ? (
            <Spinner />
          ) : (jobs.data?.items.length ?? 0) === 0 ? (
            <Empty>Задач пока нет.</Empty>
          ) : (
            <ul className="feed">
              {jobs.data!.items.map((job) => (
                <li key={job.id}>
                  <div className="feed-main">
                    <span className="feed-title">{JOB_TYPE[job.type] ?? job.type}</span>
                    <span className="muted-text">
                      {job.router_id ? names.get(job.router_id) ?? 'роутер' : 'система'}
                    </span>
                  </div>
                  <div className="feed-side">
                    <StatusBadge status={job.status} label={JOB_STATUS[job.status] ?? job.status} />
                    <span className="muted-text">{formatRelative(job.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="С чего начать">
        <ol className="steps">
          <li>
            Создайте запись роутера на странице{' '}
            <Link to="/routers">«Роутеры»</Link> и выпустите токен привязки.
          </li>
          <li>
            Установите JanusNew на роутер командой из диалога привязки — роутер сам выйдет на сервер
            по TLS.
          </li>
          <li>
            Опишите желаемые параметры в <Link to="/templates">шаблоне</Link>, назначьте его роутеру
            и выполните сравнение.
          </li>
          <li>
            Проверьте diff, подтвердите применение. Перед записью автоматически создаётся снимок,
            при ошибке выполняется откат.
          </li>
        </ol>
      </Panel>
    </div>
  );
}
