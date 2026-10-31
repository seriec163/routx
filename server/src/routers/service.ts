import type { Pool } from 'pg';
import { conflict, forbidden, notFound } from '../lib/errors.js';

export interface RouterRecord {
  id: string;
  owner_id: string;
  owner_email?: string;
  name: string;
  product: string;
  product_version: string | null;
  agent_version: string | null;
  manifest_version: number | null;
  openwrt_version: string | null;
  arch: string | null;
  model: string | null;
  sing_box_version: string | null;
  sing_box_variant: string | null;
  sing_box_previous_version?: string | null;
  sing_box_previous_variant?: string | null;
  sing_box_installed_at?: Date | null;
  status: string;
  last_seen_at: Date | null;
  last_poll_at: Date | null;
  last_error: string | null;
  offline_after_misses: number;
  monitoring_enabled: boolean;
  managed_section?: string;
  list_extras?: Record<string, unknown>;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Caller {
  userId: string;
  role: 'superadmin' | 'user';
}

export function routerJson(row: RouterRecord) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    owner_email: row.owner_email,
    name: row.name,
    product: row.product,
    product_version: row.product_version,
    agent_version: row.agent_version,
    manifest_version: row.manifest_version,
    openwrt_version: row.openwrt_version,
    arch: row.arch,
    model: row.model,
    sing_box_version: row.sing_box_version,
    sing_box_variant: row.sing_box_variant,
    sing_box_previous_version: row.sing_box_previous_version ?? null,
    sing_box_previous_variant: row.sing_box_previous_variant ?? null,
    sing_box_installed_at: row.sing_box_installed_at?.toISOString() ?? null,
    status: row.status,
    last_seen_at: row.last_seen_at?.toISOString() ?? null,
    last_error: row.last_error,
    monitoring_enabled: row.monitoring_enabled,
    managed_section: row.managed_section ?? 'router_control',
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function getRouter(
  pool: Pool,
  caller: Caller,
  routerId: string,
): Promise<RouterRecord> {
  const result = await pool.query<RouterRecord>(
    `select r.*, u.email as owner_email
       from routers r join users u on u.id = r.owner_id
      where r.id = $1`,
    [routerId],
  );
  const router = result.rows[0];
  if (!router) throw notFound('Роутер не найден');
  if (caller.role !== 'superadmin' && router.owner_id !== caller.userId) {
    throw notFound('Роутер не найден');
  }
  return router;
}

export async function getRouterForMutation(
  pool: Pool,
  caller: Caller,
  routerId: string,
): Promise<RouterRecord> {
  const router = await getRouter(pool, caller, routerId);
  if (router.archived_at) throw forbidden('Роутер архивирован');
  if (router.status === 'conflict' || router.product === 'conflict') {
    throw conflict(
      'router_conflict',
      'На роутере одновременно обнаружены Forkop и Prokop. Изменения запрещены до устранения конфликта.',
    );
  }
  if (router.status === 'unsupported') {
    throw conflict('unsupported_platform', 'Платформа роутера не поддерживается для записи');
  }
  return router;
}

export function assertOnline(router: RouterRecord): void {
  if (router.status !== 'online') {
    throw conflict(
      'router_offline',
      router.status === 'pending'
        ? 'Роутер ещё не подключался к серверу'
        : 'Роутер не в сети — команда не может быть доставлена',
    );
  }
}
