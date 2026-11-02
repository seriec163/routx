import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { navigate } from '../lib/router';
import { Button, ErrorBanner, Field, InfoBanner, Spinner, TextInput } from '../components/ui';
import { LogoMark } from '../components/Logo';
import { useSession } from '../session';

interface LoginResponse {
  mfa_required: boolean;
  mfa_ticket?: string;
  expires_in?: number;
  enrollment_required?: boolean;
  user?: { email: string };
}

export function BrandMark() {
  return <LogoMark />;
}

export function LoginPage() {
  const { reload } = useSession();
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryRepeat, setRecoveryRepeat] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryDone, setRecoveryDone] = useState(false);

  useEffect(() => {
    if (step !== 'mfa' || secondsLeft <= 0) return;
    const timer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [step, secondsLeft]);

  async function submitPassword(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password },
      });

      if (response.mfa_required && response.mfa_ticket) {
        setTicket(response.mfa_ticket);
        setSecondsLeft(response.expires_in ?? 300);
        setStep('mfa');
        setPassword('');
        return;
      }

      await reload();
      navigate('/');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/mfa', { method: 'POST', body: { mfa_ticket: ticket, code } });
      await reload();
      navigate('/');
    } catch (caught) {
      setError(errorMessage(caught));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function submitRecovery(): Promise<void> {
    setRecoveryError(null);
    if (recoveryPassword.length < 12) {
      setRecoveryError('Пароль должен быть не короче 12 символов');
      return;
    }
    if (recoveryPassword !== recoveryRepeat) {
      setRecoveryError('Пароли не совпадают');
      return;
    }
    setRecoveryBusy(true);
    try {
      await api('/api/v1/auth/password-reset/totp', {
        method: 'POST',
        body: {
          email: email.trim(),
          code: recoveryCode.trim(),
          password: recoveryPassword,
        },
      });
      setRecoveryDone(true);
      setRecoveryPassword('');
      setRecoveryRepeat('');
      setRecoveryCode('');
      setPassword('');
    } catch (caught) {
      setRecoveryError(errorMessage(caught));
    } finally {
      setRecoveryBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <div className="brand">
          <BrandMark />
          <div>
            <p className="brand-name">RoutX</p>
            <p className="brand-sub">OpenWrt · Forkop / Prokop</p>
          </div>
        </div>
        <div className="auth-pitch">
          <p className="eyebrow">Централизованное управление</p>
          <h1>Один пульт для парка роутеров</h1>
          <p className="lead">
            Шаблоны конфигурации, безопасное применение со снимком и откатом, мониторинг прокси,
            диагностика и управление sing-box — без SSH и без входящих подключений к роутеру.
          </p>
          <ul className="auth-points">
            <li>Роутер сам выходит на сервер по TLS и long-poll.</li>
            <li>Только разрешённые UCI-параметры; подписки передаются по TLS и хранятся зашифрованными.</li>
            <li>Каждое изменение — снимок, проверка и откат.</li>
          </ul>
        </div>
        <p className="fineprint">Forkop и Prokop не переустанавливаются и не мигрируются.</p>
      </aside>

      <main className="auth-main">
        {step === 'password' ? (
          <form className="auth-card" onSubmit={submitPassword}>
            <h2>Вход</h2>
            <p className="page-sub">Используйте учётную запись, выданную администратором.</p>

            {error ? <ErrorBanner message={error} /> : null}

            <Field label="E-mail" htmlFor="login-email">
              <TextInput
                id="login-email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="username"
                required
                placeholder="admin@example.com"
              />
            </Field>
            <Field label="Пароль" htmlFor="login-password">
              <TextInput
                id="login-password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                required
              />
            </Field>

            <Button type="submit" busy={busy} disabled={!email || !password}>
              Войти
            </Button>
            <button
              type="button"
              className="link auth-link-left"
              onClick={() => setShowRecovery((value) => !value)}
            >
              Забыли пароль?
            </button>
            {showRecovery ? (
              recoveryDone ? (
                <InfoBanner>
                  Пароль изменён. Войдите с новым паролем и кодом из приложения-аутентификатора.
                </InfoBanner>
              ) : (
                <div className="stack" style={{ marginTop: 12 }}>
                  <p className="page-sub" style={{ margin: 0 }}>
                    Сброс по коду из приложения-аутентификатора. Почта не нужна, но 2FA должен
                    быть уже включён.
                  </p>
                  {recoveryError ? <ErrorBanner message={recoveryError} /> : null}
                  <Field label="E-mail" htmlFor="recovery-email">
                    <TextInput
                      id="recovery-email"
                      type="email"
                      value={email}
                      onChange={setEmail}
                      autoComplete="username"
                      required
                    />
                  </Field>
                  <Field label="Код из приложения" htmlFor="recovery-code">
                    <TextInput
                      id="recovery-code"
                      value={recoveryCode}
                      onChange={setRecoveryCode}
                      placeholder="123456"
                      autoComplete="one-time-code"
                      required
                    />
                  </Field>
                  <Field
                    label="Новый пароль"
                    htmlFor="recovery-password"
                    hint="Не короче 12 символов и хотя бы 3 класса символов"
                  >
                    <TextInput
                      id="recovery-password"
                      type="password"
                      value={recoveryPassword}
                      onChange={setRecoveryPassword}
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                  <Field label="Повторите пароль" htmlFor="recovery-repeat">
                    <TextInput
                      id="recovery-repeat"
                      type="password"
                      value={recoveryRepeat}
                      onChange={setRecoveryRepeat}
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                  <Button
                    type="button"
                    onClick={() => void submitRecovery()}
                    busy={recoveryBusy}
                    disabled={
                      !email ||
                      recoveryCode.trim().length < 6 ||
                      recoveryPassword.length < 12 ||
                      recoveryPassword !== recoveryRepeat
                    }
                  >
                    Сбросить пароль
                  </Button>
                  <p className="muted-text small">
                    Нет доступа к телефону? Попросите суперадминистратора создать одноразовую
                    ссылку: «Пользователи» → «Сбросить пароль». Ссылка действует 1 час.
                  </p>
                </div>
              )
            ) : null}
            <p className="auth-fineprint">
              Регистрация только по приглашению. Нет доступа — обратитесь к суперадминистратору.
            </p>
          </form>
        ) : (
          <form className="auth-card" onSubmit={submitMfa}>
            <h2>Второй фактор</h2>
            <p className="page-sub">
              Введите 6-значный код из приложения-аутентификатора.
              {secondsLeft > 0 ? ` Билет действует ещё ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.` : ''}
            </p>

            {error ? <ErrorBanner message={error} /> : null}
            {secondsLeft === 0 ? (
              <InfoBanner tone="warn">
                Время подтверждения истекло.{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setStep('password');
                    setTicket(null);
                    setError(null);
                  }}
                >
                  Начать вход заново
                </button>
              </InfoBanner>
            ) : null}

            <Field label="Код TOTP" htmlFor="login-code">
              <TextInput
                id="login-code"
                value={code}
                onChange={setCode}
                placeholder="123456"
                autoComplete="one-time-code"
                required
              />
            </Field>

            <div className="row">
              <Button type="submit" busy={busy} disabled={code.length < 6 || secondsLeft === 0}>
                Подтвердить
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStep('password');
                  setTicket(null);
                  setCode('');
                  setError(null);
                }}
              >
                Назад
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}

interface InvitePreview {
  role: 'superadmin' | 'user';
  email: string | null;
  expires_at: string;
  valid: boolean;
}

export function InvitePage({
  token,
  loggedInAs = null,
  onLogout,
}: {
  token: string;
  loggedInAs?: string | null;
  onLogout?: () => void;
}) {
  const { reload } = useSession();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await api<InvitePreview>('/api/v1/auth/invite/preview', {
          query: { token },
        });
        if (!active) return;
        setPreview(response);
      } catch (caught) {
        if (active) setLoadError(errorMessage(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  if (loggedInAs) {
    return (
      <div className="auth-shell auth-shell-single">
        <main className="auth-main">
          <div className="auth-card">
            <div className="brand auth-brand-inline">
              <BrandMark />
              <div>
                <p className="brand-name">RoutX</p>
                <p className="brand-sub">Активация приглашения</p>
              </div>
            </div>
            <h2>Вы уже вошли</h2>
            <p className="page-sub">
              Ссылка приглашения предназначена для новой учётной записи. Сейчас вы вошли как{' '}
              <strong>{loggedInAs}</strong>. Чтобы принять приглашение, выйдите из текущей учётной
              записи.
            </p>
            <div className="row">
              {onLogout ? <Button onClick={onLogout}>Выйти</Button> : null}
              <Button variant="ghost" onClick={() => navigate('/')}>
                На главную
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  async function accept(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== repeat) {
      setError('Пароли не совпадают');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/invite/accept', {
        method: 'POST',
        body: { token, email, password },
      });
      await reload();
      navigate('/');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell auth-shell-single">
      <main className="auth-main">
        <form className="auth-card" onSubmit={accept}>
          <div className="brand auth-brand-inline">
            <BrandMark />
            <div>
              <p className="brand-name">RoutX</p>
              <p className="brand-sub">Активация приглашения</p>
            </div>
          </div>

          {loading ? <Spinner label="Проверяем приглашение…" /> : null}
          {loadError ? <ErrorBanner message={loadError} /> : null}

          {preview && !preview.valid ? (
            <InfoBanner tone="warn">
              Приглашение недействительно или уже использовано. Запросите новое у администратора.
            </InfoBanner>
          ) : null}

          {preview?.valid ? (
            <>
              <p className="page-sub">
                Роль: <strong>{preview.role === 'superadmin' ? 'суперадминистратор' : 'пользователь'}</strong>
                {preview.email ? ` · приглашение привязано к ${preview.email}` : ''}
              </p>
              {error ? <ErrorBanner message={error} /> : null}
              <Field label="E-mail" htmlFor="invite-email">
                <TextInput
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  required
                  autoComplete="username"
                />
              </Field>
              <Field
                label="Пароль"
                htmlFor="invite-password"
                hint="Не короче 12 символов, строчные и заглавные буквы, цифра."
              >
                <TextInput
                  id="invite-password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  required
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Повторите пароль" htmlFor="invite-repeat">
                <TextInput
                  id="invite-repeat"
                  type="password"
                  value={repeat}
                  onChange={setRepeat}
                  required
                  autoComplete="new-password"
                />
              </Field>
              <Button type="submit" busy={busy} disabled={!email || password.length < 8}>
                Создать учётную запись
              </Button>
            </>
          ) : null}
        </form>
      </main>
    </div>
  );
}

interface ResetPreview {
  email_masked: string;
  expires_at: string;
  valid: boolean;
}

export function ResetPasswordPage({ token }: { token: string }) {
  const { reload } = useSession();
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await api<ResetPreview>('/api/v1/auth/password-reset/preview', {
          query: { token },
        });
        if (!active) return;
        setPreview(response);
      } catch (caught) {
        if (active) setLoadError(errorMessage(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== repeat) {
      setError('Пароли не совпадают');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/password-reset', {
        method: 'POST',
        body: { token, password },
      });
      setDone(true);
      // Если страницу открыл уже вошедший пользователь, после сброса его
      // текущая сессия отозвана — обновляем состояние сессии.
      await reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell auth-shell-single">
      <main className="auth-main">
        <div className="auth-card">
          <div className="brand auth-brand-inline">
            <BrandMark />
            <div>
              <p className="brand-name">RoutX</p>
              <p className="brand-sub">Сброс пароля</p>
            </div>
          </div>

          {loading ? <Spinner label="Проверяем ссылку…" /> : null}
          {loadError ? <ErrorBanner message={loadError} /> : null}

          {preview && !preview.valid ? (
            <InfoBanner tone="warn">
              Ссылка сброса недействительна или уже использована. Запросите новую у
              суперадминистратора.
            </InfoBanner>
          ) : null}

          {done ? (
            <>
              <InfoBanner>
                Пароль изменён. Все активные сессии этой учётной записи завершены. Теперь можно
                войти с новым паролем.
              </InfoBanner>
              <Button onClick={() => navigate('/')}>Войти</Button>
            </>
          ) : null}

          {!done && preview?.valid ? (
            <form className="stack" onSubmit={submit}>
              <p className="page-sub">
                Учётная запись: <strong>{preview.email_masked}</strong>. Ссылка действует до{' '}
                {new Date(preview.expires_at).toLocaleString('ru-RU')}.
              </p>
              {error ? <ErrorBanner message={error} /> : null}
              <Field
                label="Новый пароль"
                htmlFor="reset-password"
                hint="Не короче 12 символов, строчные и заглавные буквы, цифра."
              >
                <TextInput
                  id="reset-password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  required
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Повторите пароль" htmlFor="reset-repeat">
                <TextInput
                  id="reset-repeat"
                  type="password"
                  value={repeat}
                  onChange={setRepeat}
                  required
                  autoComplete="new-password"
                />
              </Field>
              <Button type="submit" busy={busy} disabled={password.length < 8 || !repeat}>
                Сохранить новый пароль
              </Button>
            </form>
          ) : null}

          {!done && !loading && !preview ? (
            <Button variant="ghost" onClick={() => navigate('/')}>
              На главную
            </Button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
