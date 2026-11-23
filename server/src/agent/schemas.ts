import { z } from 'zod';

/**
 * Схемы протокола агента. Вынесены из маршрутов, чтобы их можно было
 * генерировать в OpenAPI и использовать в тестах/эмуляторе агента.
 */

export const probeSchema = z
  .object({
    agent_version: z.string().max(40).optional(),
    product: z.enum(['forkop', 'prokop', 'podkop', 'tachyon', 'unknown', 'conflict']).optional(),
    product_version: z.string().max(60).nullable().optional(),
    conflict: z.boolean().optional(),
    manifest_version: z.coerce.number().int().nonnegative().nullable().optional(),
    openwrt: z.string().max(60).nullable().optional(),
    arch: z.string().max(60).nullable().optional(),
    model: z.string().max(120).nullable().optional(),
    sing_box_version: z.string().max(60).nullable().optional(),
    sing_box_variant: z.string().max(40).nullable().optional(),
    platform_state: z.enum(['ok', 'unsupported', 'conflict']).optional(),
    installed_products: z
      .array(
        z.object({
          product: z.enum(['forkop', 'prokop', 'podkop', 'tachyon']),
          version: z.string().max(60).nullable().optional(),
          packages: z.array(z.string().max(80)).max(20).optional(),
        }),
      )
      .max(10)
      .optional(),
    last_error: z.string().max(500).nullable().optional(),
    health: z.record(z.string(), z.unknown()).optional(),
    service: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    managed: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const bindSchema = z
  .object({
    token: z.string().min(20).max(64),
    product: z.enum(['forkop', 'prokop', 'podkop', 'tachyon', 'unknown', 'conflict']).optional(),
    agent_version: z.string().max(40).optional(),
    hardware: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const resultSchema = z
  .object({
    status: z.enum(['success', 'failed', 'cancelled', 'timeout']),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().max(80).optional(), message: z.string().max(1000).optional() })
      .nullable()
      .optional(),
  })
  .strict();

export const reportSchema = z
  .object({
    kind: z.enum(['quick', 'full']),
    product: z.string().max(40),
    agent_version: z.string().max(40).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    body: z.string().min(1).max(4 * 1024 * 1024),
    job_id: z.string().uuid().optional(),
  })
  .strict();
