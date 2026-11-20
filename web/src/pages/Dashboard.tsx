import { Link } from '../components/link';
import { Empty, ErrorBanner, PageHeader, Panel, Spinner, StatusBadge } from '../components/ui';
import { formatRelative, JOB_STATUS, JOB_TYPE } from '../lib/format';
import type { Job, RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';
import { greetingName, useSession } from '../session';

/**
 * Панель — короткая точка входа. Подробное состояние парка и мониторинг
 * живут на странице «Роутеры и мониторинг», чтобы не дублировать карточки
 * и таблицу «Требуют внимания».
 */
export function DashboardPage() {
  const { me } = useSession();
  const jobs = useApi<{ items: Job[] }>('/api/v1/jobs?limit=50');
  const routers = useApi<{ items: RouterRecord[] }>('/api/v1/routers?limit=200');

  const names = new Map<string, string>();
  for (const router of routers.data?.items ?? []) names.set(router.id, router.name);

  // Рутинный мониторинг не должен забивать ленту: показываем действия,
  // которые пользователь действительно запускал.
  const routine = new Set(['monitor', 'reconcile', 'read_rules', 'retention']);
  const recentJobs = (jobs.data?.items ?? [])
    .filter((job) => !routine.has(job.type))
    .slice(0, 8);

  const greeting = greetingName(me?.user);
  return (
    <div className="page">
      <PageHeader
        title={`Здравствуйте${greeting ? `, ${greeting}` : ''}`}
        subtitle="Коротко: что происходит в системе и с чего продолжить. Состояние парка и мониторинг — на странице «Роутеры»."
        actions={
          <>
            <Link className="btn btn-ghost" to="/routers?filter=attention">
              Проблемные роутеры
            </Link>
            <Link className="btn btn-ghost" to="/routers">
              Роутеры
            </Link>
            <Link className="btn btn-primary" to="/routers/new">
              Добавить роутер
            </Link>
          </>
        }
      />

      {jobs.error ? <ErrorBanner message={jobs.error} onRetry={() => void jobs.reload()} /> : null}

      <div className="grid-2">
        <Panel
          title="Последние задачи"
          subtitle="Очередь и история применений, диагностики и обновлений."
          actions={
            <Link className="btn btn-ghost btn-sm" to="/jobs">
              Все задачи
            </Link>
          }
        >
          {jobs.loading && !jobs.data ? (
            <Spinner />
          ) : recentJobs.length === 0 ? (
            <Empty>Задач пока нет.</Empty>
          ) : (
            <ul className="feed">
              {recentJobs.map((job) => (
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

        <Panel title="Быстрый старт" subtitle="Четыре шага от нового роутера до рабочего правила.">
          <ol className="steps">
            <li>
              Добавьте роутер на странице <Link to="/routers">«Роутеры»</Link> и выпустите токен
              привязки.
            </li>
            <li>
              Установите RoutX командой из диалога привязки — роутер сам выйдет на сервер по
              TLS.
            </li>
            <li>
              Откройте роутер → <strong>«Правила и подключения»</strong>, создайте правило:
              действие, ресурсы, подписка или VLESS.
            </li>
            <li>
              Проверьте diff и подтвердите. Снимок и откат создаются автоматически; шаблон можно
              применить к правилу из формы.
            </li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}
