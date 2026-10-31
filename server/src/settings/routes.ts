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
