import { useState } from 'react';
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
  Select,
  Spinner,
  StatusBadge,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatDate, formatRelative } from '../lib/format';
import type { InviteRow, Role, UserRow } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

export function UsersPage() {
  const toast = useToast();
  const { me } = useSession();
  const users = useApi<{ items: UserRow[] }>(
    '/api/v1/users?include_suspended=true&include_archived=true',
  );
  const invites = useApi<{ items: InviteRow[] }>('/api/v1/invites');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [role, setRole] = useState<Role>('user');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<{
    url: string;
    expires_at: string;
    token: string;
  } | null>(null);
  const [revoking, setRevoking] = useState<InviteRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetMfa, setResetMfa] = useState(false);
  const [createdReset, setCreatedReset] = useState<{
    url: string;
    expires_at: string;
    email: string;
    mfa_reset: boolean;
  } | null>(null);
  const [confirmUser, setConfirmUser] = useState<{
    user: UserRow;
    action: 'suspend' | 'activate' | 'revoke' | 'archive' | 'restore' | 'delete';
  } | null>(null);
  const [editingName, setEditingName] = useState<UserRow | null>(null);
  const [nameFields, setNameFields] = useState({ first_name: '', middle_name: '', last_name: '' });

  function openNameEditor(user: UserRow): void {
    setEditingName(user);
    setNameFields({
      first_name: user.first_name ?? '',
      middle_name: user.middle_name ?? '',
      last_name: user.last_name ?? '',
    });
  }

  async function saveName(): Promise<void> {
    if (!editingName) return;
    setBusy(true);
    try {
      await api(`/api/v1/users/${editingName.id}`, {
        method: 'PATCH',
        body: {
          first_name: nameFields.first_name.trim() || null,
          middle_name: nameFields.middle_name.trim() || null,
          last_name: nameFields.last_name.trim() || null,
        },
      });
      toast.success('Имя пользователя сохранено');
      setEditingName(null);
      await users.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createInvite(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        invite: { url: string; expires_at: string; token: string };
      }>('/api/v1/invites', {
        method: 'POST',
        body: { role, ...(email.trim() ? { email: email.trim() } : {}) },
      });
      setCreatedInvite(result.invite);
      await invites.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createPasswordReset(): Promise<void> {
    if (!resetTarget) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        reset: { url: string; expires_at: string; reset_mfa: boolean };
        user: { email: string };
      }>(`/api/v1/users/${resetTarget.id}/password-reset`, {
        method: 'POST',
        body: { reset_mfa: resetMfa },
      });
      setCreatedReset({
        url: result.reset.url,
        expires_at: result.reset.expires_at,
        email: result.user.email,
        mfa_reset: result.reset.reset_mfa,
      });
      setResetTarget(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(target: UserRow, patch: { role?: Role; status?: string }): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/users/${target.id}`, { method: 'PATCH', body: patch });
      toast.success('Пользователь обновлён');
      setConfirmUser(null);
      await users.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revokeSessions(target: UserRow): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ revoked: number }>(`/api/v1/users/${target.id}/revoke-sessions`, {
        method: 'POST',
      });
      toast.success(`Отозвано сессий: ${result.revoked}`);
      setConfirmUser(null);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function userAction(
    target: UserRow,
    action: 'archive' | 'restore' | 'delete',
  ): Promise<void> {
    setBusy(true);
    try {
      if (action === 'archive') {
        await api(`/api/v1/users/${target.id}/archive`, { method: 'POST' });
        toast.success('Пользователь перемещён в архив');
      } else if (action === 'restore') {
        await api(`/api/v1/users/${target.id}/restore`, { method: 'POST' });
        toast.success('Пользователь восстановлен из архива');
      } else {
        await api(`/api/v1/users/${target.id}`, { method: 'DELETE' });
        toast.success('Пользователь удалён');
      }
      setConfirmUser(null);
      await users.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite(): Promise<void> {
    if (!revoking) return;
    setBusy(true);
    try {
      await api(`/api/v1/invites/${revoking.id}`, { method: 'DELETE' });
      toast.success('Приглашение отозвано');
      setRevoking(null);
      await invites.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Пользователи"
        subtitle="Регистрация только по приглашению. Ссылка одноразовая и действует 7 дней."
        actions={<Button onClick={() => setInviteOpen(true)}>Пригласить</Button>}
      />

      {users.error ? <ErrorBanner message={users.error} onRetry={() => void users.reload()} /> : null}

      <Panel
        title="Учётные записи"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void users.reload()} busy={users.loading}>
            Обновить
          </Button>
        }
      >
        {users.loading && !users.data ? (
          <Spinner />
        ) : (users.data?.items.length ?? 0) === 0 ? (
          <Empty>Пользователей нет.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>E-mail</th>
                  <th>Имя</th>
                  <th>Роль</th>
                  <th>2FA</th>
                  <th>Статус</th>
                  <th>Роутеры</th>
                  <th>Последний вход</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data!.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.email}
                      {user.id === me?.user.id ? <span className="muted-text small"> · это вы</span> : null}
                    </td>
                    <td>
                      <button type="button" className="link" onClick={() => openNameEditor(user)}>
                        {[user.last_name, user.first_name, user.middle_name].filter(Boolean).join(' ') || '—'}
                      </button>
                    </td>
                    <td>
                      <Select
                        value={user.role}
                        onChange={(value) => void updateUser(user, { role: value as Role })}
                        disabled={Boolean(user.archived_at)}
                      >
                        <option value="user">Пользователь</option>
                        <option value="superadmin">Суперадминистратор</option>
                      </Select>
                    </td>
                    <td>
                      <StatusBadge
                        status={user.totp_enabled ? 'success' : 'warning'}
                        label={user.totp_enabled ? 'включена' : 'не настроена'}
                      />
                    </td>
                    <td>
                      <StatusBadge
                        status={
                          user.archived_at
                            ? 'neutral'
                            : user.status === 'active'
                              ? 'online'
                              : 'offline'
                        }
                        label={
                          user.archived_at
                            ? 'архив'
                            : user.status === 'active'
                              ? 'активен'
                              : 'заблокирован'
                        }
                      />
                    </td>
                    <td>{user.router_count ?? '—'}</td>
                    <td className="muted-text small">{formatRelative(user.last_login_at)}</td>
                    <td className="row-actions">
                      {user.archived_at ? (
                        <>
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => setConfirmUser({ user, action: 'restore' })}
                          >
                            Восстановить
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmUser({ user, action: 'delete' })}
                          >
                            Удалить навсегда
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setResetMfa(false);
                              setResetTarget(user);
                            }}
                          >
                            Восстановить доступ
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setConfirmUser({
                                user,
                                action: user.status === 'active' ? 'suspend' : 'activate',
                              })
                            }
                          >
                            {user.status === 'active' ? 'Заблокировать' : 'Активировать'}
                          </Button>
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => setConfirmUser({ user, action: 'revoke' })}
                          >
                            Сбросить сессии
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmUser({ user, action: 'archive' })}
                          >
                            Архивировать
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

      <Panel
        title="Приглашения"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void invites.reload()} busy={invites.loading}>
            Обновить
          </Button>
        }
      >
        {invites.loading && !invites.data ? (
          <Spinner />
        ) : (invites.data?.items.length ?? 0) === 0 ? (
          <Empty>Приглашений нет.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Создано</th>
                  <th>Роль</th>
                  <th>E-mail</th>
                  <th>Статус</th>
                  <th>Истекает</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.data!.items.map((invite) => {
                  const used = Boolean(invite.used_at);
                  const expired = !used && Date.parse(invite.expires_at) <= Date.now();
                  return (
                    <tr key={invite.id}>
                      <td className="small">{formatDate(invite.created_at)}</td>
                      <td>{invite.role === 'superadmin' ? 'Суперадминистратор' : 'Пользователь'}</td>
                      <td className="small">{invite.email ?? 'любой'}</td>
                      <td>
                        <StatusBadge
                          status={used ? 'success' : expired ? 'timeout' : 'pending'}
                          label={used ? 'использовано' : expired ? 'истекло' : 'активно'}
                        />
                      </td>
                      <td className="muted-text small">{formatDate(invite.expires_at)}</td>
                      <td>
                        {!used && !expired ? (
                          <Button size="sm" variant="subtle" onClick={() => setRevoking(invite)}>
                            Отозвать
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {inviteOpen ? (
        <Modal
          title={createdInvite ? 'Приглашение создано' : 'Новое приглашение'}
          wide
          onClose={() => {
            setInviteOpen(false);
            setCreatedInvite(null);
            setEmail('');
          }}
          footer={
            createdInvite ? (
              <Button
                onClick={() => {
                  setInviteOpen(false);
                  setCreatedInvite(null);
                  setEmail('');
                }}
              >
                Готово
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setInviteOpen(false)}
                  disabled={busy}
                >
                  Отмена
                </Button>
                <Button onClick={() => void createInvite()} busy={busy}>
                  Создать ссылку
                </Button>
              </>
            )
          }
        >
          {createdInvite ? (
            <>
              <InfoBanner tone="warn">
                Ссылка показывается один раз. Передайте её по защищённому каналу.
              </InfoBanner>
              <Field label="Ссылка приглашения">
                <pre className="code-block" style={{ userSelect: 'all' }}>
                  {createdInvite.url}
                </pre>
              </Field>
              <div className="row">
                <Button
                  variant="ghost"
                  onClick={() => {
                    void copyText(createdInvite.url).then((ok) =>
                      ok
                        ? toast.success('Ссылка скопирована')
                        : toast.error('Не удалось скопировать ссылку'),
                    );
                  }}
                >
                  Скопировать ссылку
                </Button>
                <span className="muted-text">до {formatDate(createdInvite.expires_at)}</span>
              </div>
              <p className="muted-text small">
                Если кнопка копирования не сработала, нажмите на ссылку выше — она выделится
                целиком, и её можно скопировать вручную.
              </p>
            </>
          ) : (
            <>
              {error ? <ErrorBanner message={error} /> : null}
              <Field label="Роль">
                <Select value={role} onChange={(value) => setRole(value as Role)}>
                  <option value="user">Пользователь</option>
                  <option value="superadmin">Суперадминистратор</option>
                </Select>
              </Field>
              <Field
                label="E-mail (необязательно)"
                hint="Если указан, принять приглашение сможет только этот адрес."
              >
                <TextInput value={email} onChange={setEmail} type="email" placeholder="user@example.com" />
              </Field>
            </>
          )}
        </Modal>
      ) : null}

      {resetTarget ? (
        <ConfirmDialog
          title="Восстановить доступ?"
          busy={busy}
          confirmLabel="Создать ссылку"
          onCancel={() => {
            setResetTarget(null);
            setError(null);
          }}
          onConfirm={() => void createPasswordReset()}
          message={
            <>
              {error ? <ErrorBanner message={error} /> : null}
              <p>
                Для <strong>{resetTarget.email}</strong> будет создана одноразовая ссылка сброса.
                Она действует 1 час. После смены пароля все активные сессии пользователя будут
                завершены.
              </p>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={resetMfa}
                  onChange={(event) => setResetMfa(event.target.checked)}
                  style={{ marginTop: 3, flex: '0 0 auto' }}
                />
                <span>
                  <strong>Потерян телефон с 2FA.</strong> Сбросить второй фактор вместе с паролем.
                  После входа пользователь настроит 2FA заново, если этого требует политика.
                </span>
              </label>
            </>
          }
        />
      ) : null}

      {createdReset ? (
        <Modal
          title="Ссылка сброса пароля"
          onClose={() => setCreatedReset(null)}
          footer={
            <Button onClick={() => setCreatedReset(null)}>Готово</Button>
          }
        >
          <InfoBanner tone="warn">
            Ссылка показывается один раз. Передайте её пользователю по защищённому каналу.
          </InfoBanner>
          {createdReset.mfa_reset ? (
            <InfoBanner>
              Вместе с паролем будет сброшен второй фактор. После входа пользователю нужно будет
              заново подключить приложение-аутентификатор.
            </InfoBanner>
          ) : null}
          <Field label={`Ссылка для ${createdReset.email}`}>
            <pre className="code-block" style={{ userSelect: 'all' }}>
              {createdReset.url}
            </pre>
          </Field>
          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                void copyText(createdReset.url).then((ok) =>
                  ok
                    ? toast.success('Ссылка сброса скопирована')
                    : toast.error('Не удалось скопировать ссылку'),
                );
              }}
            >
              Скопировать ссылку
            </Button>
            <span className="muted-text">до {formatDate(createdReset.expires_at)}</span>
          </div>
          <p className="muted-text small">
            Если кнопка копирования не сработала, нажмите на ссылку выше — она выделится целиком,
            и её можно скопировать вручную.
          </p>
        </Modal>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title="Отозвать приглашение?"
          danger
          busy={busy}
          confirmLabel="Отозвать"
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revokeInvite()}
          message={<p>Ссылка перестанет работать. Пользователь не сможет активировать учётную запись.</p>}
        />
      ) : null}

      {confirmUser ? (
        <ConfirmDialog
          title={
            confirmUser.action === 'revoke'
              ? 'Сбросить все сессии?'
              : confirmUser.action === 'suspend'
                ? 'Заблокировать пользователя?'
                : confirmUser.action === 'activate'
                  ? 'Активировать пользователя?'
                  : confirmUser.action === 'archive'
                    ? 'Архивировать пользователя?'
                    : confirmUser.action === 'restore'
                      ? 'Восстановить пользователя?'
                      : 'Удалить пользователя навсегда?'
          }
          danger={
            confirmUser.action === 'suspend' ||
            confirmUser.action === 'archive' ||
            confirmUser.action === 'delete'
          }
          busy={busy}
          confirmLabel={
            confirmUser.action === 'revoke'
              ? 'Сбросить'
              : confirmUser.action === 'suspend'
                ? 'Заблокировать'
                : confirmUser.action === 'activate'
                  ? 'Активировать'
                  : confirmUser.action === 'archive'
                    ? 'Архивировать'
                    : confirmUser.action === 'restore'
                      ? 'Восстановить'
                      : 'Удалить'
          }
          onCancel={() => setConfirmUser(null)}
          onConfirm={() => {
            if (confirmUser.action === 'revoke') void revokeSessions(confirmUser.user);
            else if (confirmUser.action === 'suspend' || confirmUser.action === 'activate') {
              void updateUser(confirmUser.user, {
                status: confirmUser.action === 'suspend' ? 'suspended' : 'active',
              });
            } else {
              void userAction(confirmUser.user, confirmUser.action);
            }
          }}
          message={
            <p>
              {confirmUser.action === 'revoke'
                ? `Все активные сессии ${confirmUser.user.email} будут отозваны. Пользователю придётся войти снова.`
                : confirmUser.action === 'suspend'
                  ? `${confirmUser.user.email} потеряет доступ, все сессии будут отозваны.`
                  : confirmUser.action === 'activate'
                    ? `${confirmUser.user.email} снова сможет входить в систему.`
                    : confirmUser.action === 'archive'
                      ? `${confirmUser.user.email} будет перемещён в архив: вход запрещён, сессии отозваны. Роутеры, шаблоны и подписки сохранятся.`
                      : confirmUser.action === 'restore'
                        ? `${confirmUser.user.email} будет восстановлен из архива и снова сможет входить в систему.`
                        : `${confirmUser.user.email} будет удалён навсегда. Удаление возможно только если у пользователя нет роутеров, шаблонов, подписок и приглашений.`}
            </p>
          }
        />
      ) : null}
      {editingName ? (
        <Modal
          title="Имя и отчество"
          onClose={() => setEditingName(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditingName(null)} disabled={busy}>
                Отмена
              </Button>
              <Button onClick={() => void saveName()} busy={busy}>
                Сохранить
              </Button>
            </>
          }
        >
          <p className="page-sub">{editingName.email}</p>
          <Field label="Имя">
            <TextInput
              value={nameFields.first_name}
              onChange={(value) => setNameFields((current) => ({ ...current, first_name: value }))}
              placeholder="Артур"
            />
          </Field>
          <Field label="Отчество">
            <TextInput
              value={nameFields.middle_name}
              onChange={(value) => setNameFields((current) => ({ ...current, middle_name: value }))}
              placeholder="Николаевич"
            />
          </Field>
          <Field label="Фамилия" hint="Необязательно">
            <TextInput
              value={nameFields.last_name}
              onChange={(value) => setNameFields((current) => ({ ...current, last_name: value }))}
              placeholder="Иванов"
            />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
