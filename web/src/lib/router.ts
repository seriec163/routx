import { useCallback, useEffect, useState } from 'react';

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parse(hash: string, fallbackPath = ''): Route {
  // Хеш-роутер. Если ссылку открыли как /invite?token=… или /reset-password/…,
  // хеша нет — берём путь и query из адресной строки, чтобы старые ссылки
  // и прямые ссылки на сброс/приглашение продолжали работать.
  const raw = hash.replace(/^#/, '') || fallbackPath || '/';
  const [pathname = '/', search = ''] = raw.split('?');
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return {
    path,
    segments: path.split('/').filter(Boolean),
    query: new URLSearchParams(search),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parse(window.location.hash, `${window.location.pathname}${window.location.search}`),
  );

  useEffect(() => {
    const onChange = (): void =>
      setRoute(
        parse(window.location.hash, `${window.location.pathname}${window.location.search}`),
      );
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === target) return;
  if (options.replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function useNavigate(): (to: string, options?: { replace?: boolean }) => void {
  return useCallback(navigate, []);
}

export function linkTo(path: string): string {
  return `#${path}`;
}
