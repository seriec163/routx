import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Empty,
  ErrorBanner,
  JobProgress,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  StatusBadge,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatRelative, JOB_STATUS, JOB_TYPE } from '../lib/format';
import type { Job, RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';

export function JobsPage() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  if (type) query.set('type', type);
  const jobs = useApi<{ items: Job[] }>(`/api/v1/jobs?${query.toString()}`);
  const routers = useApi<{ items: RouterRecord[] }>('/api/v1/routers?limit=200');
  const [selected, setSelected] = useState<Job | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const router of routers.data?.items ?? []) map.set(router.id, router.name);
    return map;
  }, [routers.data]);

  const hasActive = (jobs.data?.items ?? []).some(
    (job) => job.status === 'queued' || job.status === 'running',
  );

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void jobs.reload(), 2000);
    return () => window.clearInterval(timer);
  }, [hasActive, jobs.reload]);

  async function cancel(job: Job): Promise<void> {
    setBusyId(job.id);
    try {
      await api(`/api/v1/jobs/${job.id}/cancel`, { method: 'POST' });
      toast.success('Задача отменена');
      await jobs.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Очередь задач"
        subtitle="Все операции асинхронны. Статусы: в очереди, выполняется, успешно, ошибка, отменена, таймаут."
        actions={
          <Button variant="ghost" onClick={() => void jobs.reload()} busy={jobs.loading}>
            Обновить
          </Button>
        }
      />

      {jobs.error ? <ErrorBanner message={jobs.error} onRetry={() => void jobs.reload()} /> : null}

      <Panel
        title="Задачи"
        actions={
          <div className="toolbar">
            <Select value={status} onChange={(value) => setStatus(value)}>
              <option value="">Любой статус</option>
              {Object.entries(JOB_STATUS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Select value={type} onChange={(value) => setType(value)}>
              <option value="">Любой тип</option>
              {Object.entries(JOB_TYPE).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {jobs.loading && !jobs.data ? (
          <Spinner />
        ) : (jobs.data?.items.length ?? 0) === 0 ? (
          <Empty>Задач нет.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Создана</th>
                  <th>Тип</th>
                  <th>Роутер</th>
                  <th>Статус</th>
                  <th>Попытка</th>
                  <th>Длительность</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.data!.items.map((job) => (
                  <tr key={job.id}>
                    <td className="small">
                      <div>{formatDate(job.created_at)}</div>
                      <div className="muted-text">{formatRelative(job.created_at)}</div>
                    </td>
                    <td>{JOB_TYPE[job.type] ?? job.type}</td>
                    <td className="small">{job.router_id ? names.get(job.router_id) ?? job.router_id.slice(0, 8) : '—'}</td>
                    <td>
                      <StatusBadge status={job.status} label={JOB_STATUS[job.status] ?? job.status} />
                      {job.error ? <div className="muted-text small">{job.error.message}</div> : null}
                    </td>
                    <td className="small">
                      {job.attempt}/{job.max_attempts}
                    </td>
                    <td className="muted-text small">
                      {job.started_at && job.finished_at
                        ? `${Math.max(
                            0,
                            Math.round((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000),
                          )} с`
                        : '—'}
                    </td>
                    <td className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(job)}>
                        Детали
                      </Button>
                      {job.status === 'queued' || job.status === 'running' ? (
                        <Button
                          size="sm"
                          variant="subtle"
                          busy={busyId === job.id}
                          onClick={() => void cancel(job)}
                        >
                          Отменить
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected ? (
        <Modal title={`Задача ${selected.id.slice(0, 8)}`} wide onClose={() => setSelected(null)}>
          <JobProgress job={selected} />
          <div className="kv">
            <span>Тип</span>
            <strong>{JOB_TYPE[selected.type] ?? selected.type}</strong>
            <span>Статус</span>
            <strong>{JOB_STATUS[selected.status] ?? selected.status}</strong>
            <span>Роутер</span>
            <strong>{selected.router_id ? names.get(selected.router_id) ?? selected.router_id : '—'}</strong>
            <span>Создана</span>
            <strong>{formatDate(selected.created_at)}</strong>
            <span>Начата</span>
            <strong>{formatDate(selected.started_at)}</strong>
            <span>Завершена</span>
            <strong>{formatDate(selected.finished_at)}</strong>
            <span>Таймаут</span>
            <strong>{selected.timeout_seconds} с</strong>
          </div>
          {selected.error ? (
            <ErrorBanner message={`${selected.error.code}: ${selected.error.message}`} />
          ) : null}
          <h3>Payload</h3>
          <pre className="code-block small">{JSON.stringify(selected.payload, null, 2)}</pre>
          <h3>Результат</h3>
          <pre className="code-block small">{JSON.stringify(selected.result, null, 2)}</pre>
        </Modal>
      ) : null}
    </div>
  );
}
