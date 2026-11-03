const SCANNED_KEY = 'rc.mobile.scanned';
const SELECTED_KEY = 'rc.mobile.router';

function normalize(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(SCANNED_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    window.localStorage.setItem(SCANNED_KEY, JSON.stringify(ids));
  } catch {
    // localStorage может быть недоступен в приватном режиме.
  }
}

/**
 * PWA показывает только роутеры, которые пользователь добавил на этом
 * телефоне через QR или ссылку. Аккаунт в панели может видеть больше.
 */
export function readScannedRouterIds(): string[] {
  const ids = read();
  if (ids.length > 0) return ids;

  // Переход с прошлых версий: роутер уже выбран после сканирования.
  try {
    const selected = window.localStorage.getItem(SELECTED_KEY);
    if (selected) {
      write([selected]);
      return [selected];
    }
  } catch {
    // ignore
  }
  return [];
}

export function rememberScannedRouter(routerId: string): string[] {
  const id = routerId.trim();
  if (id === '') return read();
  const next = normalize([...read(), id]);
  write(next);
  return next;
}
