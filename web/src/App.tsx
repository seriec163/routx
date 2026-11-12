import { useEffect, useMemo, useState } from 'react';
import { Link } from './components/link';
import { Button, Empty, ErrorBanner, Spinner, StatusBadge, ToastProvider, useToast } from './components/ui';
import { api, errorMessage, subscribeActivity } from './lib/api';
import { formatRelative, roleLabel, SEVERITY } from './lib/format';
import { useRoute, navigate } from './lib/router';
import type { NotificationRow } from './lib/types';
import { useApi } from './lib/useApi';
import { AccountPage, EnrollmentPanel } from './pages/Account';
import { ApplyRunDetailPage, ApplyRunsPage } from './pages/ApplyRuns';
import { AuditPage } from './pages/Audit';
import { DashboardPage } from './pages/Dashboard';
import { DiagnosticDetailPage, DiagnosticsPage } from './pages/Diagnostics';
import { JobsPage } from './pages/Jobs';
import { LoginPage, InvitePage, ResetPasswordPage, BrandMark } from './pages/Auth';
import { InstallPage } from './pages/Install';
import { MobileApp } from './mobile/MobileApp';
import { MobileAuthScreen } from './mobile/MobileAuthScreen';
import { isMobileBound, isMobileClient } from './mobile/deviceId';
import { RouterDetailPage } from './pages/RouterDetail';
import { RouterOnboardingPage } from './pages/RouterOnboarding';
import { RoutersPage } from './pages/Routers';
import { SubscriptionsPage } from './pages/Subscriptions';
import { RolloutDetailPage, RolloutsPage } from './pages/Rollouts';
import { SettingsPage } from './pages/Settings';
import { DeployPage } from './pages/Deploy';
import { TemplateEditorPage } from './pages/TemplateEditor';
import { TemplatesPage } from './pages/Templates';
import { UsersPage } from './pages/Users';
import { SessionProvider, displayName, useSession } from './session';
import { useNotificationToasts } from './lib/notifications';

interface NavItem {
  to: string;
  label: string;
  access?: 'manager' | 'superadmin';
  exact?: boolean;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Обзор',
    items: [
      { to: '/', label: 'Панель', exact: true },
      { to: '/routers', label: 'Роутеры' },
    ],
  },
  {
    section: 'Конфигурация',
    items: [
      { to: '/templates', label: 'Шаблоны' },
      { to: '/subscriptions', label: 'Подписки' },
      { to: '/apply-runs', label: 'Применения' },
      { to: '/jobs', label: 'Задачи' },
    ],
  },
  {
    section: 'Обслуживание',
    items: [
      { to: '/diagnostics', label: 'Диагностика' },
      { to: '/rollouts', label: 'Поэтапное обновление' },
    ],
  },
  {
    section: 'Администрирование',
    items: [
      { to: '/users', label: 'Пользователи', access: 'manager' },
      { to: '/settings', label: 'Настройки', access: 'superadmin' },
      { to: '/deploy', label: 'Развёртывание', access: 'manager' },
      { to: '/audit', label: 'Аудит', access: 'superadmin' },
    ],
  },
];

export default function App() {
  return (
    <ToastProvider>
      <NetworkActivityBar />
      <SessionProvider>
        <Root />
      </SessionProvider>
    </ToastProvider>
  );
}

/**
 * Тонкая полоса вверху окна. Появляется при любом запросе к серверу,
 * чтобы даже короткие действия не выглядели «ничего не произошло».
 */
function NetworkActivityBar() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let hideTimer: number | undefined;
    const unsubscribe = subscribeActivity((count) => {
      if (count > 0) {
        if (hideTimer) window.clearTimeout(hideTimer);
        hideTimer = undefined;
        setVisible(true);
        return;
      }
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setVisible(false), 700);
    });
    return () => {
      unsubscribe();
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, []);
  if (!visible) return null;
  return (
    <div className="network-activity" role="progressbar" aria-label="Запрос выполняется">
      <span />
    </div>
  );
}

