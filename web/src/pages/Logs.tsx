import { useState } from 'react';
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { useApi } from '../lib/useApi';

interface RouterItem {
  id: string;
  name: string;
}

interface LogItem {
  id: string;
  router_id: string;
  router_name: string;
  source: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  context: unknown;
  created_at: string;
}

interface LogList {
  items: LogItem[];
}

export function LogsPage() {
  const toast = useToast();
  const [routerId, setRouterId] = useState('');
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<LogItem | null>(null);
  const [collecting, setCollecting] = useState(false);

  const routers = useApi<{ items: RouterItem[] }>(
    '/api/v1/routers?include_archived=false&scope=branch',
  );

  const params = new URLSearchParams();
  if (routerId) params.set('router_id', routerId);
  if (level) params.set('level', level);
  if (source.trim()) params.set('source', source.trim());
  const path = `/api/v1/router-logs?${params.toString()}`;
  const logs = useApi<LogList>(path);

  async function collect(): Promise<void> {
    if (!routerId) {
      toast.error('Выберите роутер');
      return;
    }
    setCollecting(true);
    try {
      await api('/api/v1/diagnostics', {
        method: 'POST',
        body: { router_ids: [routerId], kind: 'full' },
      });
      toast.success('Полная диагностика запущена. Обновите список через минуту.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setCollecting(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Обслуживание"
        title="Логи и ошибки"
        subtitle="Логи Tachyon и sing-box, ошибки задач и автоматическая диагностика при сбоях. Хранятся 30 дней."
      />

      <Panel title="Фильтры">
        <div className="grid-2">
          <Field label="Роутер">
            <Select value={routerId} onChange={setRouterId}>
              <option value="">Все доступные роутеры</option>
              {(routers.data?.items ?? []).map((router) => (
                <option key={router.id} value={router.id}>
                  {router.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Уровень">
            <Select value={level} onChange={setLevel}>
              <option value="">Все уровни</option>
              <option value="error">Ошибки</option>
              <option value="warn">Предупреждения</option>
              <option value="info">Информация</option>
            </Select>
          </Field>
          <Field label="Источник" hint="Например, tachyon_logs, sing_box_logs или job.">
            <TextInput value={source} onChange={setSource} placeholder="tachyon_logs" />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <Button variant="ghost" onClick={() => void logs.reload()} busy={logs.loading}>
              Обновить
            </Button>
            <Button variant="subtle" onClick={() => void collect()} busy={collecting} disabled={!routerId}>
              Собрать полную диагностику
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Журнал" subtitle="Свежие записи сверху. Нажмите «Открыть», чтобы увидеть полный текст.">
        {logs.error ? <ErrorBanner message={logs.error} onRetry={() => void logs.reload()} /> : null}
        {logs.loading && !logs.data ? <Spinner label="Читаем журнал…" /> : null}
        {logs.data && logs.data.items.length === 0 ? (
          <Empty>Записей пока нет. Они появятся после диагностики или ошибки задачи.</Empty>
        ) : null}
        {logs.data && logs.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Роутер</th>
                  <th>Источник</th>
                  <th>Уровень</th>
                  <th>Сообщение</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {logs.data.items.map((item) => (
                  <tr key={item.id}>
                    <td className="small">{formatDate(item.created_at)}</td>
                    <td>{item.router_name}</td>
                    <td className="small">{item.source}</td>
                    <td>
                      <span
                        className={`badge badge-${
                          item.level === 'error' ? 'bad' : item.level === 'warn' ? 'warn' : 'muted'
                        }`}
                      >
                        {item.level}
                      </span>
                    </td>
                    <td className="small">{item.message.slice(0, 180)}</td>
                    <td className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(item)}>
                        Открыть
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      {selected ? (
        <Modal
          wide
          title={`${selected.router_name} · ${selected.source}`}
          onClose={() => setSelected(null)}
          footer={
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Закрыть
            </Button>
          }
        >
          <p className="muted-text small">
            {formatDate(selected.created_at)} · уровень {selected.level}
          </p>
          <pre className="code-block" style={{ maxHeight: 480, overflow: 'auto' }}>
            {selected.message}
          </pre>
        </Modal>
      ) : null}
    </div>
  );
}
