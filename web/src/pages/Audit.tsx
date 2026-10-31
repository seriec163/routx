import { useMemo, useState } from 'react';
import { Link } from '../components/link';
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
  StatusBadge,
  TextInput,
} from '../components/ui';
import { formatDate } from '../lib/format';
import type { AuditRow, RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';

const PAGE_SIZE = 100;

const RESULT_LABEL: Record<string, string> = {
  ok: 'успешно',
  denied: 'запрещено',
  error: 'ошибка',
};

export function AuditPage() {
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [routerId, setRouterId] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AuditRow | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (action.trim()) params.set('action', action.trim());
    if (result) params.set('result', result);
    if (routerId) params.set('router_id', routerId);
    return params.toString();
  }, [action, result, routerId, offset]);

  const audit = useApi<{ items: AuditRow[]; limit: number; offset: number }>(
    `/api/v1/audit?${query}`,
  );
  const routers = useApi<{ items: RouterRecord[] }>('/api/v1/routers?limit=200');

  const routerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const router of routers.data?.items ?? []) map.set(router.id, router.name);
    return map;
  }, [routers.data]);

  function resetFilters(): void {
    setAction('');
    setResult('');
    setRouterId('');
    setOffset(0);
  }

  const items = audit.data?.items ?? [];
  const canPrev = offset > 0;
  const canNext = items.length === PAGE_SIZE;

  return (
    <div className="page">
      <PageHeader
        title="Журнал аудита"
        subtitle="Действия пользователей, задания и изменения настроек. Секреты и значения конфигурации в журнал не попадают."
        actions={
          <>
            <a className="btn btn-ghost" href="/api/v1/audit/export.csv">
              Экспорт CSV
            </a>
            <Button variant="ghost" onClick={() => void audit.reload()} busy={audit.loading}>
              Обновить
            </Button>
          </>
        }
      />

      {audit.error ? <ErrorBanner message={audit.error} onRetry={() => void audit.reload()} /> : null}

      <Panel
        title="Фильтры"
        actions={
          <Button variant="subtle" size="sm" onClick={resetFilters}>
            Сбросить
          </Button>
        }
      >
        <div className="grid-3 grid-3-compact">
          <Field label="Действие" hint="Префикс, например auth. или router.">
            <TextInput
              value={action}
              onChange={(value) => {
                setAction(value);
                setOffset(0);
              }}
              placeholder="settings."
              type="search"
            />
          </Field>
          <Field label="Результат">
            <Select
              value={result}
              onChange={(value) => {
                setResult(value);
                setOffset(0);
              }}
            >
              <option value="">Любой</option>
              <option value="ok">Успешно</option>
              <option value="denied">Запрещено</option>
              <option value="error">Ошибка</option>
            </Select>
          </Field>
          <Field label="Роутер">
            <Select
              value={routerId}
              onChange={(value) => {
                setRouterId(value);
                setOffset(0);
              }}
            >
              <option value="">Все роутеры</option>
              {(routers.data?.items ?? []).map((router) => (
                <option key={router.id} value={router.id}>
                  {router.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Panel>

      <Panel
        title="События"
        subtitle={`Показаны записи ${offset + 1}–${offset + items.length}`}
      >
        {audit.loading && !audit.data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty>Записей нет. Измените фильтры или выполните действие в панели.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Пользователь</th>
                    <th>Действие</th>
                    <th>Цель</th>
                    <th>Роутер</th>
                    <th>Результат</th>
                    <th>IP</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      <td className="small">{formatDate(row.at)}</td>
                      <td className="small">
                        {row.actor_email ?? (row.actor_id ? row.actor_id.slice(0, 8) : 'система')}
                        {row.actor_role ? <div className="muted-text small">{row.actor_role}</div> : null}
                      </td>
                      <td className="mono small">{row.action}</td>
                      <td className="small">
                        {row.target_type ?? '—'}
                        {row.target_id ? (
                          <div className="muted-text small">{row.target_id.slice(0, 12)}…</div>
                        ) : null}
                      </td>
                      <td className="small">
                        {row.router_id ? (
                          <Link to={`/routers/${row.router_id}`}>
                            {routerNames.get(row.router_id) ?? row.router_id.slice(0, 8)}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <StatusBadge
                          status={row.result}
                          label={RESULT_LABEL[row.result] ?? row.result}
                        />
                        {row.code ? <div className="muted-text small">{row.code}</div> : null}
                      </td>
                      <td className="mono small">{row.ip ?? '—'}</td>
                      <td>
                        <Button variant="ghost" size="sm" onClick={() => setSelected(row)}>
                          Детали
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="toolbar toolbar-end">
              <Button
                variant="ghost"
                size="sm"
                disabled={!canPrev}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Назад
              </Button>
              <span className="muted-text small">Смещение: {offset}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canNext}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Вперёд
              </Button>
            </div>
          </>
        )}
      </Panel>

      {selected ? (
        <Modal
          title={selected.action}
          wide
          onClose={() => setSelected(null)}
          footer={<Button onClick={() => setSelected(null)}>Закрыть</Button>}
        >
          <div className="kv">
            <span>Время</span>
            <strong>{formatDate(selected.at)}</strong>
            <span>Пользователь</span>
            <strong>{selected.actor_email ?? selected.actor_id ?? 'система'}</strong>
            <span>Роль</span>
            <strong>{selected.actor_role ?? '—'}</strong>
            <span>Результат</span>
            <strong>{RESULT_LABEL[selected.result] ?? selected.result}</strong>
            <span>Код</span>
            <strong>{selected.code ?? '—'}</strong>
            <span>Цель</span>
            <strong>
              {selected.target_type ?? '—'} {selected.target_id ?? ''}
            </strong>
            <span>Роутер</span>
            <strong>
              {selected.router_id
                ? routerNames.get(selected.router_id) ?? selected.router_id
                : '—'}
            </strong>
            <span>IP</span>
            <strong className="mono">{selected.ip ?? '—'}</strong>
          </div>
          <h3>Метаданные</h3>
          {selected.metadata ? (
            <pre className="code-block small">{JSON.stringify(selected.metadata, null, 2)}</pre>
          ) : (
            <Empty>Метаданные отсутствуют.</Empty>
          )}
          <p className="muted-text small">
            Журнал не содержит секретов: пароли, токены, ключи и URL подписок не записываются.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
