import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import {
  listSubscriptionAccess,
  loadAccessibleSubscription,
  loadManagedSubscription,
  maskSubscriptionUrl,
  replaceSubscriptionAccess,
  subscriptionShareCandidates,
  type SubscriptionRow,
} from './service.js';

interface RouteContext {
  pool: Pool;
  masterKey: string;
}

const SUBSCRIPTION_RE = /^https?:\/\/\S+$/i;

function validateValue(value: string): string {
  const text = value.trim();
  if (text.length < 8 || text.length > 8192) {
    throw badRequest('invalid_subscription', 'РЎСЃС‹Р»РєР° РЅР° РїРѕРґРїРёСЃРєСѓ РїСѓСЃС‚Р°СЏ РёР»Рё СЃР»РёС€РєРѕРј РґР»РёРЅРЅР°СЏ');
  }
  if (!SUBSCRIPTION_RE.test(text)) {
    throw badRequest('invalid_subscription', 'РЎСЃС‹Р»РєР° РґРѕР»Р¶РЅР° РЅР°С‡РёРЅР°С‚СЊСЃСЏ СЃ http:// РёР»Рё https://');
  }
  return text;
}

function subscriptionJson(row: SubscriptionRow, callerId: string, role: string, masterKey: string) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    owner_email: row.owner_email,
    name: row.name,
    description: row.description,
    masked: maskSubscriptionUrl(decryptSecret(row.secret_enc, masterKey)),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    is_owner: row.owner_id === callerId,
    can_manage: role === 'superadmin' || row.owner_id === callerId,
  };
}

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool, masterKey } = ctx;

  app.get('/api/v1/subscriptions', async (request) => {
    const auth = requireUser(request);
    const result = await pool.query<SubscriptionRow & { shared_with_count: number }>(
      `select s.*, u.email as owner_email,
              (select count(*)::int from subscription_access a where a.subscription_id = s.id) as shared_with_count
         from subscriptions s join users u on u.id = s.owner_id
        where ($1::boolean
               or s.owner_id = $2
               or exists (select 1 from subscription_access a
                           where a.subscription_id = s.id and a.user_id = $2))
        order by s.updated_at desc
        limit 500`,
      [auth.role === 'superadmin', auth.userId],
    );

    return {
      items: result.rows.map((row) => ({
        ...subscriptionJson(row, auth.userId, auth.role, masterKey),
        shared_with_count: row.shared_with_count,
      })),
    };
  });

  app.post(
    '/api/v1/subscriptions',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = z
        .object({
          name: z.string().trim().min(1).max(120),
          description: z.string().trim().max(2000).optional().nullable(),
          value: z.string().trim().min(8).max(8192),
        })
        .strict()
        .parse(request.body);

      const value = validateValue(body.value);
      const id = uuidv7();
      try {
        await pool.query(
          `insert into subscriptions (id, owner_id, name, description, secret_enc)
           values ($1,$2,$3,$4,$5)`,
          [id, auth.userId, body.name, body.description ?? null, encryptSecret(value, masterKey)],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('subscription_name_taken', 'РџРѕРґРїРёСЃРєР° СЃ С‚Р°РєРёРј РЅР°Р·РІР°РЅРёРµРј СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚');
        }
        throw error;
      }

      const row = await loadManagedSubscription(pool, auth, id);

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'subscription.create',
        targetType: 'subscription',
        targetId: id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { name: body.name },
      });

      reply.code(201);
      return { subscription: subscriptionJson(row, auth.userId, auth.role, masterKey) };
    },
  );

  app.get('/api/v1/subscriptions/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadAccessibleSubscription(pool, auth, params.id);
    const canManage = auth.role === 'superadmin' || row.owner_id === auth.userId;

    return {
      subscription: subscriptionJson(row, auth.userId, auth.role, masterKey),
      access: canManage ? await listSubscriptionAccess(pool, row.id) : undefined,
    };
  });

  app.patch(
    '/api/v1/subscriptions/:id',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          description: z.string().trim().max(2000).nullable().optional(),
          value: z.string().trim().min(8).max(8192).optional(),
        })
        .strict()
        .parse(request.body);

      await loadManagedSubscription(pool, auth, params.id);

      const sets: string[] = [];
      const values: unknown[] = [params.id];
      if (body.name !== undefined) {
        values.push(body.name);
        sets.push(`name = $${values.length}`);
      }
      if (body.description !== undefined) {
        values.push(body.description);
        sets.push(`description = $${values.length}`);
      }
      if (body.value !== undefined) {
        values.push(encryptSecret(validateValue(body.value), masterKey));
        sets.push(`secret_enc = $${values.length}`);
      }
      if (sets.length === 0) throw badRequest('empty_update', 'РќРµС‚ РёР·РјРµРЅРµРЅРёР№');

      try {
        await pool.query(
          `update subscriptions set ${sets.join(', ')}, updated_at = now() where id = $1`,
          values,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('subscription_name_taken', 'РџРѕРґРїРёСЃРєР° СЃ С‚Р°РєРёРј РЅР°Р·РІР°РЅРёРµРј СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚');
        }
        throw error;
      }

      const row = await loadManagedSubscription(pool, auth, params.id);

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'subscription.update',
        targetType: 'subscription',
        targetId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { fields: Object.keys(body) },
      });

      return { subscription: subscriptionJson(row, auth.userId, auth.role, masterKey) };
    },
  );

  app.delete('/api/v1/subscriptions/:id', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadManagedSubscription(pool, auth, params.id);

    await pool.query('delete from subscriptions where id = $1', [params.id]);

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'subscription.delete',
      targetType: 'subscription',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { name: row.name },
    });

    reply.code(204);
  });

  app.get('/api/v1/subscriptions/:id/access', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadManagedSubscription(pool, auth, params.id);
    return { items: await listSubscriptionAccess(pool, row.id) };
  });

  app.get('/api/v1/subscriptions/:id/share-candidates', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadManagedSubscription(pool, auth, params.id);
    return { items: await subscriptionShareCandidates(pool, row.owner_id) };
  });

  app.put('/api/v1/subscriptions/:id/access', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ user_ids: z.array(z.string().uuid()).max(100) })
      .strict()
      .parse(request.body);
    const row = await loadManagedSubscription(pool, auth, params.id);

    const access = await replaceSubscriptionAccess(pool, row.id, row.owner_id, body.user_ids);

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'subscription.access_update',
      targetType: 'subscription',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { users: body.user_ids.length },
    });

    return { items: access };
  });
}

