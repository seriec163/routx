export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    request_id?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

type ActivityListener = (count: number) => void;
let activeRequests = 0;
const activityListeners = new Set<ActivityListener>();

function notifyActivity(): void {
  for (const listener of activityListeners) listener(activeRequests);
}

/**
 * Подписка на количество запросов в полёте. Нужна для общей полосы
 * «что-то происходит», чтобы пользователь видел реакцию на любое действие.
 */
export function subscribeActivity(listener: ActivityListener): () => void {
  activityListeners.add(listener);
  listener(activeRequests);
  return () => {
    activityListeners.delete(listener);
  };
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('rc_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  activeRequests += 1;
  notifyActivity();
  try {
    const response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { code: 'invalid_response', message: text.slice(0, 300) } };
      }
    }

    if (!response.ok) {
      const body = (payload ?? {}) as ApiErrorBody;
      if (response.status === 401) {
        const pathname = new URL(path, window.location.origin).pathname;
        // Сами auth- и mobile-маршруты обрабатывают 401 локально;
        // для остальных API просим SessionProvider перепроверить сессию.
        const silent =
          pathname.startsWith('/api/v1/auth/') || pathname.startsWith('/api/v1/mobile/');
        if (!silent) window.dispatchEvent(new Event('rc:unauthorized'));
      }
      throw new ApiError(
        response.status,
        body.error?.code ?? `http_${response.status}`,
        body.error?.message ?? `Запрос завершился с кодом ${response.status}`,
        body.error?.details,
        body.error?.request_id ?? response.headers.get('x-request-id') ?? undefined,
      );
    }

    return payload as T;
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    notifyActivity();
  }
}

/** Скачивание двоичного ответа с корректной ошибкой в формате API. */
export async function apiDownload(
  path: string,
  options: RequestOptions & { filenameHint?: string } = {},
): Promise<{ filename: string; size: number }> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('rc_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  activeRequests += 1;
  notifyActivity();
  try {
    const response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      const body = (payload ?? {}) as ApiErrorBody;
      throw new ApiError(
        response.status,
        body.error?.code ?? `http_${response.status}`,
        body.error?.message ?? `Запрос завершился с кодом ${response.status}`,
        body.error?.details,
        body.error?.request_id ?? response.headers.get('x-request-id') ?? undefined,
      );
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? options.filenameHint ?? 'routx-backup.bin';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { filename, size: blob.size };
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    notifyActivity();
  }
}

/** Отправка двоичного тела (файл переноса) на сервер. */
export async function apiUploadBinary<T>(
  path: string,
  body: Blob,
  headers: Record<string, string> = {},
): Promise<T> {
  const csrf = readCookie('rc_csrf');
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/octet-stream',
    accept: 'application/json',
    ...headers,
  };
  if (csrf) requestHeaders['x-csrf-token'] = csrf;

  activeRequests += 1;
  notifyActivity();
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: requestHeaders,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { code: 'invalid_response', message: text.slice(0, 300) } };
      }
    }

    if (!response.ok) {
      const errorBody = (payload ?? {}) as ApiErrorBody;
      throw new ApiError(
        response.status,
        errorBody.error?.code ?? `http_${response.status}`,
        errorBody.error?.message ?? `Запрос завершился с кодом ${response.status}`,
        errorBody.error?.details,
        errorBody.error?.request_id ?? response.headers.get('x-request-id') ?? undefined,
      );
    }

    return payload as T;
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    notifyActivity();
  }
}

export async function apiText(path: string): Promise<string> {
  activeRequests += 1;
  notifyActivity();
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new ApiError(response.status, 'http_error', 'Не удалось скачать файл');
    return response.text();
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    notifyActivity();
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Неизвестная ошибка';
}

export function downloadText(filename: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
