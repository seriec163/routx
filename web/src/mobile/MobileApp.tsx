import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MobileMark } from '../components/Logo';
import { Link } from '../components/link';
import { navigate, useRoute } from '../lib/router';
import { useApi } from '../lib/useApi';
import type { MonitoringItem, MonitoringOverview } from '../lib/types';
import './mobile.css';
import { HomeScreen } from './HomeScreen';
import { BypassScreen } from './BypassScreen';
import { RoutersScreen } from './RoutersScreen';
import { NotificationsHub } from './NotificationsSheet';
import { useNotificationToasts } from '../lib/notifications';
import { useSession } from '../session';
import { hapticTap } from './haptics';

const SELECTED_KEY = 'rc.mobile.router';

export interface MobileRouterGroup {
  id: string;
  label: string;
  items: MonitoringItem[];
}

export interface MobileState {
  routers: MonitoringItem[];
  routerGroups: MobileRouterGroup[];
  selected: MonitoringItem | null;
  selectedId: string | null;
  select: (id: string) => void;
  reload: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

const MobileContext = createContext<MobileState | null>(null);

export function useMobile(): MobileState {
  const value = useContext(MobileContext);
  if (!value) throw new Error('useMobile вне мобильного приложения');
  return value;
}

export function MobileApp() {
  const route = useRoute();
  useNotificationToasts();

  // Приложение занимает ровно экран, прокручивается только его содержимое.
  // Так страница не «уезжает» как обычный сайт и не тянется за границы.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.classList.add('routx-app-root');
    body.classList.add('routx-app-body');
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    html.classList.toggle('routx-standalone', standalone);

    // iOS PWA (особенно iOS 26) может отдавать 100dvh/100vh неверно.
    // Берём реально видимую высоту окна и фиксируем её для html/body.
    const applyHeight = () => {
      html.style.setProperty('--routx-app-height', `${window.innerHeight}px`);
    };
    applyHeight();
    window.addEventListener('resize', applyHeight);
    window.addEventListener('orientationchange', applyHeight);
    window.visualViewport?.addEventListener('resize', applyHeight);

    return () => {
      window.removeEventListener('resize', applyHeight);
      window.removeEventListener('orientationchange', applyHeight);
      window.visualViewport?.removeEventListener('resize', applyHeight);
      html.style.removeProperty('--routx-app-height');
      html.classList.remove('routx-standalone');
      html.classList.remove('routx-app-root');
      body.classList.remove('routx-app-body');
    };
  }, []);
  const overview = useApi<MonitoringOverview>('/api/v1/monitoring/overview');
  const { me } = useSession();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    window.localStorage.getItem(SELECTED_KEY),
  );

  const allRouters = useMemo(() => overview.data?.items ?? [], [overview.data]);
  const isAdmin = me?.permissions.is_superadmin === true;
  const currentUserId = me?.user.id ?? null;

  // Администратор видит все роутеры, но сначала свои, затем сгруппированные
  // по владельцам. Обычный пользователь получает с сервера только свои.
  const routerGroups = useMemo<MobileRouterGroup[]>(() => {
    if (allRouters.length === 0) return [];
    if (!isAdmin) return [{ id: 'own', label: 'Мои роутеры', items: allRouters }];

    const own: MonitoringItem[] = [];
    const byOwner = new Map<string, MonitoringItem[]>();
    for (const item of allRouters) {
      if (currentUserId && item.owner_id === currentUserId) {
        own.push(item);
        continue;
      }
      const key = item.owner_id ?? 'unknown';
      const list = byOwner.get(key) ?? [];
      list.push(item);
      byOwner.set(key, list);
    }

    const ownerLabel = (items: MonitoringItem[]): string =>
      items[0]?.owner_name?.trim() || items[0]?.owner_email || 'Без владельца';

    const groups: MobileRouterGroup[] = [];
    if (own.length > 0) groups.push({ id: 'own', label: 'Мои роутеры', items: own });
    for (const [id, items] of [...byOwner.entries()].sort((a, b) =>
      ownerLabel(a[1]).localeCompare(ownerLabel(b[1]), 'ru'),
    )) {
      groups.push({ id, label: ownerLabel(items), items });
    }
    return groups;
  }, [allRouters, isAdmin, currentUserId]);

  const routers = useMemo(() => routerGroups.flatMap((group) => group.items), [routerGroups]);

  // Выбранный роутер: сохранённый, иначе первый в сети.
  useEffect(() => {
    if (routers.length === 0) return;
    const known = routers.some((item) => item.id === selectedId);
    if (known) return;
    const fallback = routers.find((item) => item.status === 'online') ?? routers[0]!;
    setSelectedId(fallback.id);
  }, [routers, selectedId]);

  useEffect(() => {
    if (selectedId) window.localStorage.setItem(SELECTED_KEY, selectedId);
  }, [selectedId]);

  // Живое обновление статуса, пока приложение открыто.
  const reloadRef = useRef(overview.reload);
  reloadRef.current = overview.reload;
  useEffect(() => {
    const timer = window.setInterval(() => void reloadRef.current(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const reload = useCallback(async () => {
    await overview.reload();
  }, [overview]);

  const selected = routers.find((item) => item.id === selectedId) ?? null;

  const state: MobileState = {
    routers,
    routerGroups,
    selected,
    selectedId,
    select: setSelectedId,
    reload,
    loading: overview.loading,
    error: overview.error,
  };

  const section = route.segments[1] ?? 'home';
  const active = (
    section === 'bypass' || section === 'routers' ? section : 'home'
  ) as 'home' | 'bypass' | 'routers';
  const order = { home: 0, bypass: 1, routers: 2 } as const;
  const previous = useRef(active);
  const direction =
    previous.current === active ? 'none' : order[active] > order[previous.current] ? 'next' : 'prev';
  useEffect(() => {
    previous.current = active;
  }, [active]);

  return (
    <MobileContext.Provider value={state}>
      <div className="m-app">
        <div
          className={`m-view ${
            direction === 'next' ? 'm-view-next' : direction === 'prev' ? 'm-view-prev' : ''
          }`}
          key={active}
        >
          {active === 'home' ? <HomeScreen /> : null}
          {active === 'bypass' ? <BypassScreen /> : null}
          {active === 'routers' ? <RoutersScreen /> : null}
        </div>
        <nav className="m-bottomnav" aria-label="Разделы приложения">
          <BottomLink to="/app" label="Главная" icon="home" active={active === 'home'} />
          <BottomLink to="/app/bypass" label="Обход" icon="route" active={active === 'bypass'} />
          <BottomLink
            to="/app/routers"
            label="Роутеры"
            icon="router"
            active={active === 'routers'}
          />
        </nav>
      </div>
    </MobileContext.Provider>
  );
}

function BottomLink(props: {
  to: string;
  label: string;
  icon: 'home' | 'route' | 'router';
  active: boolean;
}) {
  return (
    <Link
      to={props.to}
      className={`m-navlink ${props.active ? 'm-navlink-active' : ''}`}
      aria-current={props.active ? 'page' : undefined}
      onClick={() => hapticTap()}
    >
      <NavIcon name={props.icon} />
      <span>{props.label}</span>
    </Link>
  );
}

function NavIcon({ name }: { name: 'home' | 'route' | 'router' }) {
  if (name === 'home') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />
      </svg>
    );
  }
  if (name === 'route') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 18c4 0 4-12 8-12h4" />
        <path d="m14 3 3 3-3 3" />
        <circle cx="5" cy="18" r="2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="8" width="18" height="9" rx="2.5" />
      <path d="M7 8V6.5M12 8V6M17 8V6.5M8 20h8" />
      <circle cx="7" cy="12.5" r="1" />
    </svg>
  );
}

/** Общая шапка экранов приложения. */
export function MobileHeader(props: {
  title?: string;
  back?: string;
  right?: ReactNode;
}) {
  return (
    <header className="m-header">
      {props.back ? (
        <button
          type="button"
          className="m-iconbtn"
          aria-label="Назад"
          onClick={() => navigate(props.back!)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>
      ) : (
        <MobileMark className="m-branddot" size={32} />
      )}
      <span className="m-header-title">{props.title ?? 'RoutX'}</span>
      <span className="m-header-right">
        <NotificationsHub />
        {props.right}
      </span>
    </header>
  );
}
