import { useMemo, useState } from 'react';
import { DiffBadge, DiffView } from '../components/diff';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  PageHeader,
  Panel,
  Select,
  Spinner,
  StatusBadge,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { APPLY_STATUS, formatDate, formatRelative } from '../lib/format';
import type { ApplyItem, ApplyRun, ApplyRunDetail, DiffItem } from '../lib/types';
import { useApi } from '../lib/useApi';

function itemsToDiff(items: ApplyItem[]): DiffItem[] {
  return items.map((item) => ({
    op: item.op === 'add' ? 'add' : item.op === 'delete' ? 'delete' : 'change',
    path: item.path,
    before:
      item.value_before === null || item.value_before === undefined
        ? null
        : Array.isArray(item.value_before)
          ? item.value_before.map(String)
          : typeof item.value_before === 'string'
            ? item.value_before
            : JSON.stringify(item.value_before),
    after:
      item.value_after === null || item.value_after === undefined
        ? null
        : Array.isArray(item.value_after)
          ? item.value_after.map(String)
          : typeof item.value_after === 'string'
            ? item.value_after
            : JSON.stringify(item.value_after),
  }));
}

export function ApplyRunsPage() {
  const [status, setStatus] = useState('');
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  const runs = useApi<{ items: ApplyRun[] }>(`/api/v1/apply-runs?${query.toString()}`);

  return (
    <div className="page">
      <PageHeader
        title="Применения"
        subtitle="Каждое применение — это подтверждённый diff, снимок до записи и проверка после."
        actions={
          <Button variant="ghost" onClick={() => void runs.reload()} busy={runs.loading}>
            Обновить
          </Button>
        }
      />

      {runs.error ? <ErrorBanner message={runs.error} onRetry={() => void runs.reload()} /> : null}

      <Panel
        title="Журнал применений"
        actions={
          <Select value={status} onChange={setStatus}>
            <option value="">Все статусы</option>
            {Object.entries(APPLY_STATUS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        }
      >
        {runs.loading && !runs.data ? (
          <Spinner />
        ) : (runs.data?.items.length ?? 0) === 0 ? (
          <Empty>Применений ещё не было.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Создано</th>
                  <th>Роутер</th>
                  <th>Ревизия</th>
                  <th>Diff</th>
                  <th>Статус</th>
                  <th>Снимок</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data!.items.map((run) => (
                  <tr key={run.id}>
                    <td className="small">{formatDate(run.created_at)}</td>
                    <td>
                      <Link to={`/routers/${run.router_id}`}>{run.router_name ?? run.router_id.slice(0, 8)}</Link>
                    </td>
                    <td>{run.revision ?? '—'}</td>
                    <td>
                      <DiffBadge items={Array.isArray(run.diff) ? run.diff : []} />
                    </td>
                    <td>
                      <StatusBadge status={run.status} label={APPLY_STATUS[run.status] ?? run.status} />
                    </td>
                    <td className="small">
                      {run.backup_ok ? 'есть' : run.snapshot_ref ? run.snapshot_ref.slice(0, 12) : '—'}
                    </td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" to={`/apply-runs/${run.id}`}>
                        Открыть
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function ApplyRunDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const run = useApi<ApplyRunDetail>(`/api/v1/apply-runs/${id}`);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => itemsToDiff(run.data?.items ?? []), [run.data]);
  const applyRun = run.data?.apply_run;

  async function confirm(): Promise<void> {
    if (!applyRun) return;
    setBusy(true);
    try {
      await api(`/api/v1/apply-runs/${applyRun.id}/confirm`, {
        method: 'POST',
        body: { diff_hash: applyRun.diff_hash },
      });
      toast.success('Применение запущено');
      setConfirming(false);
      await run.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!applyRun) return;
    setBusy(true);
    try {
      await api(`/api/v1/apply-runs/${applyRun.id}/cancel`, { method: 'POST' });
      toast.success('Применение отменено');
      await run.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (run.loading && !run.data) return <Spinner />;
  if (run.error && !run.data) {
    return <ErrorBanner message={run.error} onRetry={() => void run.reload()} />;
  }
  if (!applyRun) return <Empty>Применение не найдено.</Empty>;

  const canConfirm = applyRun.status === 'awaiting_confirmation' && items.length > 0;
  const canCancel = applyRun.status === 'awaiting_confirmation' || applyRun.status === 'queued';

  return (
    <div className="page">
      <PageHeader
        eyebrow={`Diff ${applyRun.diff_hash.slice(0, 12)}…`}
        title={`Применение шаблона`}
        subtitle={`Роутер ${applyRun.router_name ?? applyRun.router_id} · ревизия ${applyRun.revision ?? '—'} · ${formatDate(applyRun.created_at)}`}
        actions={
          <>
            <Link className="btn btn-ghost" to={`/routers/${applyRun.router_id}`}>
              К роутеру
            </Link>
            {canCancel ? (
              <Button variant="subtle" onClick={() => void cancel()} busy={busy}>
                Отменить
              </Button>
            ) : null}
            {canConfirm ? (
              <Button onClick={() => setConfirming(true)} busy={busy}>
                Подтвердить и применить
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid-2">
        <Panel title="Параметры запуска">
          <div className="kv">
            <span>Статус</span>
            <strong>
              <StatusBadge status={applyRun.status} label={APPLY_STATUS[applyRun.status] ?? applyRun.status} />
            </strong>
            <span>Роутер</span>
            <strong>
              <Link to={`/routers/${applyRun.router_id}`}>{applyRun.router_name ?? applyRun.router_id}</Link>
            </strong>
            <span>Шаблон</span>
            <strong>{applyRun.template_id ? applyRun.template_id.slice(0, 8) : '—'}</strong>
            <span>Ревизия</span>
            <strong>{applyRun.revision ?? '—'}</strong>
            <span>Запросил</span>
            <strong>{applyRun.requested_by_email ?? applyRun.requested_by.slice(0, 8)}</strong>
            <span>Подтвердил</span>
            <strong>{applyRun.confirmed_at ? formatDate(applyRun.confirmed_at) : '—'}</strong>
            <span>Снимок</span>
            <strong>{applyRun.snapshot_ref ?? '—'}</strong>
            <span>Начато</span>
            <strong>{formatDate(applyRun.started_at)}</strong>
            <span>Завершено</span>
            <strong>{formatDate(applyRun.finished_at)}</strong>
          </div>
          {applyRun.error_code ? (
            <ErrorBanner message={`${applyRun.error_code}: ${applyRun.error_detail ?? ''}`} />
          ) : null}
          <p className="muted-text small">
            Создано {formatRelative(applyRun.created_at)} · базовый хеш состояния{' '}
            {applyRun.base_state_hash?.slice(0, 12) ?? '—'}…
          </p>
        </Panel>

        <Panel title="Итоги">
          <div className="stat-grid stat-grid-compact">
            <div className="stat">
              <p className="stat-label">Добавить</p>
              <p className="stat-value">{items.filter((item) => item.op === 'add').length}</p>
            </div>
            <div className="stat">
              <p className="stat-label">Изменить</p>
              <p className="stat-value">{items.filter((item) => item.op === 'change').length}</p>
            </div>
            <div className="stat">
              <p className="stat-label">Удалить</p>
              <p className="stat-value">{items.filter((item) => item.op === 'delete').length}</p>
            </div>
          </div>
          <p className="muted-text">
            {applyRun.backup_ok
              ? 'Снимок перед применением создан успешно.'
              : 'Снимок перед применением ещё не подтверждён.'}
          </p>
          {applyRun.status === 'awaiting_confirmation' && items.length === 0 ? (
            <Empty>Различий нет — подтверждение не требуется.</Empty>
          ) : null}
        </Panel>
      </div>

      <Panel title="Diff">
        <DiffView items={items} />
      </Panel>

      {applyRun.status !== 'awaiting_confirmation' && applyRun.status !== 'queued' ? (
        <Panel title="Результат по параметрам">
          {(run.data?.items.length ?? 0) === 0 ? (
            <Empty>Нет записей.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Операция</th>
                  <th>Путь</th>
                  <th>Результат</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {run.data!.items.map((item) => (
                  <tr key={item.seq}>
                    <td>{item.seq}</td>
                    <td>{item.op}</td>
                    <td className="mono small">{item.path}</td>
                    <td>
                      <StatusBadge status={item.result} label={item.result} />
                    </td>
                    <td className="small">{item.error_code ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Подтвердить применение?"
          busy={busy}
          confirmLabel="Применить"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirm()}
          message={
            <>
              <p>
                Будет записано {items.length} изменений. Перед записью создаётся снимок, после —
                проверка состояния; при ошибке выполняется безопасный откат.
              </p>
              <p className="muted-text">
                Хеш diff: <code>{applyRun.diff_hash}</code>. Если конфигурация изменится, сервер
                отклонит подтверждение.
              </p>
            </>
          }
        />
      ) : null}
    </div>
  );
}
