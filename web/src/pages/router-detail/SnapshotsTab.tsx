import { Button, Empty, Panel, Spinner } from '../../components/ui';
import { formatBytes, formatDate } from '../../lib/format';
import type { RouterSnapshot } from '../../lib/types';
import type { ApiState } from '../../lib/useApi';

export function SnapshotsTab(props: {
  snapshots: ApiState<{ items: RouterSnapshot[] }>;
  busy: boolean;
  canMutate: boolean;
  onCreate: () => void;
  onRestore: (snapshot: RouterSnapshot) => void;
}) {
  const { snapshots } = props;
  return (
    <Panel
      title="Снимки конфигурации"
      subtitle="Локальные снимки RoutX и нативные снимки Prokop. Секреты не выгружаются на сервер."
      actions={
        <Button size="sm" onClick={props.onCreate} busy={props.busy} disabled={!props.canMutate}>
          Создать снимок
        </Button>
      }
    >
      {snapshots.loading && !snapshots.data ? (
        <Spinner />
      ) : (snapshots.data?.items.length ?? 0) === 0 ? (
        <Empty>Снимков пока нет.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Создан</th>
                <th>Тип</th>
                <th>Причина</th>
                <th>Размер</th>
                <th>SHA-256</th>
                <th>Истекает</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots.data!.items.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{formatDate(snapshot.created_at)}</td>
                  <td>{snapshot.kind === 'native' ? 'Prokop (нативный)' : 'RoutX (локальный)'}</td>
                  <td>{snapshot.reason}</td>
                  <td>{formatBytes(snapshot.size_bytes)}</td>
                  <td className="mono small">{snapshot.sha256?.slice(0, 16) ?? '—'}…</td>
                  <td className="muted-text small">{formatDate(snapshot.expires_at)}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!props.canMutate}
                      onClick={() => props.onRestore(snapshot)}
                    >
                      Восстановить
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
