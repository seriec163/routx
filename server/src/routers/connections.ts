import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { assertOnline, getRouter, getRouterForMutation } from './service.js';
import { loadAccessibleSubscription } from '../subscriptions/service.js';
import {
  connectionSecretPreview,
  connectionValueFromSecret,
  createConnectionSecret,
  decodeConnectionSecret,
  type ConnectionProfileInput,
} from './connection-secret.js';

interface RouteContext {
  pool: Pool;
  masterKey: string;
}

const VLESS_RE = /^(vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\/\S+$/i;
const SUBSCRIPTION_RE = /^https?:\/\/\S+$/i;

const connectionSecretSchema = z
  .object({
    kind: z.enum(['subscription', 'vless']),
    host: z.string().trim().min(1).max(253),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    credential: z.string().trim().max(512).optional(),
    path: z.string().trim().max(1024).optional(),
    sni: z.string().trim().max(253).optional(),
    flow: z.string().trim().max(64).optional(),
    transport: z.enum(['tcp', 'ws', 'grpc', 'http']).optional(),
    security: z.enum(['none', 'tls']).optional(),
  })
  .strict();

function maskValue(value: string): string {
  const scheme = value.slice(0, value.indexOf('://') + 3);
  const tail = value.slice(-4);
  return `${scheme}••••••••${tail}`;
}

function validateValue(kind: 'subscription' | 'vless', value: string): string {
  const text = value.trim();
  if (text.length < 8 || text.length > 8192) {
    throw badRequest('invalid_connection', 'Ссылка пустая или слишком длинная');
  }
  if (kind === 'subscription') {
    if (!SUBSCRIPTION_RE.test(text)) {
      throw badRequest('invalid_subscription', 'Ссылка на подписку должна начинаться с http:// или https://');
    }
  } else if (!VLESS_RE.test(text)) {
    throw badRequest('invalid_vless', 'Поддерживаются ссылки vless://, vmess://, trojan://, ss://, hysteria2://, tuic://');
  }
  return text;
}

export async function registerRouterConnectionRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool, masterKey } = ctx;

  app.post(
    '/api/v1/connection-secrets',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      requireUser(request);
      const body = connectionSecretSchema.parse(request.body) as ConnectionProfileInput;
      const secret = createConnectionSecret(body, masterKey);
      const profile = decodeConnectionSecret(secret, masterKey);
      return {
        secret,
        length: secret.length,
        preview: connectionSecretPreview(profile),
      };
    },
  );

  app.post(
    '/api/v1/connection-secrets/decode',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      requireUser(request);
      const body = z
        .object({ secret: z.string().trim().min(10).max(4096) })
        .strict()
        .parse(request.body);
      const profile = decodeConnectionSecret(body.secret, masterKey);
      return { preview: connectionSecretPreview(profile) };
    },
  );

  app.get('/api/v1/routers/:id/connections', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    const result = await pool.query<{
      id: string;
      kind: 'subscription' | 'vless';
      label: string;
      secret_enc: string;
      compact_secret: string | null;
      enabled: boolean;
      subscription_id: string | null;
      catalog_name: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select c.id, c.kind, c.label, c.secret_enc, c.compact_secret, c.enabled, c.subscription_id,
              s.name as catalog_name, c.created_at, c.updated_at
         from router_connections c
         left join subscriptions s on s.id = c.subscription_id
        where c.router_id = $1
        order by c.created_at asc`,
      [params.id],
    );

    return {
      managed_section: router.managed_section ?? 'router_control',
      items: result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        masked: maskValue(decryptSecret(row.secret_enc, masterKey)),
        compact: Boolean(row.compact_secret),
        compact_length: row.compact_secret?.length ?? null,
        enabled: row.enabled,
        subscription_id: row.subscription_id,
        catalog_name: row.catalog_name,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
    };
  });

  app.post(
    '/api/v1/routers/:id/connections',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          kind: z.enum(['subscription', 'vless']),
          label: z.string().trim().min(1).max(120).optional(),
          value: z.string().trim().min(8).max(8192).optional(),
          secret: z.string().trim().min(10).max(4096).optional(),
          subscription_id: z.string().uuid().optional(),
        })
        .strict()
        .refine(
          (value) =>
            [value.value, value.secret, value.subscription_id].filter(Boolean).length === 1,
          {
            message: 'Укажите ссылку, компактный секрет или подписку из каталога',
          },
        )
        .parse(request.body);
      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      let value: string;
      let label: string;
      let catalogId: string | null = null;
      let compactSecret: string | null = null;
      if (body.subscription_id) {
        if (body.kind !== 'subscription') {
          throw badRequest('invalid_kind', 'Из каталога можно выбрать только подписку');
        }
        const catalog = await loadAccessibleSubscription(pool, auth, body.subscription_id);
        value = decryptSecret(catalog.secret_enc, masterKey);
        label = body.label ?? catalog.name;
        catalogId = catalog.id;
      } else {
        label = body.label ?? (body.kind === 'subscription' ? 'Подписка' : 'VLESS');
        if (body.secret) {
          compactSecret = body.secret;
        } else if (body.value!.startsWith('rc1.')) {
          compactSecret = body.value!;
        }
        value = compactSecret
          ? connectionValueFromSecret(compactSecret, body.kind, label, masterKey)
          : validateValue(body.kind, body.value!);
      }

      const id = uuidv7();
      try {
        await pool.query(
          `insert into router_connections
             (id, router_id, kind, label, secret_enc, compact_secret, enabled, created_by, subscription_id)
           values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
          [
            id,
            params.id,
            body.kind,
            label,
            encryptSecret(value, masterKey),
            compactSecret,
            auth.userId,
            catalogId,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('connection_label_taken', 'Подключение с таким названием уже существует');
        }
        throw error;
      }

      const job = await enqueueJob(pool, {
        type: 'connections_apply',
        routerId: params.id,
        requestedBy: auth.userId,
        payload: { reason: 'connection_add' },
        timeoutSeconds: 240,
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.connection_add',
        targetType: 'router_connection',
        targetId: id,
        routerId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          kind: body.kind,
          label,
          subscription_id: catalogId,
          compact_secret: Boolean(compactSecret),
          section: router.managed_section ?? 'router_control',
        },
      });

      reply.code(201);
      return { connection: { id }, job: jobJson(job) };
    },
  );

  app.patch(
    '/api/v1/routers/:id/connections/:connectionId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireUser(request);
      const params = z
        .object({ id: z.string().uuid(), connectionId: z.string().uuid() })
        .parse(request.params);
      const body = z
        .object({
          label: z.string().trim().min(1).max(120).optional(),
          value: z.string().trim().min(8).max(8192).optional(),
          secret: z.string().trim().min(10).max(4096).optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
        .refine((value) => !(value.value && value.secret), {
          message: 'Укажите ссылку или компактный секрет, но не оба сразу',
        })
        .parse(request.body);
      assertOnline(await getRouterForMutation(pool, auth, params.id));

      const existing = await pool.query<{ kind: 'subscription' | 'vless'; label: string }>(
        'select kind, label from router_connections where id = $1 and router_id = $2',
        [params.connectionId, params.id],
      );
      const row = existing.rows[0];
      if (!row) throw notFound('Подключение не найдено');

      const sets: string[] = [];
      const values: unknown[] = [];
      if (body.label !== undefined) {
        values.push(body.label);
        sets.push(`label = $${values.length}`);
      }
      const compactSecret =
        body.secret ?? (body.value?.startsWith('rc1.') ? body.value : null);
      if (compactSecret) {
        const nextLabel = body.label ?? row.label;
        values.push(
          encryptSecret(
            connectionValueFromSecret(compactSecret, row.kind, nextLabel, masterKey),
            masterKey,
          ),
        );
        sets.push(`secret_enc = $${values.length}`);
        values.push(compactSecret);
        sets.push(`compact_secret = $${values.length}`);
        sets.push('subscription_id = null');
      } else if (body.value !== undefined) {
        values.push(encryptSecret(validateValue(row.kind, body.value), masterKey));
        sets.push(`secret_enc = $${values.length}`);
        sets.push('compact_secret = null');
        sets.push('subscription_id = null');
      }
      if (body.enabled !== undefined) {
        values.push(body.enabled);
        sets.push(`enabled = $${values.length}`);
      }
      if (sets.length === 0) throw badRequest('empty_update', 'Нет полей для обновления');
      sets.push('updated_at = now()');
      values.push(params.connectionId, params.id);

      await pool.query(
        `update router_connections set ${sets.join(', ')}
          where id = $${values.length - 1} and router_id = $${values.length}`,
        values,
      );

      const job = await enqueueJob(pool, {
        type: 'connections_apply',
        routerId: params.id,
        requestedBy: auth.userId,
        payload: { reason: 'connection_update' },
        timeoutSeconds: 240,
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.connection_update',
        targetType: 'router_connection',
        targetId: params.connectionId,
        routerId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { fields: Object.keys(body) },
      });

      return { job: jobJson(job) };
    },
  );

  app.get('/api/v1/routers/:id/connections/:connectionId/secret', async (request) => {
    const auth = requireUser(request);
    const params = z
      .object({ id: z.string().uuid(), connectionId: z.string().uuid() })
      .parse(request.params);
    await getRouter(pool, auth, params.id);

    const result = await pool.query<{ compact_secret: string | null }>(
      'select compact_secret from router_connections where id = $1 and router_id = $2',
      [params.connectionId, params.id],
    );
    const row = result.rows[0];
    if (!row) throw notFound('Подключение не найдено');
    if (!row.compact_secret) {
      throw badRequest(
        'compact_secret_missing',
        'Для этого подключения сохранён обычный URL, а не компактный секрет',
      );
    }
    const profile = decodeConnectionSecret(row.compact_secret, masterKey);

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.connection_secret_view',
      targetType: 'router_connection',
      targetId: params.connectionId,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return {
      secret: row.compact_secret,
      length: row.compact_secret.length,
      preview: connectionSecretPreview(profile),
    };
  });

  app.delete('/api/v1/routers/:id/connections/:connectionId', async (request) => {
    const auth = requireUser(request);
    const params = z
      .object({ id: z.string().uuid(), connectionId: z.string().uuid() })
      .parse(request.params);
    assertOnline(await getRouterForMutation(pool, auth, params.id));

    const removed = await pool.query(
      'delete from router_connections where id = $1 and router_id = $2',
      [params.connectionId, params.id],
    );
    if ((removed.rowCount ?? 0) === 0) throw notFound('Подключение не найдено');

    const job = await enqueueJob(pool, {
      type: 'connections_apply',
      routerId: params.id,
      requestedBy: auth.userId,
      payload: { reason: 'connection_delete' },
      timeoutSeconds: 240,
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.connection_delete',
      targetType: 'router_connection',
      targetId: params.connectionId,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { job: jobJson(job) };
  });
}
