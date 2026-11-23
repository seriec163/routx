import { Button, Empty, Panel, Spinner, StatusBadge } from '../../components/ui';
import { formatDate, JOB_STATUS, JOB_TYPE } from '../../lib/format';
import type { Job } from '../../lib/types';
import type { ApiState } from '../../lib/useApi';

export function JobsTab({ jobs }: { jobs: ApiState<{ items: Job[] }> }) {
  return (
    <Panel
      title="История задач"
      actions={
        <Button size="sm" variant="ghost" onClick={() => void jobs.reload()} busy={jobs.loading}>
          Обновить
        </Button>
      }
    >
      {jobs.loading && !jobs.data ? (
        <Spinner />
      ) : (jobs.data?.items.length ?? 0) === 0 ? (
        <Empty>Задач пока нет.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Создана</th>
              <th>Тип</th>
              <th>Статус</th>
              <th>Длительность</th>
              <th>Ошибка</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data!.items.map((job) => (
              <tr key={job.id}>
                <td className="small">{formatDate(job.created_at)}</td>
                <td>{JOB_TYPE[job.type] ?? job.type}</td>
                <td>
                  <StatusBadge status={job.status} label={JOB_STATUS[job.status] ?? job.status} />
                </td>
                <td className="muted-text small">
                  {job.started_at && job.finished_at
                    ? `${Math.max(
                        0,
                        Math.round(
                          (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000,
                        ),
                      )} с`
                    : '—'}
                </td>
                <td className="small">{job.error?.message ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
