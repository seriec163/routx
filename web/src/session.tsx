import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, errorMessage } from './lib/api';
import { clearMobileBound, isMobileClient, markMobileBound } from './mobile/deviceId';

export interface SessionUser {
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'user';
  status: string;
  totp_enabled: boolean;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  parent_id?: string | null;
  created_at?: string;
  last_login_at?: string | null;
}

export interface Me {
  user: SessionUser;
  csrf_token: string | null;
  mfa_policy: 'all' | 'admins';
  enrollment_required: boolean;
  mfa_passed: boolean;
  impersonation: { by_id: string; by_email: string | null } | null;
  permissions: {
    is_superadmin: boolean;
    can_manage_routers: boolean;
    can_manage_users: boolean;
    can_manage_settings: boolean;
    can_rollout: boolean;
  };
}

interface SessionContextValue {
  me: Me | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<Me | null>;
  setMe: (me: Me | null) => void;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshAttempted = useRef(false);
  const inFlight = useRef<Promise<Me | null> | null>(null);

  const reload = useCallback((): Promise<Me | null> => {
    if (inFlight.current) return inFlight.current;

    const run = (async (): Promise<Me | null> => {
      try {
        let payload: Me;
        try {
          payload = await api<Me>('/api/v1/auth/me');
        } catch (caught) {
          const unauthorized = caught instanceof ApiError && caught.status === 401;
          if (!unauthorized || !isMobileClient() || refreshAttempted.current) throw caught;

          // Сессия истекла, но телефон привязан: пробуем восстановить
          // доступ по HttpOnly-cookie устройства без повторного QR.
          refreshAttempted.current = true;
          try {
            await api('/api/v1/mobile/refresh', { method: 'POST', body: {} });
            markMobileBound();
            refreshAttempted.current = false;
            payload = await api<Me>('/api/v1/auth/me');
          } catch {
            throw caught;
          }
        }

        setMe(payload);
        if (isMobileClient()) markMobileBound();
        refreshAttempted.current = false;
        setError(null);
        return payload;
      } catch (caught) {
        const message = errorMessage(caught);
        setMe(null);
        // 401 — это не ошибка, а обычное состояние «нужно войти».
        const unauthorized = caught instanceof ApiError && caught.status === 401;
        if (
          unauthorized ||
          message.toLowerCase().includes('вход') ||
          message.toLowerCase().includes('авториз')
        ) {
          setError(null);
        } else {
          setError(message);
        }
        return null;
      } finally {
        setLoading(false);
      }
    })();

    inFlight.current = run;
    void run.finally(() => {
      if (inFlight.current === run) inFlight.current = null;
    });
    return run;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Любой фоновой запрос, получивший 401, запускает одну общую проверку
  // сессии. Так PWA не залипает на «просроченных» данных.
  useEffect(() => {
    const handler = () => {
      void reload();
    };
    window.addEventListener('rc:unauthorized', handler);
    return () => window.removeEventListener('rc:unauthorized', handler);
  }, [reload]);

  const logout = useCallback(async () => {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Сессия могла уже истечь — это не мешает выйти локально.
    }
    clearMobileBound();
    // После явного выхода не восстанавливаем сессию автоматически.
    refreshAttempted.current = true;
    setMe(null);
    setError(null);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ me, loading, error, reload, setMe, logout }),
    [me, loading, error, reload, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession требует SessionProvider');
  return context;
}

export function canManageUsers(me: Me | null): boolean {
  return me?.permissions.can_manage_users === true;
}

export function canManageRouters(me: Me | null): boolean {
  return me?.permissions.can_manage_routers === true;
}

export function canManageSettings(me: Me | null): boolean {
  return me?.permissions.can_manage_settings === true;
}

/** Полное имя для интерфейса; e-mail — запасной вариант. */
export function displayName(user: SessionUser | null | undefined): string {
  const parts = [user?.last_name, user?.first_name, user?.middle_name].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  return parts.length > 0 ? parts.join(' ') : user?.email ?? '';
}

/** Имя и отчество для приветствия: «Артур Николаевич». */
export function greetingName(user: SessionUser | null | undefined): string {
  const parts = [user?.first_name, user?.middle_name].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  if (parts.length > 0) return parts.join(' ');
  return user?.email?.split('@')[0] ?? '';
}
