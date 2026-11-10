import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireSuperadmin } from '../auth/service.js';
import { badRequest } from '../lib/errors.js';
import { loadSettings, updateSetting } from '../settings.js';

interface RouteContext {
  pool: Pool;
}

const limitsSchema = z
  .object({
    routers_per_user: z.coerce.number().int().min(1).max(1000).optional(),
    users_per_instance: z.coerce.number().int().min(1).max(1000).optional(),
    routers_per_instance: z.coerce.number().int().min(1).max(5000).optional(),
    batch_size: z.coerce.number().int().min(1).max(50).optional(),
    templates_per_user: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const monitoringSchema = z
  .object({
    interval_seconds: z.coerce.number().int().min(30).max(600).optional(),
    offline_after_misses: z.coerce.number().int().min(2).max(20).optional(),
    latency_degraded_ms: z.coerce.number().int().min(100).max(30_000).optional(),
    stagger_seconds: z.coerce.number().int().min(0).max(120).optional(),
    degraded_after_samples: z.coerce.number().int().min(2).max(20).optional(),
    degraded_cooldown_minutes: z.coerce.number().int().min(30).max(10_080).optional(),
    recovery_notify: z.boolean().optional(),
  })
  .strict();

const retentionSchema = z
  .object({
    days: z.coerce.number().int().min(1).max(30).optional(),
    commands_days: z.coerce.number().int().min(1).max(7).optional(),
    snapshots_local: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const agentSchema = z
  .object({
    poll_hold_seconds: z.coerce.number().int().min(1).max(25).optional(),
    command_ttl_read_seconds: z.coerce.number().int().min(15).max(600).optional(),
    command_ttl_mutate_seconds: z.coerce.number().int().min(60).max(3600).optional(),
    min_version: z.string().max(40).optional(),
  })
  .strict();

const singboxSchema = z
  .object({
    user_install: z.boolean().optional(),
    user_cooldown_hours: z.coerce.number().int().min(1).max(720).optional(),
    staged_rollout: z.enum(['superadmin', 'off']).optional(),
  })
  .strict();

const featuresSchema = z
  .object({
    mtls: z.boolean().optional(),
    logread: z.boolean().optional(),
    auto_reconcile: z.boolean().optional(),
    api_tokens: z.boolean().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    mfa_policy: z.enum(['all', 'admins']).optional(),
    session_days: z.coerce.number().int().min(1).max(365).optional(),
    limits: limitsSchema.optional(),
    monitoring: monitoringSchema.optional(),
    retention: retentionSchema.optional(),
    agent: agentSchema.optional(),
    singbox: singboxSchema.optional(),
    features: featuresSchema.optional(),
  })
  .strict();

const RAW_KEYS = ['limits', 'monitoring', 'retention', 'agent', 'singbox', 'features'] as const;

// Таблицы, в которых RoutX хранит журналы, историю и отчёты. Размер
// считается по pg_total_relation_size, включая индексы и TOAST.
const LOG_TABLES = [
  'audit_log',
  'jobs',
  'job_events',
  'agent_commands',
  'monitoring_samples',
  'monitoring_rollups',
  'diagnostics_reports',
  'agent_reports',
  'notifications',
  'router_snapshots',
  'apply_runs',
  'apply_items',
  'connection_edits',
  'rollouts',
  'rollout_targets',
] as const;

export async function registerSettingsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/settings', async (request) => {
    requireSuperadmin(request);
    const raw = await pool.query<{ key: string; value: Record<string, unknown>; updated_at: Date }>(
      `select key, value, updated_at from settings
        where key in ('security.mfa_policy','security.session_days','limits','monitoring',
                      'retention','agent','singbox','features')
        order by key`,
    );
    return { effective: await loadSettings(pool), values: raw.rows };
  });

  // Сколько места занимают журналы и история в PostgreSQL. Сырые логи
  // контейнера Docker сюда не входят: они лежат вне базы и смотрятся
  // через `docker compose logs`.
  app.get('/api/v1/settings/storage', async (request) => {
    requireSuperadmin(request);
    const [tables, database, settings] = await Promise.all([
      pool.query<{ name: string; bytes: string; rows: string }>(
        `select c.relname as name,
                pg_total_relation_size(c.oid)::text as bytes,
                coalesce(s.n_live_tup, 0)::text as rows
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           left join pg_stat_user_tables s on s.relid = c.oid
          where n.nspname = 'public'
            and c.relname = any($1::text[])
          order by pg_total_relation_size(c.oid) desc`,
        [LOG_TABLES],
      ),
      pool.query<{ bytes: string }>(
        'select pg_database_size(current_database())::text as bytes',
      ),
      loadSettings(pool),
    ]);
    const items = tables.rows.map((row) => ({
      name: row.name,
      bytes: Number(row.bytes) || 0,
      rows: Number(row.rows) || 0,
    }));
    return {
      generated_at: new Date().toISOString(),
      database_bytes: Number(database.rows[0]?.bytes ?? 0) || 0,
      log_bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      tables: items,
      retention: settings.retention,
    };
  });

  app.patch('/api/v1/settings', async (request) => {
    const auth = requireSuperadmin(request);
    const body = patchSchema.parse(request.body);

    if (!body.mfa_policy && !body.session_days && RAW_KEYS.every((key) => !body[key])) {
      throw badRequest('empty_update', 'Нет изменений');
    }

    const current = await pool.query<{ key: string; value: Record<string, unknown> }>(
      'select key, value from settings where key = any($1::text[])',
      [['limits', 'monitoring', 'retention', 'agent', 'singbox', 'features']],
    );
    const existing = new Map(current.rows.map((row) => [row.key, row.value ?? {}]));

    if (body.mfa_policy) {
      await updateSetting(pool, 'security.mfa_policy', { value: body.mfa_policy }, auth.userId);
    }
    if (body.session_days) {
      await updateSetting(pool, 'security.session_days', { value: body.session_days }, auth.userId);
    }

    for (const key of RAW_KEYS) {
      const patch = body[key];
      if (!patch) continue;
      const merged = { ...(existing.get(key) ?? {}), ...patch };
      await updateSetting(pool, key, merged, auth.userId);
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'settings.update',
      targetType: 'settings',
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: body,
    });

    return { effective: await loadSettings(pool) };
  });
}
