import { useMemo, useState } from 'react';
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
  Spinner,
  StatusBadge,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatDate, formatRelative, PRODUCT_LABEL, ROUTER_STATUS } from '../lib/format';
import { navigate } from '../lib/router';
import type { BindingToken, RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

export function RoutersPage() {
  const { me } = useSession();
  const toast = useToast();
  const isAdmin = me?.permissions.is_superadmin === true;
  const routers = useApi<{ items: RouterRecord[] }>('/api/v1/routers?limit=200&include_archived=true');

  const [view, setView] = useState<'active' | 'pending' | 'archive'>('active');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState<RouterRecord | null>(null);
  const [binding, setBinding] = useState<{ router: RouterRecord; token: BindingToken } | null>(null);
  const [purging, setPurging] = useState<RouterRecord | null>(null);
  const [purgeName, setPurgeName] = useState('');

  const allItems = routers.data?.items ?? [];
  const isDraft = (item: RouterRecord) =>
    !item.archived_at && item.status === 'pending' && !item.last_seen_at;
  const pendingItems = allItems.filter(isDraft);
  const activeItems = allItems.filter((item) => !item.archived_at && !isDraft(item));
  const archivedItems = allItems.filter((item) => item.archived_at);

  const filtered = useMemo(() => {
    const items =
      view === 'active' ? activeItems : view === 'pending' ? pendingItems : archivedItems;
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.product.toLowerCase().includes(needle) ||
        (item.model ?? '').toLowerCase().includes(needle),
    );
  }, [activeItems, pendingItems, archivedItems, view, query]);

  async function archive(): Promise<void> {
    if (!archiving) return;
    setBusy(true);
    try {
      await api(`/api/v1/routers/${archiving.id}`, { method: 'DELETE' });
      toast.success('Роутер перемещён в архив');
      setArchiving(null);
      await routers.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restore(router: RouterRecord): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/routers/${router.id}/restore`, { method: 'POST' });
      toast.success('Роутер восстановлен из архива');
      await routers.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function purge(): Promise<void> {
    if (!purging || purgeName.trim() !== purging.name) return;
    setBusy(true);
    try {
      await api(`/api/v1/routers/${purging.id}?purge=true`, { method: 'DELETE' });
      toast.success('Роутер удалён навсегда');
      setPurging(null);
      setPurgeName('');
      await routers.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function issueToken(router: RouterRecord): Promise<void> {
    try {
      const token = await api<BindingToken>(`/api/v1/routers/${router.id}/binding-token`, {
        method: 'POST',
      });
      setBinding({ router, token });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Роутеры"
        subtitle="Один роутер — один продукт Forkop или Prokop. Непривязанные — во вкладке «Ожидают», архивные — в «Архиве»."
        actions={<Button onClick={() => navigate('/routers/new')}>Добавить роутер</Button>}
      />

      {routers.error ? <ErrorBanner message={routers.error} onRetry={() => void routers.reload()} /> : null}

      <Panel
        title="Парк устройств"
        subtitle="Нажмите на имя, чтобы открыть состояние, шаблоны и снимки."
        actions={
          <div className="toolbar">
            <div className="segmented">
              <button
                type="button"
                className={view === 'active' ? 'seg-active' : ''}
                onClick={() => setView('active')}
              >
                Активные ({activeItems.length})
              </button>
              <button
                type="button"
                className={view === 'pending' ? 'seg-active' : ''}
                onClick={() => setView('pending')}
              >
                Ожидают ({pendingItems.length})
              </button>
              <button
                type="button"
                className={view === 'archive' ? 'seg-active' : ''}
                onClick={() => setView('archive')}
              >
                Архив ({archivedItems.length})
              </button>
            </div>
            <TextInput value={query} onChange={setQuery} placeholder="Поиск по имени или модели" type="search" />
            <Button variant="ghost" size="sm" onClick={() => void routers.reload()} busy={routers.loading}>
              Обновить
            </Button>
          </div>
        }
      >
        {routers.loading && !routers.data ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <Empty>
            {view === 'archive'
              ? 'Архив пуст. Архивированные роутеры появятся здесь.'
              : view === 'pending'
                ? 'Нет роутеров, ожидающих привязки.'
                : allItems.length === 0
                  ? 'Роутеров пока нет. Добавьте первый и выпустите токен привязки.'
                  : 'Ничего не найдено по запросу.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Имя</th>
                  {isAdmin ? <th>Владелец</th> : null}
                  <th>Продукт</th>
                  <th>Платформа</th>
                  <th>Статус</th>
                  <th>sing-box</th>
                  <th>Контакт</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((router) => (
                  <tr key={router.id}>
                    <td>
                      <Link to={`/routers/${router.id}`}>{router.name}</Link>
                      {router.model ? <div className="muted-text small">{router.model}</div> : null}
                    </td>
                    {isAdmin ? <td className="muted-text small">{router.owner_email ?? '—'}</td> : null}
                    <td>
                      <div>{PRODUCT_LABEL[router.product] ?? router.product}</div>
                      <div className="muted-text small">{router.product_version ?? 'версия неизвестна'}</div>
                    </td>
                    <td className="small">
                      <div>{router.openwrt_version ?? '—'}</div>
                      <div className="muted-text">{router.arch ?? '—'}</div>
                    </td>
                    <td>
                      {router.archived_at ? (
                        <StatusBadge status="archived" label="В архиве" />
                      ) : (
                        <StatusBadge
                          status={router.status}
                          label={ROUTER_STATUS[router.status] ?? router.status}
                        />
                      )}
                    </td>
                    <td className="small">{router.sing_box_version ?? '—'}</td>
                    <td className="muted-text small">
                      {router.archived_at
                        ? `архив ${formatDate(router.archived_at)}`
                        : formatRelative(router.last_seen_at)}
                    </td>
                    <td className="row-actions">
                      {router.archived_at ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => void restore(router)} busy={busy}>
                            Восстановить
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setPurging(router);
                              setPurgeName('');
                            }}
                          >
                            Удалить навсегда
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => void issueToken(router)}>
                            Привязка
                          </Button>
                          <Button size="sm" variant="subtle" onClick={() => setArchiving(router)}>
                            В архив
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setPurging(router);
                              setPurgeName('');
                            }}
                          >
                            Удалить
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {archiving ? (
        <ConfirmDialog
          title="Архивировать роутер?"
          danger
          busy={busy}
          confirmLabel="В архив"
          onCancel={() => setArchiving(null)}
          onConfirm={() => void archive()}
          message={
            <>
              <p>
                Роутер <strong>{archiving.name}</strong> будет архивирован: мониторинг отключится,
                учётные данные агента отзываются, очередь задач очищается.
              </p>
              <p className="muted-text">
                Forkop/Prokop на самом устройстве не изменяются. Роутер можно будет восстановить из
                архива — агент подключится снова без переустановки.
              </p>
            </>
          }
        />
      ) : null}

      {purging ? (
        <Modal
          title="Удалить роутер навсегда?"
          onClose={() => {
            setPurging(null);
            setPurgeName('');
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setPurging(null);
                  setPurgeName('');
                }}
                disabled={busy}
              >
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => void purge()}
                busy={busy}
                disabled={purgeName.trim() !== purging.name}
              >
                Удалить навсегда
              </Button>
            </>
          }
        >
          <p>
            Роутер <strong>{purging.name}</strong> и все связанные данные будут удалены из базы:
            история мониторинга, снимки, подключения, задания, назначения шаблонов и учётные данные
            агента. Это действие необратимо.
          </p>
          <p className="muted-text">
            На самом роутере Forkop/Prokop и JanusNew не удаляются. Если агент продолжит работу, он
            получит отказ и перестанет передавать данные.
          </p>
          <Field label={`Для подтверждения введите имя «${purging.name}»`}>
            <TextInput value={purgeName} onChange={setPurgeName} placeholder={purging.name} />
          </Field>
        </Modal>
      ) : null}

      {binding ? (
        <Modal
          title={`Привязка: ${binding.router.name}`}
          wide
          onClose={() => setBinding(null)}
          footer={<Button onClick={() => setBinding(null)}>Готово</Button>}
        >
          <p className="page-sub">{binding.token.warning}</p>
          <Field label="Команда установки" hint="Выполните на роутере по SSH один раз.">
            <pre className="code-block">{binding.token.install_command}</pre>
          </Field>
          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                void copyText(binding.token.install_command).then((ok) =>
                  ok
                    ? toast.success('Команда скопирована')
                    : toast.error('Не удалось скопировать команду'),
                );
              }}
            >
              Скопировать команду
            </Button>
            <span className="muted-text">
              Действует до {new Date(binding.token.expires_at).toLocaleTimeString('ru-RU')}
            </span>
          </div>
          <Field label="Сервер" hint="Роутер подключается исходящим TLS-соединением.">
            <pre className="code-block">{binding.token.server_url}</pre>
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
