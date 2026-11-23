import { Button, Empty, Panel, Spinner, useToast } from '../../components/ui';
import { Link } from '../../components/link';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, formatDate, PRODUCT_LABEL } from '../../lib/format';
import type { DiagnosticReportSummary } from '../../lib/types';
import type { ApiState } from '../../lib/useApi';

export function DiagnosticsTab(props: {
  routerId: string;
  canMutate: boolean;
  diagnostics: ApiState<{ items: DiagnosticReportSummary[] }>;
}) {
  const toast = useToast();
  const { diagnostics } = props;

  async function run(kind: 'quick' | 'full'): Promise<void> {
    try {
      await api('/api/v1/diagnostics', {
        method: 'POST',
        body: { router_ids: [props.routerId], kind },
      });
      toast.info(kind === 'quick' ? 'Быстрая диагностика запущена' : 'Полная диагностика запущена');
      await diagnostics.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <Panel
      title="Диагностические отчёты"
      subtitle="Только маскированные отчёты. Полный отчёт включает больше проверок, но не секреты."
      actions={
        <div className="toolbar">
          <Button
            size="sm"
            variant="ghost"
            disabled={!props.canMutate}
            onClick={() => void run('quick')}
          >
            Быстрая
          </Button>
          <Button size="sm" disabled={!props.canMutate} onClick={() => void run('full')}>
            Полная
          </Button>
        </div>
      }
    >
      {diagnostics.loading && !diagnostics.data ? (
        <Spinner />
      ) : (diagnostics.data?.items.length ?? 0) === 0 ? (
        <Empty>Отчётов пока нет.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Создан</th>
              <th>Тип</th>
              <th>Продукт</th>
              <th>Размер</th>
              <th>Истекает</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {diagnostics.data!.items.map((report) => (
              <tr key={report.id}>
                <td>{formatDate(report.created_at)}</td>
                <td>{report.kind === 'full' ? 'Полная' : 'Быстрая'}</td>
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
      )}
    </Panel>
  );
}
