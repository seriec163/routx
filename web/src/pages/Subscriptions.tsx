import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import type { CatalogSubscription, SubscriptionAccessUser } from '../lib/types';
import { useApi } from '../lib/useApi';

function displayName(user: SubscriptionAccessUser): string {
  const name = [user.first_name, user.middle_name, user.last_name].filter(Boolean).join(' ');
  return name.trim() || user.email;
}

function usersWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'пользователь';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'пользователя';
  return 'пользователей';
}

export function SubscriptionsPage() {
  const toast = useToast();
  const subscriptions = useApi<{ items: CatalogSubscription[] }>('/api/v1/subscriptions');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<CatalogSubscription | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editValue, setEditValue] = useState('');
  const [shareIds, setShareIds] = useState<string[]>([]);
  const [shareQuery, setShareQuery] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const access = useApi<{ items: SubscriptionAccessUser[] }>(
    selected?.can_manage ? `/api/v1/subscriptions/${selected.id}/access` : null,
  );
  const candidates = useApi<{ items: SubscriptionAccessUser[] }>(
    selected?.can_manage ? `/api/v1/subscriptions/${selected.id}/share-candidates` : null,
  );

  useEffect(() => {
    if (!selected) return;
    setEditName(selected.name);
    setEditDescription(selected.description ?? '');
    setEditValue('');
    setShareQuery('');
  }, [selected]);

  useEffect(() => {
    if (access.data) setShareIds(access.data.items.map((user) => user.id));
  }, [access.data]);

  const filteredCandidates = useMemo(() => {
    const items = candidates.data?.items ?? [];
    const needle = shareQuery.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (user) =>
        user.email.toLowerCase().includes(needle) ||
        displayName(user).toLowerCase().includes(needle),
    );
  }, [candidates.data, shareQuery]);

  async function reloadAll(): Promise<void> {
    await subscriptions.reload();
    if (selected?.can_manage) {
      await Promise.all([access.reload(), candidates.reload()]);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/subscriptions', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || null, value: value.trim() },
      });
      toast.success('Подписка добавлена в каталог');
      setCreateOpen(false);
      setName('');
      setDescription('');
      setValue('');
      await subscriptions.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/subscriptions/${selected.id}`, {
        method: 'PATCH',
        body: {
          name: editName.trim(),
          description: editDescription.trim() || null,
          ...(editValue.trim() ? { value: editValue.trim() } : {}),
        },
      });
      toast.success('Подписка сохранена');
      setEditValue('');
      await subscriptions.reload();
      setSelected(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveAccess(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/subscriptions/${selected.id}/access`, {
        method: 'PUT',
        body: { user_ids: shareIds },
      });
      toast.success('Доступ обновлён');
      await Promise.all([access.reload(), subscriptions.reload()]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/subscriptions/${selected.id}`, { method: 'DELETE' });
      toast.success('Подписка удалена из каталога');
      setDeleteOpen(false);
      setSelected(null);
      await subscriptions.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Подписки"
        subtitle="Каталог подписок. Владелец может поделиться подпиской с другими пользователями, а они — выбрать её при добавлении на свой роутер."
        actions={<Button onClick={() => setCreateOpen(true)}>Добавить подписку</Button>}
      />

      {subscriptions.error ? (
        <ErrorBanner message={subscriptions.error} onRetry={() => void subscriptions.reload()} />
      ) : null}

      <Panel
        title="Каталог"
        subtitle="Ссылки хранятся в зашифрованном виде и показываются только в маскированном виде."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void subscriptions.reload()}
            busy={subscriptions.loading}
          >
            Обновить
          </Button>
        }
      >
        {subscriptions.loading && !subscriptions.data ? (
          <Spinner />
        ) : (subscriptions.data?.items.length ?? 0) === 0 ? (
          <Empty>Подписок пока нет. Добавьте первую и при необходимости поделитесь ею.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Владелец</th>
                  <th>Ссылка</th>
                  <th>Доступ</th>
                  <th>Обновлена</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {subscriptions.data!.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button type="button" className="link" onClick={() => setSelected(item)}>
                        {item.name}
                      </button>
                      {item.description ? (
                        <div className="muted-text small">{item.description}</div>
                      ) : null}
                    </td>
                    <td className="muted-text small">
                      {item.owner_email ?? '—'}
                      {item.is_owner ? ' · вы' : ''}
                    </td>
                    <td className="mono small">{item.masked}</td>
                    <td className="small">
                      {item.can_manage
                        ? `${item.shared_with_count ?? 0} польз.`
                        : 'предоставлен владельцем'}
                    </td>
                    <td className="muted-text small">{formatDate(item.updated_at)}</td>
                    <td className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(item)}>
                        {item.can_manage ? 'Настроить' : 'Подробнее'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Как это работает">
        <ul className="bullets">
          <li>Подписка добавляется в каталог один раз и хранится в зашифрованном виде.</li>
          <li>
            Владелец открывает подписку и выбирает пользователей, которым она доступна. Они увидят
            её в списке при добавлении подключения на роутер.
          </li>
          <li>
            Получатель доступа может выбрать подписку для своего роутера, но не может менять ссылку
            или передавать доступ дальше.
          </li>
          <li>При выборе из каталога ссылка копируется в подключение роутера.</li>
        </ul>
      </Panel>

      {createOpen ? (
        <Modal
          title="Новая подписка"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button
                onClick={() => void create()}
                busy={busy}
                disabled={!name.trim() || value.trim().length < 8}
              >
                Добавить
              </Button>
            </>
          }
        >
          {error ? <ErrorBanner message={error} /> : null}
          <Field label="Название" hint="Например: «Основная» или «Для дачи»">
            <TextInput value={name} onChange={setName} placeholder="Основная" required />
          </Field>
          <Field label="Ссылка на подписку" hint="http(s)://… Ссылка будет зашифрована.">
            <TextInput
              value={value}
              onChange={setValue}
              placeholder="https://example.com/sub/…"
              required
            />
          </Field>
          <Field label="Описание" hint="Необязательно">
            <TextInput
              value={description}
              onChange={setDescription}
              placeholder="Для чего эта подписка"
            />
          </Field>
        </Modal>
      ) : null}

      {selected ? (
        <Modal
          title={`Подписка: ${selected.name}`}
          wide
          onClose={() => setSelected(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSelected(null)} disabled={busy}>
                Закрыть
              </Button>
              {selected.can_manage ? (
                <Button onClick={() => void saveSettings()} busy={busy}>
                  Сохранить
                </Button>
              ) : null}
            </>
          }
        >
          {error ? <ErrorBanner message={error} /> : null}
          <div className="kv">
            <span>Владелец</span>
            <strong>{selected.owner_email ?? '—'}</strong>
            <span>Ссылка</span>
            <strong className="mono">{selected.masked}</strong>
            <span>Доступ</span>
            <strong>
              {selected.shared_with_count ?? 0}{' '}
              {usersWord(selected.shared_with_count ?? 0)}
            </strong>
          </div>

          {selected.can_manage ? (
            <>
              <Field label="Название">
                <TextInput value={editName} onChange={setEditName} />
              </Field>
              <Field label="Описание">
                <TextInput value={editDescription} onChange={setEditDescription} />
              </Field>
              <Field
                label="Новая ссылка"
                hint="Оставьте пустым, чтобы не менять. После замены ссылки уже добавленные на роутеры подключения не изменятся."
              >
                <TextInput
                  value={editValue}
                  onChange={setEditValue}
                  placeholder="https://…"
                />
              </Field>

              <Panel
                title="Кому доступна"
                subtitle="Отметьте пользователей. Они смогут выбрать подписку при добавлении на свой роутер."
                actions={
                  <Button size="sm" onClick={() => void saveAccess()} busy={busy}>
                    Сохранить доступ
                  </Button>
                }
              >
                {access.loading || candidates.loading ? <Spinner /> : null}
                <Field label="Поиск пользователя">
                  <TextInput
                    value={shareQuery}
                    onChange={setShareQuery}
                    placeholder="email или имя"
                    type="search"
                  />
                </Field>
                <div className="checklist" style={{ maxHeight: 260, overflow: 'auto' }}>
                  {filteredCandidates.map((user) => (
                    <label key={user.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={shareIds.includes(user.id)}
                        onChange={() =>
                          setShareIds((current) =>
                            current.includes(user.id)
                              ? current.filter((value) => value !== user.id)
                              : [...current, user.id],
                          )
                        }
                      />
                      <span>{displayName(user)}</span>
                      <span className="muted-text small">{user.email}</span>
                    </label>
                  ))}
                  {filteredCandidates.length === 0 ? (
                    <p className="muted-text small">Пользователи не найдены.</p>
                  ) : null}
                </div>
              </Panel>

              <div className="row" style={{ marginTop: 12 }}>
                <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
                  Удалить подписку
                </Button>
              </div>
            </>
          ) : (
            <InfoBanner>
              Подписка доступна вам от владельца. Вы можете выбрать её при добавлении подключения на
              роутер. Менять ссылку и передавать доступ дальше нельзя.
            </InfoBanner>
          )}
        </Modal>
      ) : null}

      {deleteOpen && selected ? (
        <ConfirmDialog
          title="Удалить подписку?"
          danger
          busy={busy}
          confirmLabel="Удалить"
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void remove()}
          message={
            <>
              <p>
                Подписка <strong>{selected.name}</strong> будет удалена из каталога. Уже добавленные
                на роутеры подключения продолжат работать, потому что ссылка хранится в самом
                подключении.
              </p>
            </>
          }
        />
      ) : null}
    </div>
  );
}
