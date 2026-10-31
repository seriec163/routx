import { useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  StatusBadge,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { DiagnosticReportView, nativeTextOf, translateNativeReport } from '../components/diagnostics';
import { formatBytes, formatDate, PRODUCT_LABEL } from '../lib/format';
import { navigate } from '../lib/router';
import type { DiagnosticReportDetail, DiagnosticReportSummary, Job, RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';

export function DiagnosticsPage() {
  const toast = useToast();
  const reports = useApi<{ items: DiagnosticReportSummary[] }>('/api/v1/diagnostics?limit=50');
  const routers = useApi<{ items: RouterRecord[] }>('/api/v1/routers?limit=200');
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'quick' | 'full'>('quick');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id].slice(0, 10),
    );
  }

  async function request(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ batch_id: string; jobs: Job[] }>('/api/v1/diagnostics', {
        method: 'POST',
        body: { router_ids: selected, kind },
      });
      toast.success(`Диагностика запущена: ${result.jobs.length} задач`);
      setOpen(false);
      setSelected([]);
      await reports.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const online = (routers.data?.items ?? []).filter(
    (router) => router.status === 'online' && !router.archived_at,
  );

  return (
    <div className="page">
      <PageHeader
        title="Диагностика"
        subtitle="Быстрая и полная нативная диагностика. Отчёты маскируются: секреты не собираются и не выгружаются."
        actions={<Button onClick={() => setOpen(true)}>Запустить диагностику</Button>}
      />

      {reports.error ? <ErrorBanner message={reports.error} onRetry={() => void reports.reload()} /> : null}

      <Panel
        title="Отчёты"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void reports.reload()} busy={reports.loading}>
            Обновить
          </Button>
        }
      >
        {reports.loading && !reports.data ? (
          <Spinner />
        ) : (reports.data?.items.length ?? 0) === 0 ? (
          <Empty>Отчётов пока нет. Запустите диагностику на подключённом роутере.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Создан</th>
                  <th>Роутер</th>
                  <th>Тип</th>
                  <th>Продукт</th>
                  <th>Размер</th>
                  <th>Истекает</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {reports.data!.items.map((report) => (
                  <tr key={report.id}>
                    <td className="small">{formatDate(report.created_at)}</td>
                    <td>
                      <Link to={`/routers/${report.router_id}`}>{report.router_name ?? report.router_id.slice(0, 8)}</Link>
                    </td>
                    <td>
                      <StatusBadge
                        status={report.kind === 'full' ? 'warning' : 'success'}
                        label={report.kind === 'full' ? 'Полная' : 'Быстрая'}
                      />
                    </td>
                    <td>{PRODUCT_LABEL[report.product] ?? report.product}</td>
                    <td>{formatBytes(report.size_bytes)}</td>
                    <td className="muted-text small">{formatDate(report.expires_at)}</td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" to={`/diagnostics/${report.id}`}>
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

      {open ? (
        <Modal
          title="Запустить диагностику"
          wide
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button onClick={() => void request()} busy={busy} disabled={selected.length === 0}>
                Запустить ({selected.length})
              </Button>
            </>
          }
        >
          {error ? <ErrorBanner message={error} /> : null}
          <Field label="Тип диагностики">
            <Select value={kind} onChange={(value) => setKind(value as 'quick' | 'full')}>
              <option value="quick">Быстрая — служба, конфигурация, связность</option>
              <option value="full">Полная — расширенные проверки (дольше)</option>
            </Select>
          </Field>
          <p className="page-sub">Выберите до 10 роутеров, находящихся в сети.</p>
          {online.length === 0 ? (
            <Empty>Нет роутеров в сети.</Empty>
          ) : (
            <div className="checklist">
              {online.map((router) => (
                <label key={router.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(router.id)}
                    onChange={() => toggle(router.id)}
                  />
                  <span>{router.name}</span>
                  <span className="muted-text small">{router.product}</span>
                </label>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}

export function DiagnosticDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const report = useApi<{ report: DiagnosticReportDetail }>(`/api/v1/diagnostics/${id}`);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'overview' | 'text' | 'json'>('overview');

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/diagnostics/${id}`, { method: 'DELETE' });
      toast.success('Отчёт удалён');
      navigate('/diagnostics');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (report.loading && !report.data) return <Spinner />;
  if (report.error && !report.data) {
    return <ErrorBanner message={report.error} onRetry={() => void report.reload()} />;
  }
  const data = report.data?.report;
  if (!data) return <Empty>Отчёт не найден.</Empty>;

  return (
    <div className="page">
      <PageHeader
        eyebrow={data.kind === 'full' ? 'Полная диагностика' : 'Быстрая диагностика'}
        title={data.router_name ?? 'Отчёт'}
        subtitle={`${formatDate(data.created_at)} · ${formatBytes(data.size_bytes)} · SHA-256 ${data.sha256.slice(0, 16)}…`}
        actions={
          <>
            <Link className="btn btn-ghost" to={`/routers/${data.router_id}`}>
              К роутеру
            </Link>
            <a className="btn btn-ghost" href={`/api/v1/diagnostics/${data.id}/download`}>
              Скачать
            </a>
            <Button variant="subtle" onClick={() => setDeleting(true)}>
              Удалить
            </Button>
          </>
        }
      />

      <Panel
        title="Результат проверки"
        actions={
          <div className="segmented">
            <button
              type="button"
              className={view === 'overview' ? 'seg-active' : ''}
              onClick={() => setView('overview')}
            >
              Обзор
            </button>
            <button type="button" className={view === 'text' ? 'seg-active' : ''} onClick={() => setView('text')}>
              Текст
            </button>
            <button type="button" className={view === 'json' ? 'seg-active' : ''} onClick={() => setView('json')}>
              JSON
            </button>
          </div>
        }
      >
        {view === 'overview' ? <DiagnosticReportView report={data} /> : null}
        {view === 'text' ? (
          <pre className="code-block report">
            {translateNativeReport(
              nativeTextOf(data) ?? data.text ?? JSON.stringify(data.payload, null, 2),
            )}
          </pre>
        ) : null}
        {view === 'json' ? (
          <pre className="code-block report">{JSON.stringify(data.payload, null, 2)}</pre>
        ) : null}
      </Panel>

      <Panel title="Важно">
        <ul className="bullets">
          <li>Отчёты маскируются: значения секретов заменяются маркерами.</li>
          <li>Срок хранения ограничен; после истечения отчёт недоступен.</li>
          <li>Если проверка недоступна на данном продукте, отчёт явно сообщает об этом.</li>
        </ul>
      </Panel>

      {deleting ? (
        <ConfirmDialog
          title="Удалить отчёт?"
          danger
          busy={busy}
          confirmLabel="Удалить"
          onCancel={() => setDeleting(false)}
          onConfirm={() => void remove()}
          message={<p>Отчёт будет удалён без возможности восстановления.</p>}
        />
      ) : null}
    </div>
  );
}
