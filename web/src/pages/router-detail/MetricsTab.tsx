import {
  Button,
  Empty,
  ErrorBanner,
  LatencyChart,
  Panel,
  Select,
  Spinner,
  StatusBadge,
} from '../../components/ui';
import { formatDate, formatRelative, proxyHealth } from '../../lib/format';
import type { ConnectionsResponse, MetricSample, MetricsResponse } from '../../lib/types';
import type { ApiState } from '../../lib/useApi';

export function MetricsTab(props: {
  hours: number;
  onHoursChange: (hours: number) => void;
  metrics: ApiState<MetricsResponse>;
  connectionLosses: ApiState<ConnectionsResponse>;
  chartPoints: Array<{ x: number; y: number | null }>;
  latest: MetricSample | null;
}) {
  const { metrics, connectionLosses, latest } = props;
  return (
    <div className="stack">
      <Panel
        title="Задержка прокси"
        subtitle="Прокси-здоровье измеряется отдельно от доступности роутера."
        actions={
          <div className="toolbar">
            <Select value={String(props.hours)} onChange={(value) => props.onHoursChange(Number(value))}>
              <option value="6">6 часов</option>
              <option value="24">24 часа</option>
              <option value="72">3 суток</option>
              <option value="168">7 суток</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => void metrics.reload()} busy={metrics.loading}>
              Обновить
            </Button>
          </div>
        }
      >
        {metrics.error ? <ErrorBanner message={metrics.error} onRetry={() => void metrics.reload()} /> : null}
        {metrics.loading && !metrics.data ? <Spinner /> : <LatencyChart points={props.chartPoints} />}
        {latest ? (
          <p className="muted-text small">
            Последний замер: {formatDate(latest.ts)} · прокси {proxyHealth(latest.proxy_health)} ·
            живых соединений: {latest.total_tags !== null && latest.failed_tags !== null
              ? `${latest.total_tags - latest.failed_tags}/${latest.total_tags}`
              : '—'}
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Нестабильные соединения"
        subtitle="Соединения, которые чаще всего не отвечали. Группа остаётся рабочей, если есть живые резервные соединения."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void connectionLosses.reload()}
            busy={connectionLosses.loading}
          >
            Обновить
          </Button>
        }
      >
        {connectionLosses.error ? (
          <ErrorBanner
            message={connectionLosses.error}
            onRetry={() => void connectionLosses.reload()}
          />
        ) : null}
        {connectionLosses.loading && !connectionLosses.data ? (
          <Spinner />
        ) : (connectionLosses.data?.items.length ?? 0) === 0 ? (
          <Empty>За выбранный период потерь связи не было.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Соединение</th>
                  <th>Потерь связи</th>
                  <th>Неудачных проверок</th>
                  <th>Последняя потеря</th>
                  <th>Сейчас</th>
                </tr>
              </thead>
              <tbody>
                {connectionLosses.data!.items.map((item) => (
                  <tr key={item.tag}>
                    <td>
                      <code>{item.tag}</code>
                    </td>
                    <td>
                      <strong>{item.losses}</strong>
                    </td>
                    <td className="muted-text small">
                      {item.failed_samples} из {item.total_samples}
                    </td>
                    <td className="muted-text small">
                      {item.last_failure ? formatRelative(item.last_failure) : '—'}
                    </td>
                    <td>
                      {item.down_now ? (
                        <StatusBadge status="warning" label="не отвечает" />
                      ) : (
                        <StatusBadge status="success" label="отвечает" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted-text small">
          Потерей считается эпизод, когда соединение перестало отвечать и затем
          восстановилось. Показаны 10 самых нестабильных соединений за выбранный период.
        </p>
      </Panel>
    </div>
  );
}