function Root() {
  const { me, loading, error, reload, logout } = useSession();
  const route = useRoute();

  if (loading) {
    return (
      <div className="boot">
        <Spinner label="Проверяем сессию…" />
      </div>
    );
  }

  const inviteToken =
    route.segments[0] === 'invite'
      ? route.segments[1] ?? route.query.get('token') ?? ''
      : null;
  const resetToken =
    route.segments[0] === 'reset-password'
      ? route.segments[1] ?? route.query.get('token') ?? ''
      : null;

  if (route.segments[0] === 'install') {
    return (
      <InstallPage
        token={route.query.get('token')}
        routerId={route.query.get('router')}
        onLoggedIn={reload}
      />
    );
  }

  if (resetToken !== null) {
    return <ResetPasswordPage token={resetToken} />;
  }

  if (inviteToken !== null) {
    return (
      <InvitePage
        token={inviteToken}
        loggedInAs={me?.user.email ?? null}
        onLogout={() => void logout()}
      />
    );
  }

  if (!me) {
    if (error) {
      return (
        <div className="boot">
          <div className="boot-card">
            <ErrorBanner message={error} onRetry={() => void reload()} />
            <div className="row" style={{ marginTop: 12 }}>
              <Button onClick={() => navigate('/login')}>Войти</Button>
            </div>
          </div>
        </div>
      );
    }
    if (route.segments[0] === 'login') return <LoginPage />;
    if (isMobileClient() && (route.segments[0] === 'app' || isMobileBound())) {
      return <MobileAuthScreen />;
    }
    return <LoginPage />;
  }

  if (!me.mfa_passed || me.enrollment_required) {
    return (
      <div className="boot">
        <div className="boot-card enrollment-card">
          <div className="brand auth-brand-inline">
            <BrandMark />
            <div>
              <p className="brand-name">RoutX</p>
              <p className="brand-sub">Обязательная настройка 2FA</p>
            </div>
          </div>
          <p className="page-sub">
            Политика безопасности требует включить второй фактор до начала работы. Это займёт около
            минуты.
          </p>
          <EnrollmentPanel onDone={() => void reload()} />
          <div className="row">
            <Button variant="ghost" onClick={() => void logout()}>
              Выйти
            </Button>
            <Button variant="ghost" onClick={() => void reload()}>
              Проверить снова
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (route.segments[0] === 'app') {
    return <MobileApp />;
  }

  // На телефоне корень — сразу мобильное приложение, а не десктопная панель.
  // Полная панель остаётся доступна по прямым адресам (/routers и т.д.).
  const mobileFirst =
    window.matchMedia('(display-mode: standalone)').matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobileFirst && route.segments.length === 0) {
    return <MobileApp />;
  }

  return <Shell />;
}

function Shell() {
  const { me, logout, reload } = useSession();
  const toast = useToast();
  const route = useRoute();
  useNotificationToasts();
  const canManageUsers = me?.permissions.can_manage_users === true;
  const canManageSettings = me?.permissions.can_manage_settings === true;
  const canManageRouters = me?.permissions.can_manage_routers === true;
  const [navOpen, setNavOpen] = useState(false);
  const [stoppingImpersonation, setStoppingImpersonation] = useState(false);

  async function stopImpersonation(): Promise<void> {
    setStoppingImpersonation(true);
    try {
      await api('/api/v1/auth/impersonation/stop', { method: 'POST' });
      await reload();
      navigate('/users');
      toast.success('Вы снова работаете как суперадминистратор');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setStoppingImpersonation(false);
    }
  }

  useEffect(() => {
    setNavOpen(false);
  }, [route.path]);

  const page = useMemo(
    () => renderRoute(route.segments, canManageUsers, canManageSettings, canManageRouters),
    [route.segments, canManageUsers, canManageSettings, canManageRouters],
  );
  const activeTitle = useMemo(() => {
    for (const group of NAV) {
      for (const item of group.items) {
        if (isActive(route.path, item)) return item.label;
      }
    }
    return 'RoutX';
  }, [route.path]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${navOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <BrandMark />
          <div>
            <p className="brand-name">RoutX</p>
            <p className="brand-sub">OpenWrt · Forkop / Prokop</p>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((group) => {
            const items = group.items.filter((item) => {
              if (!item.access) return true;
              if (item.access === 'manager') return canManageUsers;
              return canManageSettings;
            });
            if (items.length === 0) return null;
            return (
              <div key={group.section} className="nav-group">
                <p className="nav-section">{group.section}</p>
                {items.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`nav-link ${isActive(route.path, item) ? 'nav-link-active' : ''}`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <Link to="/account" className="nav-link">
            <span className="nav-user">
              <span className="nav-avatar" aria-hidden="true">
                {(me?.user.first_name ?? me?.user.email ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <span>
                <span className="nav-email">{displayName(me?.user)}</span>
                <span className="nav-role">
                  {roleLabel(me?.user.role)}
                </span>
              </span>
            </span>
          </Link>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Выйти
          </Button>
        </div>
      </aside>

      <div className="app-main">
        {me?.impersonation ? (
          <div className="impersonation-banner">
            <span>
              Вы вошли как <strong>{displayName(me.user)}</strong> ({me.user.email}). Действия
              выполняются от имени этого пользователя.
            </span>
            <Button
              size="sm"
              variant="ghost"
              busy={stoppingImpersonation}
              onClick={() => void stopImpersonation()}
            >
              Вернуться
            </Button>
          </div>
        ) : null}
        <header className="app-topbar">
          <button
            type="button"
            className="nav-toggle"
            aria-label="Меню"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((value) => !value)}
          >
            <span />
            <span />
            <span />
          </button>
          <p className="topbar-title">{activeTitle}</p>
          <div className="topbar-actions">
            <NotificationBell />
            <Link to="/account" className="topbar-user">
              {displayName(me?.user)}
            </Link>
          </div>
        </header>

        <main className="app-content">{page}</main>
      </div>
    </div>
  );
}

function isActive(path: string, item: NavItem): boolean {
  if (item.exact) return path === item.to;
  return path === item.to || path.startsWith(`${item.to}/`);
}

function RedirectTo({ to }: { to: string }) {
  useEffect(() => {
    navigate(to);
  }, [to]);
  return (
    <div className="boot">
      <Spinner label="Открываем роутеры…" />
    </div>
  );
}

function renderRoute(
  segments: string[],
  canManageUsers: boolean,
  canManageSettings: boolean,
  canManageRouters: boolean,
) {
  const [first, second] = segments;

  if (!first) return <DashboardPage />;

  switch (first) {
    case 'routers':
      if (second === 'new') return <RouterOnboardingPage />;
      return second ? <RouterDetailPage id={second} /> : <RoutersPage />;
    case 'templates':
      if (!second || second === 'new') return <TemplatesPage />;
      return <TemplateEditorPage id={second} />;
    case 'subscriptions':
      return <SubscriptionsPage />;
    case 'jobs':
      return <JobsPage />;
    case 'apply-runs':
      return second ? <ApplyRunDetailPage id={second} /> : <ApplyRunsPage />;
    case 'monitoring':
      return <RedirectTo to="/routers" />;
    case 'diagnostics':
      return second ? <DiagnosticDetailPage id={second} /> : <DiagnosticsPage />;
    case 'singbox':
      return <RedirectTo to="/rollouts" />;
    case 'rollouts':
      return second ? <RolloutDetailPage id={second} /> : <RolloutsPage />;
    case 'account':
      return <AccountPage />;
    case 'users':
      return canManageUsers ? <UsersPage /> : <ManagerOnly />;
    case 'settings':
      return canManageSettings ? <SettingsPage /> : <SuperadminOnly />;
    case 'deploy':
      return canManageRouters ? <DeployPage /> : <ManagerOnly />;
    case 'audit':
      return canManageSettings ? <AuditPage /> : <SuperadminOnly />;
    default:
      return (
        <div className="page">
          <Empty>
            Страница не найдена. <Link to="/">Вернуться на панель</Link>.
          </Empty>
        </div>
      );
  }
}

function SuperadminOnly() {
  return (
    <div className="page">
      <Empty>
        Раздел доступен только суперадминистратору. <Link to="/">На панель</Link>.
      </Empty>
    </div>
  );
}

function ManagerOnly() {
  return (
    <div className="page">
      <Empty>
        Раздел доступен администратору. <Link to="/">На панель</Link>.
      </Empty>
    </div>
  );
}

function NotificationBell() {
  const toast = useToast();
  const notifications = useApi<{ items: NotificationRow[]; unread: number }>(
    '/api/v1/notifications?limit=30',
  );
  const [open, setOpen] = useState(false);

  async function markAll(): Promise<void> {
    try {
      await api('/api/v1/notifications/read', { method: 'POST', body: { all: true } });
      await notifications.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function markOne(id: number): Promise<void> {
    try {
      await api('/api/v1/notifications/read', { method: 'POST', body: { ids: [id] } });
      await notifications.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.items ?? [];

  return (
    <div className="bell-wrap">
      <button
        type="button"
        className="bell"
        aria-label={`Уведомления${unread > 0 ? `, непрочитанных: ${unread}` : ''}`}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" />
          <path d="M10 18.5a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 ? <span className="bell-count">{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <>
          <div className="bell-backdrop" role="presentation" onClick={() => setOpen(false)} />
          <div className="bell-panel" role="dialog" aria-label="Уведомления">
            <header>
              <h3>Уведомления</h3>
              <div className="row">
                {unread > 0 ? (
                  <button type="button" className="link" onClick={() => void markAll()}>
                    Прочитать все
                  </button>
                ) : null}
                <button type="button" className="link" onClick={() => setOpen(false)}>
                  Закрыть
                </button>
              </div>
            </header>
            {notifications.loading && !notifications.data ? (
              <Spinner />
            ) : items.length === 0 ? (
              <Empty>Уведомлений нет.</Empty>
            ) : (
              <ul className="notification-list">
                {items.map((item) => (
                  <li key={item.id} className={item.read_at ? 'notification-read' : ''}>
                    <div className="notification-head">
                      <StatusBadge
                        status={item.severity === 'critical' ? 'failed' : item.severity}
                        label={SEVERITY[item.severity] ?? item.severity}
                      />
                      <span className="muted-text small">{formatRelative(item.created_at)}</span>
                    </div>
                    <p>{item.message}</p>
                    <div className="row">
                      {item.router_id ? (
                        <Link
                          to={`/routers/${item.router_id}`}
                          className="link"
                          onClick={() => setOpen(false)}
                        >
                          {item.router_name ?? 'Открыть роутер'}
                        </Link>
                      ) : null}
                      {!item.read_at ? (
                        <button type="button" className="link" onClick={() => void markOne(item.id)}>
                          Отметить прочитанным
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
