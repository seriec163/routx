import type { Pool } from 'pg';

export interface NotificationInput {
  userId: string;
  routerId?: string | null;
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  message: string;
  dedupeKey?: string | null;
}

/**
 * In-app уведомления. Внешние каналы отключены решением D-09:
 * пользователь видит события только в панели.
 */
export async function notify(pool: Pool, input: NotificationInput): Promise<void> {
  await pool.query(
    `insert into notifications (user_id, router_id, kind, severity, message, dedupe_key)
     values ($1,$2,$3,$4,$5,$6)
     on conflict do nothing`,
    [
      input.userId,
      input.routerId ?? null,
      input.kind,
      input.severity ?? 'info',
      input.message.slice(0, 500),
      input.dedupeKey ?? null,
    ],
  );
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
