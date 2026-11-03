import { badRequest } from '../lib/errors.js';

/**
 * Подписки Podkop не поддерживает, но поддерживает отдельные ссылки.
 * Скачиваем подписку на сервере, разбираем и сохраняем ссылки как
 * обычные подключения RoutX (они уходят агенту без URL подписки).
 */

const SUPPORTED_SCHEMES = new Set([
  'vless',
  'ss',
  'trojan',
  'hysteria2',
  'hy2',
  'socks',
  'socks4',
  'socks4a',
  'socks5',
  'socks5h',
]);

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINKS = 300;

export interface ParsedSubscription {
  links: string[];
  total: number;
  skipped: number;
  title: string | null;
}

function decodeProfileTitle(raw: string | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value === '') return null;
  try {
    if (/^base64:/i.test(value)) {
      value = Buffer.from(value.slice(7).trim(), 'base64').toString('utf8').trim();
    } else if (/^urlencoded:/i.test(value)) {
      value = decodeURIComponent(value.slice(11).trim());
    }
  } catch {
    // заголовок повреждён — используем как есть
  }
  return value === '' ? null : value.slice(0, 120);
}

export function isUnsupportedPodkopLink(link: string): boolean {
  const withoutFragment = link.split('#')[0] ?? '';
  const query = withoutFragment.split('?')[1];
  if (!query) return false;
  const params = new URLSearchParams(query);
  const type = (params.get('type') ?? '').toLowerCase();
  return type === 'httpupgrade' || type === 'xhttp' || type === 'splithttp';
}

function decodeBody(input: string): string {
  const text = input.replace(/^\uFEFF/, '').trim();
  if (text.includes('://')) return text;

  // Подписки часто отдают base64 (иногда URL-safe).
  if (/^[A-Za-z0-9+/_=\-\s]+$/.test(text)) {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    try {
      const decoded = Buffer.from(normalized, 'base64').toString('utf8');
      if (decoded.includes('://')) return decoded;
    } catch {
      // не base64 — разберём как обычный текст
    }
  }
  return text;
}

function linesOf(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      // не JSON, идём дальше
    }
  }
  return text.split(/\r?\n/);
}

export function parseSubscriptionBody(body: string): ParsedSubscription {
  const text = decodeBody(body);
  const links: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const raw of linesOf(text)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!line.includes('://')) {
      skipped++;
      continue;
    }
    const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      skipped++;
      continue;
    }
    if (isUnsupportedPodkopLink(line)) {
      skipped++;
      continue;
    }
    if (seen.has(line)) continue;
    if (links.length >= MAX_LINKS) {
      skipped++;
      continue;
    }
    seen.add(line);
    links.push(line);
  }

  if (links.length === 0) {
    throw badRequest(
      'subscription_no_links',
      'В подписке не найдено поддерживаемых Podkop ссылок (vless, ss, trojan, hysteria2, socks)',
    );
  }
  return { links, total: links.length + skipped, skipped, title: null };
}

export async function fetchSubscription(url: string): Promise<ParsedSubscription> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    throw badRequest('invalid_subscription', 'Ссылка на подписку должна начинаться с http:// или https://');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'RoutX/1.0 subscription importer',
        accept: 'text/plain, application/octet-stream, */*',
      },
    });
    if (!response.ok) {
      throw badRequest(
        'subscription_fetch_failed',
        `Подписка вернула HTTP ${response.status}`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) {
      throw badRequest('subscription_too_large', 'Ответ подписки слишком большой');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
      throw badRequest('subscription_too_large', 'Ответ подписки слишком большой');
    }
    return {
      ...parseSubscriptionBody(body),
      title: decodeProfileTitle(response.headers.get('profile-title')),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw badRequest('subscription_timeout', 'Подписка не ответила за 20 секунд');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
