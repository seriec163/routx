import type { Pool } from 'pg';
import { sendPushToUser } from './push.js';

export interface NotificationInput {
  userId: string;
  routerId?: string | null;
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  message: string;
  dedupeKey?: string | null;
}

interface InsertedNotification {
  id: string;
  user_id: string;
  router_id: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  router_name: string | null;
}

/**
 * In-app уведомление + Web Push в установленные PWA и браузеры пользователя.
 * Push не является обязательным: если сервер не настроен, событие всё равно
 * сохраняется в истории уведомлений.
 */
export async function notify(pool: Pool, input: NotificationInput): Promise<void> {
  const result = await pool.query<InsertedNotification>(
    `with inserted as (
       insert into notifications (user_id, router_id, kind, severity, message, dedupe_key)
       values ($1,$2,$3,$4,$5,$6)
       on conflict do nothing
       returning id, user_id, router_id, kind, severity, message
     )
     select i.id, i.user_id, i.router_id, i.kind, i.severity, i.message, r.name as router_name
       from inserted i left join routers r on r.id = i.router_id`,
    [
      input.userId,
      input.routerId ?? null,
      input.kind,
      input.severity ?? 'info',
      input.message.slice(0, 500),
      input.dedupeKey ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) return;

  // Историю сохранили; push отправляем в фоне, чтобы не задерживать
  // ответ агенту или выполнение задачи из-за медленного push-сервиса.
  void sendPushToUser(row.user_id, {
    title: row.router_name ?? 'RoutX',
    body: row.message,
    url: '/#/app',
    tag: `routx-${row.kind}`,
    severity: row.severity,
  }).catch(() => undefined);
}

export async function notifyRouterOwner(
  pool: Pool,
  routerId: string,
  input: Omit<NotificationInput, 'userId' | 'routerId'>,
): Promise<void> {
  const result = await pool.query<{ owner_id: string }>(
    'select owner_id from routers where id = $1',
    [routerId],
  );
  const owner = result.rows[0];
  if (!owner) return;
  await notify(pool, { ...input, userId: owner.owner_id, routerId });
}
