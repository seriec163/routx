import type { Pool } from 'pg';
import { badRequest, notFound } from '../lib/errors.js';
import type { Caller } from '../routers/service.js';

export interface SubscriptionRow {
  id: string;
  owner_id: string;
  owner_email?: string;
  name: string;
  description: string | null;
  secret_enc: string;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionAccessRow {
  id: string;
  email: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
}

export function maskSubscriptionUrl(value: string): string {
  const scheme = value.slice(0, value.indexOf('://') + 3);
  const tail = value.slice(-4);
  return `${scheme}••••••••${tail}`;
}

/** Подписка доступна владельцу, получателю доступа или супер-администратору. */
export async function loadAccessibleSubscription(
  pool: Pool,
  caller: Caller,
  id: string,
): Promise<SubscriptionRow> {
  const result = await pool.query<SubscriptionRow>(
    `select s.*, u.email as owner_email
       from subscriptions s join users u on u.id = s.owner_id
      where s.id = $1
        and ($2::boolean
             or s.owner_id = $3
             or exists (select 1 from subscription_access a
                         where a.subscription_id = s.id and a.user_id = $3))`,
    [id, caller.role === 'superadmin', caller.userId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Подписка не найдена');
  return row;
}

/** Подписку можно менять и раздавать только владельцу (или супер-администратору). */
export async function loadManagedSubscription(
  pool: Pool,
  caller: Caller,
  id: string,
): Promise<SubscriptionRow> {
  const result = await pool.query<SubscriptionRow>(
    `select s.*, u.email as owner_email
       from subscriptions s join users u on u.id = s.owner_id
      where s.id = $1 and ($2::boolean or s.owner_id = $3)`,
    [id, caller.role === 'superadmin', caller.userId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Подписка не найдена');
  return row;
}

export async function listSubscriptionAccess(
  pool: Pool,
  subscriptionId: string,
): Promise<SubscriptionAccessRow[]> {
  const result = await pool.query<SubscriptionAccessRow>(
    `select u.id, u.email, u.first_name, u.middle_name, u.last_name
       from subscription_access a join users u on u.id = a.user_id
      where a.subscription_id = $1
      order by u.email`,
    [subscriptionId],
  );
  return result.rows;
}

export async function replaceSubscriptionAccess(
  pool: Pool,
  subscriptionId: string,
  ownerId: string,
  userIds: string[],
): Promise<SubscriptionAccessRow[]> {
  const unique = [...new Set(userIds)].filter((id) => id !== ownerId);
  if (unique.length > 100) throw badRequest('too_many_users', 'Слишком много пользователей');

  if (unique.length > 0) {
    const found = await pool.query<{ id: string }>(
      `select id from users where id = any($1::uuid[]) and status = 'active'`,
      [unique],
    );
    if ((found.rowCount ?? 0) !== unique.length) {
      throw badRequest('invalid_user', 'Один из выбранных пользователей не найден или заблокирован');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from subscription_access where subscription_id = $1', [
      subscriptionId,
    ]);
    for (const userId of unique) {
      await client.query(
        'insert into subscription_access (subscription_id, user_id) values ($1,$2)',
        [subscriptionId, userId],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return listSubscriptionAccess(pool, subscriptionId);
}

export async function subscriptionShareCandidates(
  pool: Pool,
  ownerId: string,
): Promise<SubscriptionAccessRow[]> {
  const result = await pool.query<SubscriptionAccessRow>(
    `select id, email, first_name, middle_name, last_name
       from users
      where status = 'active' and id <> $1
      order by email
      limit 500`,
    [ownerId],
  );
  return result.rows;
}
