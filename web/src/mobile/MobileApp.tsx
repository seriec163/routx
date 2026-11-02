import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LogoMark } from '../components/Logo';
import { Link } from '../components/link';
import { navigate, useRoute } from '../lib/router';
import { useApi } from '../lib/useApi';
import type { MonitoringItem, MonitoringOverview } from '../lib/types';
import './mobile.css';
import { HomeScreen } from './HomeScreen';
import { BypassScreen } from './BypassScreen';
import { RoutersScreen } from './RoutersScreen';
import { useNotificationToasts } from '../lib/notifications';

const SELECTED_KEY = 'rc.mobile.router';

export interface MobileState {
  routers: MonitoringItem[];
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
  const overview = useApi<MonitoringOverview>('/api/v1/monitoring/overview');
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    window.localStorage.getItem(SELECTED_KEY),
  );

  const routers = useMemo(() => overview.data?.items ?? [], [overview.data]);

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
    selected,
    selectedId,
    select: setSelectedId,
    reload,
    loading: overview.loading,
    error: overview.error,
  };

  const section = route.segments[1] ?? 'home';
  const active = section === 'bypass' || section === 'routers' ? section : 'home';

  return (
    <MobileContext.Provider value={state}>
      <div className="m-app">
        {active === 'home' ? <HomeScreen /> : null}
        {active === 'bypass' ? <BypassScreen /> : null}
        {active === 'routers' ? <RoutersScreen /> : null}
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
        <LogoMark className="m-branddot" size={32} />
      )}
      <span className="m-header-title">{props.title ?? 'RoutX'}</span>
      <span className="m-header-right">{props.right}</span>
    </header>
  );
}
