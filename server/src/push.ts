import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import webPush from 'web-push';
import type { PushSubscription, VapidKeys } from 'web-push';

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  severity?: 'info' | 'warning' | 'critical';
}

interface PushLogger {
  info: (obj: unknown, message?: string) => void;
  warn: (obj: unknown, message?: string) => void;
}

export interface PushInitOptions {
  pool: Pool;
  dataDir?: string;
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  log?: PushLogger;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const VAPID_FILE = 'vapid.json';
const DEFAULT_SUBJECT = 'mailto:admin@example.com';

function validKeys(value: unknown): value is VapidKeys {
  if (!value || typeof value !== 'object') return false;
  const item = value as { publicKey?: unknown; privateKey?: unknown };
  return (
    typeof item.publicKey === 'string' &&
    item.publicKey.length > 20 &&
    typeof item.privateKey === 'string' &&
    item.privateKey.length > 20
  );
}

/**
 * Ключи VAPID должны переживать перезапуск контейнера: иначе все
 * существующие подписки станут недействительными. Порядок:
 * переменные окружения → файл в /app/data → новая пара.
 */
function loadVapidKeys(options: PushInitOptions): VapidKeys {
  const publicKey = options.publicKey?.trim();
  const privateKey = options.privateKey?.trim();
  if (publicKey && privateKey) return { publicKey, privateKey };

  const dir = options.dataDir?.trim();
  const file = dir ? path.join(dir, VAPID_FILE) : null;

  if (file && existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (validKeys(parsed)) return parsed;
      options.log?.warn({ file }, 'файл ключей Web Push повреждён — создаём новый');
    } catch (error) {
      options.log?.warn({ err: error, file }, 'не удалось прочитать ключи Web Push');
    }
  }

  const keys = webPush.generateVAPIDKeys();
  if (!file) {
    options.log?.warn({}, 'каталог данных недоступен — ключи Web Push живут до перезапуска');
    return keys;
  }

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    chmodSync(file, 0o600);
    options.log?.info({ file }, 'созданы ключи Web Push');
  } catch (error) {
    options.log?.warn(
      { err: error, file },
      'не удалось сохранить ключи Web Push — после перезапуска подписки потребуют повтора',
    );
  }
  return keys;
}

export class PushService {
  readonly publicKey: string;
  readonly enabled = true;
  private readonly pool: Pool;
  private readonly log?: PushLogger;

  constructor(pool: Pool, keys: VapidKeys, subject: string, log?: PushLogger) {
    this.pool = pool;
    this.publicKey = keys.publicKey;
    this.log = log;
    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  }

  /** Отправляет push во все браузеры пользователя. Ошибки не всплывают наружу. */
  async sendToUser(userId: string, payload: PushNotificationPayload): Promise<void> {
    let subscriptions: SubscriptionRow[];
    try {
      const result = await this.pool.query<SubscriptionRow>(
        'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
        [userId],
      );
      subscriptions = result.rows;
    } catch (error) {
      this.log?.warn({ err: error, userId }, 'не удалось прочитать подписки Web Push');
      return;
    }

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? '/#/app',
      tag: payload.tag ?? 'routx',
      severity: payload.severity ?? 'info',
    });

    for (const row of subscriptions) {
      const subscription: PushSubscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await webPush.sendNotification(subscription, body, {
          TTL: 60 * 60,
          urgency: payload.severity === 'critical' ? 'high' : 'normal',
        });
        await this.pool.query(
          `update push_subscriptions
              set last_success_at = now(), last_error = null, last_error_at = null
            where id = $1`,
          [row.id],
        );
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        // 404/410 — браузер отозвал подписку, хранить её больше нет смысла.
        if (statusCode === 404 || statusCode === 410) {
          await this.pool
            .query('delete from push_subscriptions where id = $1', [row.id])
            .catch(() => undefined);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        await this.pool
          .query(
            `update push_subscriptions
                set last_error = $2, last_error_at = now()
              where id = $1`,
            [row.id, message.slice(0, 300)],
          )
          .catch(() => undefined);
        this.log?.warn({ err: error, userId }, 'не удалось отправить Web Push');
      }
    }
  }
}

let activeService: PushService | null = null;

export function initPushService(options: PushInitOptions): PushService | null {
  try {
    const keys = loadVapidKeys(options);
    activeService = new PushService(
      options.pool,
      keys,
      options.subject?.trim() || DEFAULT_SUBJECT,
      options.log,
    );
    return activeService;
  } catch (error) {
    options.log?.warn({ err: error }, 'Web Push недоступен');
    activeService = null;
    return null;
  }
}

export function getPushService(): PushService | null {
  return activeService;
}

export function resetPushService(): void {
  activeService = null;
}

/** Точка входа для notify(): тихо ничего не делает, если push не настроен. */
export async function sendPushToUser(
  userId: string,
  payload: PushNotificationPayload,
): Promise<void> {
  if (!activeService) return;
  await activeService.sendToUser(userId, payload);
}
