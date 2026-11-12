import { useState } from 'react';
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate, roleLabel } from '../lib/format';
import { useSession } from '../session';
import { PasskeyPanel, RecoveryCodesPanel } from './AccountSecurity';

interface EnrollResponse {
  secret: string;
  otpauth_uri: string;
  qr_data_url: string;
}

export function EnrollmentPanel({ onDone }: { onDone?: () => void }) {
  const { me, reload } = useSession();
  const toast = useToast();
  const [enrollment, setEnrollment] = useState<EnrollResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await api<EnrollResponse>('/api/v1/auth/mfa/enroll', { method: 'POST' }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/mfa/confirm', { method: 'POST', body: { code: code.trim() } });
      toast.success('Второй фактор включён');
      setEnrollment(null);
      setCode('');
      await reload();
      onDone?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (me?.user.totp_enabled) {
    return (
      <>
        <InfoBanner>Второй фактор включён. Отключение запрещено политикой безопасности.</InfoBanner>
        <div className="kv">
          <span>Статус</span>
          <strong>
            <StatusBadge status="success" label="включён" />
          </strong>
          <span>Политика</span>
          <strong>{me.mfa_policy === 'all' ? 'для всех пользователей' : 'только для администраторов'}</strong>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="page-sub">
        Подключите приложение-аутентификатор (Aegis, Google Authenticator, 1Password и т. п.).
        Секрет показывается один раз и хранится на сервере в зашифрованном виде.
      </p>
      {error ? <ErrorBanner message={error} /> : null}

      {!enrollment ? (
        <Button onClick={() => void start()} busy={busy}>
          Настроить второй фактор
        </Button>
      ) : (
        <>
          <div className="enroll-grid">
            <img className="qr" src={enrollment.qr_data_url} alt="QR-код для подключения 2FA" />
            <div className="stack">
              <Field label="Секрет для ручного ввода" hint="Если QR не считывается.">
                <pre className="code-block">{enrollment.secret}</pre>
              </Field>
              <Field label="Ссылка otpauth://" hint="Для ручного импорта в приложение.">
                <pre className="code-block small">{enrollment.otpauth_uri}</pre>
              </Field>
            </div>
          </div>
          <Field label="Код из приложения" hint="6 цифр. Подтверждение сразу активирует второй фактор.">
            <TextInput
              value={code}
              onChange={setCode}
              placeholder="123456"
              autoComplete="one-time-code"
              required
            />
          </Field>
          <Button onClick={() => void confirm()} busy={busy} disabled={code.trim().length < 6}>
            Подтвердить и включить
          </Button>
        </>
      )}
    </>
  );
}

export function AccountPage() {
  const { me, logout, reload } = useSession();
  const toast = useToast();
  const [firstName, setFirstName] = useState(me?.user.first_name ?? '');
  const [middleName, setMiddleName] = useState(me?.user.middle_name ?? '');
  const [lastName, setLastName] = useState(me?.user.last_name ?? '');
  const [email, setEmail] = useState(me?.user.email ?? '');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveProfile(): Promise<void> {
    setProfileBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/me', {
        method: 'PATCH',
        body: {
          first_name: firstName.trim() || null,
          middle_name: middleName.trim() || null,
          last_name: lastName.trim() || null,
        },
      });
      await reload();
      toast.success('Имя сохранено — приветствие обновлено');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveEmail(): Promise<void> {
    const value = email.trim().toLowerCase();
    if (value === '') {
      setError('Укажите e-mail');
      return;
    }
    if (value === me?.user.email.toLowerCase()) {
      toast.info('E-mail не изменился');
      return;
    }
    setEmailBusy(true);
    setError(null);
    try {
      const response = await api<{ user: { email: string } }>('/api/v1/auth/me', {
        method: 'PATCH',
        body: { email: value, current_password: emailPassword },
      });
      setEmail(response.user.email);
      setEmailPassword('');
      await reload();
      toast.success('E-mail для входа изменён');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setEmailBusy(false);
    }
  }

  async function changePassword(): Promise<void> {
    if (newPassword !== repeat) {
      setError('Пароли не совпадают');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      });
      toast.success('Пароль изменён. Остальные сессии отозваны.');
      setCurrentPassword('');
      setNewPassword('');
      setRepeat('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <Spinner />;

  return (
    <div className="page">
      <PageHeader
        title="Учётная запись"
        subtitle="Профиль, второй фактор, passkey, резервные коды и пароль. Сессии, кроме текущей, отзываются при смене пароля."
        actions={
          <Button variant="ghost" onClick={() => void logout()}>
            Выйти
          </Button>
        }
      />

      <div className="grid-2">
        <div className="stack">
          <Panel title="Профиль">
            <div className="kv">
              <span>E-mail</span>
              <strong>{me.user.email}</strong>
              <span>Роль</span>
              <strong>{roleLabel(me.user.role)}</strong>
              <span>Статус</span>
              <strong>
                <StatusBadge
                  status={me.user.status === 'active' ? 'online' : 'offline'}
                  label={me.user.status === 'active' ? 'активна' : me.user.status}
                />
              </strong>
              <span>Создана</span>
              <strong>{formatDate(me.user.created_at)}</strong>
              <span>Последний вход</span>
              <strong>{formatDate(me.user.last_login_at)}</strong>
              <span>Права</span>
              <strong>
                {me.permissions.is_superadmin
                  ? 'полный доступ, включая настройки панели и всех пользователей'
                  : me.permissions.can_manage_users
                    ? 'свои роутеры и пользователи своей ветки'
                    : 'свои роутеры, шаблоны и подключения'}
              </strong>
            </div>
          </Panel>

          <Panel
            title="E-mail для входа"
            subtitle="Логин меняется сразу. Для подтверждения нужен текущий пароль."
          >
            {error ? <ErrorBanner message={error} /> : null}
            <Field label="Новый e-mail">
              <TextInput
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder="user@example.com"
              />
            </Field>
            <Field
              label="Текущий пароль"
              hint="Нужен только для смены e-mail. Пароль не сохраняется."
            >
              <TextInput
                type="password"
                value={emailPassword}
                onChange={setEmailPassword}
                autoComplete="current-password"
              />
            </Field>
            <Button onClick={() => void saveEmail()} busy={emailBusy}>
              Сохранить e-mail
            </Button>
          </Panel>

          <Panel
            title="Имя и отчество"
            subtitle="Так вас будут приветствовать в интерфейсе: «Здравствуйте, Артур Николаевич»."
          >
            {error ? <ErrorBanner message={error} /> : null}
            <div className="grid-2">
              <Field label="Имя">
                <TextInput value={firstName} onChange={setFirstName} placeholder="Артур" />
              </Field>
              <Field label="Отчество">
                <TextInput value={middleName} onChange={setMiddleName} placeholder="Николаевич" />
              </Field>
            </div>
            <Field label="Фамилия" hint="Необязательно; используется в списках и подписи.">
              <TextInput value={lastName} onChange={setLastName} placeholder="Иванов" />
            </Field>
            <Button onClick={() => void saveProfile()} busy={profileBusy}>
              Сохранить имя
            </Button>
          </Panel>

          <Panel title="Смена пароля">
            {error ? <ErrorBanner message={error} /> : null}
            <Field label="Текущий пароль">
              <TextInput
                type="password"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
              />
            </Field>
            <Field
              label="Новый пароль"
              hint="Не короче 12 символов, строчные и заглавные буквы, цифра."
            >
              <TextInput
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Повторите новый пароль">
              <TextInput
                type="password"
                value={repeat}
                onChange={setRepeat}
                autoComplete="new-password"
              />
            </Field>
            <Button
              onClick={() => void changePassword()}
              busy={busy}
              disabled={!currentPassword || newPassword.length < 8 || !repeat}
            >
              Изменить пароль
            </Button>
          </Panel>
        </div>

        <div className="stack">
          <Panel
            title="Второй фактор (TOTP)"
            subtitle={
              me.mfa_policy === 'all'
                ? 'Политика: обязателен для всех пользователей.'
                : 'Политика: обязателен для суперадминистраторов.'
            }
          >
            <EnrollmentPanel />
          </Panel>

          <Panel
            title="Passkey (Face ID / Touch ID)"
            subtitle="Дополнительный способ входа. Пароль и 2FA остаются рабочими."
          >
            <PasskeyPanel />
          </Panel>

          <Panel
            title="Резервные коды"
            subtitle="10 одноразовых кодов для полного восстановления доступа."
          >
            <RecoveryCodesPanel />
          </Panel>

          <Panel title="Безопасность сессии">
            <ul className="bullets">
              <li>Сессия хранится в HttpOnly cookie, CSRF-токен — в отдельной cookie.</li>
              <li>Изменяющие запросы требуют совпадения CSRF-токена и проверки Origin.</li>
              <li>После смены пароля все остальные сессии отзываются.</li>
              <li>Passkey хранит приватный ключ в защищённом чипе устройства.</li>
              <li>Резервный код сбрасывает пароль, 2FA и passkey; каждый код одноразовый.</li>
              <li>Пароли хранятся в виде Argon2id-хешей, секреты TOTP — в зашифрованном виде.</li>
            </ul>
            {me.enrollment_required ? (
              <InfoBanner tone="warn">
                Пока второй фактор не настроен, доступ к остальным разделам закрыт.
              </InfoBanner>
            ) : null}
          </Panel>
        </div>
      </div>

      {!me.user.totp_enabled ? <Empty>Второй фактор ещё не настроен.</Empty> : null}
    </div>
  );
}
