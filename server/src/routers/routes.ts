import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { assertOnline, getRouter, getRouterForMutation, routerJson } from './service.js';
import { createBindingToken, rotateRouterCredential } from './binding.js';
import { loadSettings } from '../settings.js';
import { productCatalog, type ProductId } from '../domain/product-catalog.js';
import {
  applySectionMap,
  CONNECTION_ACTIONS,
  mapTemplateSections,
  sanitizeAgentState,
  templatePayloadSchema,
  templateToDesired,
  validateExclusions,
} from '../domain/uci.js';
import { hashCanonical } from '../lib/crypto.js';

interface RouteContext {
  pool: Pool;
  publicUrl: string;
}

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    owner_id: z.string().uuid().optional(),
    product_hint: z.enum(['any', 'forkop', 'prokop', 'podkop', 'tachyon']).default('any'),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    monitoring_enabled: z.boolean().optional(),
  })
  .strict();

function idempotencyKey(request: { headers: Record<string, unknown>; auth?: { userId: string } }, value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) return null;
  return `${request.auth?.userId ?? 'anon'}:${value}`;
}

export async function registerRouterRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/routers', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({
        include_archived: z.enum(['true', 'false']).optional(),
        scope: z.enum(['own', 'branch']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const includeArchived = query.include_archived === 'true';
    const branch = auth.role === 'admin' && query.scope === 'branch';

    const result = await pool.query(
      `select r.*, u.email as owner_email
         from routers r join users u on u.id = r.owner_id
        where (
                $1::uuid is null
                or r.owner_id = $1
                or ($2::boolean and r.owner_id in (select id from users where parent_id = $1))
              )
          and ($3::boolean or r.archived_at is null)
        order by r.created_at desc
        limit $4`,
      [
        auth.role === 'superadmin' ? null : auth.userId,
        branch,
        includeArchived,
        query.limit,
      ],
    );

    return { items: result.rows.map(routerJson) };
  });

  app.post(
    '/api/v1/routers',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = createSchema.parse(request.body);
      const settings = await loadSettings(pool);
      const ownerId = auth.role === 'superadmin' && body.owner_id ? body.owner_id : auth.userId;

      if (ownerId !== auth.userId) {
        const owner = await pool.query('select 1 from users where id = $1 and status = $2', [
          ownerId,
          'active',
        ]);
        if (!owner.rows[0]) throw badRequest('owner_not_found', 'Владелец не найден');
      }

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtext('routx:routers'))");

        const ownerCount = await client.query<{ count: string }>(
          'select count(*)::text as count from routers where owner_id = $1 and archived_at is null',
          [ownerId],
        );
        if (Number(ownerCount.rows[0]?.count ?? 0) >= settings.limits.routersPerUser) {
          throw badRequest(
            'limit_reached',
            `Достигнут лимит роутеров на пользователя (${settings.limits.routersPerUser})`,
          );
        }
        const total = await client.query<{ count: string }>(
          'select count(*)::text as count from routers where archived_at is null',
        );
        if (Number(total.rows[0]?.count ?? 0) >= settings.limits.routersPerInstance) {
          throw badRequest(
            'limit_reached',
            `Достигнут лимит роутеров на инстансе (${settings.limits.routersPerInstance})`,
          );
        }

        const id = uuidv7();
        const inserted = await client.query(
          `insert into routers (id, owner_id, name, status, offline_after_misses)
           values ($1,$2,$3,'pending',$4)
           returning *`,
          [id, ownerId, body.name, settings.monitoring.offlineAfterMisses],
        );
        await client.query('commit');

        await audit(pool, {
          actorId: auth.userId,
          actorRole: auth.role,
          action: 'router.create',
          targetType: 'router',
          targetId: id,
          result: 'ok',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { name: body.name, owner_id: ownerId },
        });

        reply.code(201);
        return { router: routerJson(inserted.rows[0]) };
      } catch (error) {
        await client.query('rollback');
        if ((error as { code?: string }).code === '23505') {
          throw conflict('router_name_taken', 'Роутер с таким именем уже существует у владельца');
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get('/api/v1/router-sections', async (request) => {
    const auth = requireUser(request);

    // Состояние уже прошло sanitizeAgentState на сервере: секретов здесь нет.
    const state = await pool.query<{
      id: string;
      name: string;
      managed: Record<string, unknown> | null;
    }>(
      `select r.id, r.name, s.managed
         from routers r
         join router_state s on s.router_id = r.id
        where r.archived_at is null
          and ($1::uuid is null or r.owner_id = $1)
        order by r.name asc`,
      [auth.role === 'superadmin' ? null : auth.userId],
    );

    interface SectionAccumulator {
      name: string;
      action: string | null;
      label: string | null;
      enabled: string | null;
      values: Record<string, string | string[]>;
      routers: Array<{ id: string; name: string }>;
    }

    const sections = new Map<string, SectionAccumulator>();
    const other = {
      urltest: new Set<string>(),
      section_interface: new Set<string>(),
      subscription_url: new Set<string>(),
    };

    for (const router of state.rows) {
      const managed = router.managed ?? {};
      const local = new Map<string, Record<string, string | string[]>>();

      for (const [path, raw] of Object.entries(managed)) {
        if (raw === null || raw === undefined) continue;
        const match = /^section\.([A-Za-z0-9_.-]{1,64})\.([A-Za-z0-9_]{1,64})$/.exec(path);
        if (match) {
          const value = Array.isArray(raw)
            ? raw.map(String)
            : typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
              ? String(raw)
              : null;
          if (value === null) continue;
          const name = match[1]!;
          const options = local.get(name) ?? {};
          options[match[2]!] = value;
          local.set(name, options);
          continue;
        }
        const group = /^(urltest|section_interface|subscription_url)\.([A-Za-z0-9_.-]{1,64})\./.exec(
          path,
        );
        if (group) other[group[1] as keyof typeof other].add(group[2]!);
      }

      for (const [name, values] of local) {
        const section = sections.get(name) ?? {
          name,
          action: null,
          label: null,
          enabled: null,
          values: {},
          routers: [],
        };
        if (!section.routers.some((entry) => entry.id === router.id)) {
          section.routers.push({ id: router.id, name: router.name });
        }
        // Для редактора берём самый полный набор значений одного роутера,
        // а не смесь разных конфигураций.
        if (Object.keys(values).length > Object.keys(section.values).length) {
          section.values = values;
          if (typeof values.action === 'string') section.action = values.action;
          if (typeof values.label === 'string') section.label = values.label;
          if (typeof values.enabled === 'string') section.enabled = values.enabled;
        }
        sections.set(name, section);
      }
    }

    return {
      routers: state.rows.map((row) => ({ id: row.id, name: row.name })),
      sections: [...sections.values()].sort((a, b) => a.name.localeCompare(b.name)),
      other: {
        urltest: [...other.urltest].sort(),
        section_interface: [...other.section_interface].sort(),
        subscription_url: [...other.subscription_url].sort(),
      },
    };
  });

  app.get('/api/v1/routers/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);

    const [state, assignments] = await Promise.all([
      pool.query(
        'select managed, state_hash, health, service, capabilities, collected_at, source from router_state where router_id = $1',
        [params.id],
      ),
      pool.query(
        `select a.router_id, a.template_id, a.revision, a.desired_hash, a.applied_hash, a.applied_at, a.drift,
                a.section_map, t.name as template_name
           from template_assignments a join templates t on t.id = a.template_id
          where a.router_id = $1 and t.archived_at is null`,
        [params.id],
      ),
    ]);

    return {
      router: routerJson(router),
      state: state.rows[0]
        ? {
            managed: state.rows[0].managed,
            state_hash: state.rows[0].state_hash,
            health: state.rows[0].health,
            service: state.rows[0].service,
            capabilities: state.rows[0].capabilities,
            collected_at: state.rows[0].collected_at?.toISOString() ?? null,
            source: state.rows[0].source,
          }
        : null,
      assignments: assignments.rows,
    };
  });

  app.patch('/api/v1/routers/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = patchSchema.parse(request.body);
    const router = await getRouter(pool, auth, params.id);
    if (router.archived_at) throw forbidden('Роутер архивирован');

    const updated = await pool.query(
      `update routers set
          name = coalesce($2, name),
          monitoring_enabled = coalesce($3, monitoring_enabled),
          updated_at = now()
        where id = $1 returning *`,
      [params.id, body.name ?? null, body.monitoring_enabled ?? null],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.update',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: body,
    });

    return { router: routerJson(updated.rows[0]) };
  });

  app.delete('/api/v1/routers/:id', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ purge: z.enum(['true', 'false']).optional() }).parse(request.query);
    const router = await getRouter(pool, auth, params.id);

    if (query.purge === 'true') {
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.purge',
        targetType: 'router',
        targetId: params.id,
        routerId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { name: router.name, product: router.product, archived: Boolean(router.archived_at) },
      });

      await pool.query('delete from routers where id = $1', [params.id]);
      reply.code(204);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update routers set archived_at = now(), status = 'offline', monitoring_enabled = false, updated_at = now()
          where id = $1`,
        [params.id],
      );
      await client.query(
        'update router_credentials set revoked_at = now() where router_id = $1',
        [params.id],
      );
      await client.query(
        `update jobs set status = 'cancelled', finished_at = now(), error_code = 'router_archived'
          where router_id = $1 and status = 'queued'`,
        [params.id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.archive',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    reply.code(204);
  });

  app.post('/api/v1/routers/:id/restore', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    if (!router.archived_at) throw conflict('router_not_archived', 'Роутер не находится в архиве');

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update routers set archived_at = null, status = 'pending', monitoring_enabled = true,
                last_error = null, updated_at = now()
          where id = $1`,
        [params.id],
      );
      // Возвращаем тот же токен: агент на роутере сможет подключиться без переустановки.
      await client.query('update router_credentials set revoked_at = null where router_id = $1', [
        params.id,
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.restore',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { ok: true };
  });

  app.post('/api/v1/routers/:id/binding-token', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    if (router.archived_at) throw forbidden('Роутер архивирован');

    const token = await createBindingToken(pool, {
      routerId: router.id,
      createdBy: auth.userId,
      productHint:
        router.product === 'forkop' ||
        router.product === 'prokop' ||
        router.product === 'podkop' ||
        router.product === 'tachyon'
          ? router.product
          : 'any',
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.binding_token',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    const productArg =
      router.product === 'forkop' ||
      router.product === 'prokop' ||
      router.product === 'podkop' ||
      router.product === 'tachyon'
        ? ` --product ${router.product}`
        : '';
    const command = `wget -qO- ${ctx.publicUrl}/agent/install.sh | sh -s -- --server ${ctx.publicUrl} --token ${token.token}${productArg} --reboot`;

    return {
      token: token.token,
      expires_at: token.expires_at.toISOString(),
      server_url: ctx.publicUrl,
      install_command: command,
      warning: 'Токен одноразовый, действует 5 минут и показывается только один раз.',
    };
  });

  app.post('/api/v1/routers/:id/rotate-credential', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    const credential = await rotateRouterCredential(pool, router.id);

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.rotate_credential',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { prefix: credential.prefix },
    });

    return {
      token: credential.token,
      prefix: credential.prefix,
      overlap_seconds: 600,
      warning:
        'Новый токен показывается один раз. Установите его на роутер; старый продолжит работать 10 минут.',
    };
  });

  app.post('/api/v1/routers/:id/transfer', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ owner_id: z.string().uuid() }).strict().parse(request.body);
    const router = await getRouter(pool, auth, params.id);
    if (auth.role === 'user') {
      throw forbidden('Передача роутера доступна только администратору');
    }
    if (auth.role === 'admin') {
      // Администратор передаёт свои роутеры только себе или пользователям
      // своей ветки, чтобы не управлять чужими учётными записями.
      const allowed = await pool.query(
        'select 1 from users where id = $1 and (id = $2 or parent_id = $2)',
        [body.owner_id, auth.userId],
      );
      if (!allowed.rows[0]) {
        throw forbidden('Можно передать роутер только пользователю своей ветки');
      }
    }

    const settings = await loadSettings(pool);
    const target = await pool.query('select id from users where id = $1 and status = $2', [
      body.owner_id,
      'active',
    ]);
    if (!target.rows[0]) throw badRequest('owner_not_found', 'Новый владелец не найден');

    const count = await pool.query<{ count: string }>(
      'select count(*)::text as count from routers where owner_id = $1 and archived_at is null',
      [body.owner_id],
    );
    if (Number(count.rows[0]?.count ?? 0) >= settings.limits.routersPerUser) {
      throw badRequest('limit_reached', 'У нового владельца достигнут лимит роутеров');
    }

    await pool.query('update routers set owner_id = $2, updated_at = now() where id = $1', [
      router.id,
      body.owner_id,
    ]);
    // Шаблоны принадлежат пользователям: назначения старого владельца больше не видны.
    await pool.query('delete from template_assignments where router_id = $1', [router.id]);

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.transfer',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { from: router.owner_id, to: body.owner_id },
    });

    return { ok: true };
  });

  app.get('/api/v1/routers/:id/state', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);
    const result = await pool.query(
      'select managed, state_hash, health, service, capabilities, collected_at, source from router_state where router_id = $1',
      [params.id],
    );
    return { state: result.rows[0] ?? null };
  });

  app.post('/api/v1/routers/:id/refresh', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const job = await enqueueJob(pool, {
      type: 'refresh_state',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 90,
      idempotencyKey: idempotencyKey(request, request.headers['idempotency-key']),
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.refresh',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.post('/api/v1/routers/:id/diff', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ template_id: z.string().uuid(), revision: z.coerce.number().int().positive().optional() })
      .strict()
      .parse(request.body);

    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const template = await pool.query<{
      id: string;
      owner_id: string;
      current_revision: number;
      archived_at: Date | null;
      shared: boolean;
    }>('select id, owner_id, current_revision, archived_at, shared from templates where id = $1', [
      body.template_id,
    ]);
    const tpl = template.rows[0];
    if (!tpl) throw notFound('Шаблон не найден');
    if (auth.role !== 'superadmin' && tpl.owner_id !== auth.userId && !tpl.shared) {
      throw notFound('Шаблон не найден');
    }
    if (tpl.archived_at) throw badRequest('template_archived', 'Шаблон архивирован');

    const revision = body.revision ?? tpl.current_revision;
    const revisionRow = await pool.query<{
      payload: Record<string, unknown>;
      exclusions: string[];
      desired_hash?: string;
    }>(
      'select payload, exclusions from template_revisions where template_id = $1 and revision = $2',
      [tpl.id, revision],
    );
    if (!revisionRow.rows[0]) throw notFound('Ревизия шаблона не найдена');

    const assignment = await pool.query<{ section_map: Record<string, string> | null }>(
      'select section_map from template_assignments where router_id = $1 and template_id = $2',
      [router.id, tpl.id],
    );

    const job = await enqueueJob(pool, {
      type: 'diff',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 120,
      idempotencyKey: idempotencyKey(request, request.headers['idempotency-key']),
      payload: {
        template_id: tpl.id,
        revision,
        name: (request.body as { name?: string }).name ?? null,
        payload: revisionRow.rows[0].payload,
        exclusions: revisionRow.rows[0].exclusions,
        section_map: assignment.rows[0]?.section_map ?? null,
      },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.diff',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { template_id: tpl.id, revision, job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.post(
    '/api/v1/routers/:id/access-check',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          target: z.string().url().max(2048).optional(),
        })
        .strict()
        .parse(request.body ?? {});

      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      const job = await enqueueJob(pool, {
        type: 'access_check',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 90,
        maxAttempts: 1,
        idempotencyKey: `access_check:${router.id}:${Date.now()}`,
        payload: { target: body.target ?? null },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.access_check',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { target: body.target ?? null, job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.put('/api/v1/routers/:id/templates/:templateId', async (request) => {
    const auth = requireUser(request);
    const params = z
      .object({ id: z.string().uuid(), templateId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        revision: z.coerce.number().int().positive().optional(),
        section_map: z.record(z.string().max(64), z.string().max(64)).optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const router = await getRouter(pool, auth, params.id);
    if (router.archived_at) throw forbidden('Роутер архивирован');

    const tpl = await pool.query<{
      current_revision: number;
      owner_id: string;
      archived_at: Date | null;
      shared: boolean;
    }>('select current_revision, owner_id, archived_at, shared from templates where id = $1', [params.templateId]);
    const template = tpl.rows[0];
    if (!template) throw notFound('Шаблон не найден');
    if (auth.role !== 'superadmin' && template.owner_id !== auth.userId && !template.shared) {
      throw notFound('Шаблон не найден');
    }
    if (template.archived_at) throw badRequest('template_archived', 'Шаблон архивирован');

    const revision = body.revision ?? template.current_revision;
    const payloadRow = await pool.query<{ payload: unknown; exclusions: string[] }>(
      'select payload, exclusions from template_revisions where template_id = $1 and revision = $2',
      [params.templateId, revision],
    );
    if (!payloadRow.rows[0]) throw notFound('Ревизия шаблона не найдена');

    const payload = templatePayloadSchema.parse(payloadRow.rows[0].payload);
    const exclusions = validateExclusions(payloadRow.rows[0].exclusions ?? []);
    const stateRow = await pool.query<{ managed: unknown }>(
      'select managed from router_state where router_id = $1',
      [params.id],
    );
    const current = stateRow.rows[0]?.managed
      ? sanitizeAgentState(stateRow.rows[0].managed)
      : {};

    let sectionMap = body.section_map ?? {};
    let mappedPayload = payload;
    if (Object.keys(sectionMap).length > 0) {
      for (const [from, to] of Object.entries(sectionMap)) {
        if (!payload.sections[from]) {
          throw badRequest(
            'unknown_template_section',
            `В шаблоне нет секции «${from}», указанной в сопоставлении`,
          );
        }
        const exists = Object.keys(current).some((path) => path.startsWith(`section.${to}.`));
        if (!exists) {
          throw badRequest(
            'target_section_missing',
            `Секция «${to}» не найдена на роутере. Прочитайте состояние или создайте секцию.`,
          );
        }
      }
      mappedPayload = applySectionMap(payload, sectionMap);
    } else {
      const mapped = mapTemplateSections(payload, current);
      sectionMap = mapped.sectionMap;
      mappedPayload = mapped.payload;
    }

    const desired = templateToDesired(mappedPayload);
    const desiredHash = hashCanonical({
      payload: Object.fromEntries(desired),
      exclusions,
    });

    await pool.query(
      `insert into template_assignments
         (router_id, template_id, revision, desired_hash, section_map, drift)
       values ($1,$2,$3,$4,$5::jsonb,'unknown')
       on conflict (router_id, template_id) do update
         set revision = excluded.revision, desired_hash = excluded.desired_hash,
             section_map = excluded.section_map,
             drift = 'unknown', applied_hash = null, applied_at = null`,
      [params.id, params.templateId, revision, desiredHash, JSON.stringify(sectionMap)],
    );

    // Если шаблон привязан к существующей физической секции (например,
    // router_control → gga), RoutX должен писать подключения именно
    // в неё. Иначе появится вторая секция с тем же подключением. Берём
    // физическую секцию из уже сопоставленного payload, а не угадываем по
    // старому managed_section.
    const connectionTargets = Object.entries(mappedPayload.sections)
      .filter(
        ([, options]) =>
          typeof options.action === 'string' && CONNECTION_ACTIONS.has(options.action),
      )
      .map(([name]) => name);
    const currentManaged = router.managed_section ?? '';
    const targetManaged =
      connectionTargets.length === 1 ? connectionTargets[0]! : sectionMap[currentManaged];
    if (targetManaged && targetManaged !== currentManaged) {
      await pool.query(
        'update routers set managed_section = $2, updated_at = now() where id = $1',
        [params.id, targetManaged],
      );
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.managed_section_sync',
        targetType: 'router',
        targetId: params.id,
        routerId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { from: currentManaged, to: targetManaged, template_id: params.templateId },
      });
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.template_assign',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { template_id: params.templateId, revision, section_map: sectionMap },
    });

    return { ok: true, revision, desired_hash: desiredHash, section_map: sectionMap };
  });

  app.delete('/api/v1/routers/:id/templates/:templateId', async (request, reply) => {
    const auth = requireUser(request);
    const params = z
      .object({ id: z.string().uuid(), templateId: z.string().uuid() })
      .parse(request.params);
    await getRouter(pool, auth, params.id);
    await pool.query('delete from template_assignments where router_id = $1 and template_id = $2', [
      params.id,
      params.templateId,
    ]);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.template_unassign',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { template_id: params.templateId },
    });
    reply.code(204);
  });

  app.get('/api/v1/routers/:id/templates', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);
    const result = await pool.query(
      `select a.*, t.name as template_name, t.owner_id
         from template_assignments a join templates t on t.id = a.template_id
        where a.router_id = $1 and t.archived_at is null`,
      [params.id],
    );
    return { items: result.rows };
  });

  app.get('/api/v1/routers/:id/snapshots', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);
    const result = await pool.query(
      `select id, kind, external_id, reason, sha256, size_bytes, product_version, created_at, expires_at
         from router_snapshots where router_id = $1 order by created_at desc limit 100`,
      [params.id],
    );
    return {
      items: result.rows.map((row) => ({
        ...row,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at?.toISOString() ?? null,
      })),
    };
  });

  app.post('/api/v1/routers/:id/snapshot', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ reason: z.string().trim().max(120).optional() })
      .strict()
      .parse(request.body ?? {});
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const job = await enqueueJob(pool, {
      type: 'snapshot',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 180,
      idempotencyKey: idempotencyKey(request, request.headers['idempotency-key']),
      payload: { reason: body.reason ?? 'manual' },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.snapshot',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { job_id: job.id, reason: body.reason ?? 'manual' },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.post('/api/v1/routers/:id/snapshots/:snapshotId/restore', async (request, reply) => {
    const auth = requireUser(request);
    const params = z
      .object({ id: z.string().uuid(), snapshotId: z.string().uuid() })
      .parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const snapshot = await pool.query(
      'select id from router_snapshots where id = $1 and router_id = $2',
      [params.snapshotId, router.id],
    );
    if (!snapshot.rows[0]) throw notFound('Снимок не найден');

    const job = await enqueueJob(pool, {
      type: 'restore',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 600,
      idempotencyKey: idempotencyKey(request, request.headers['idempotency-key']),
      payload: { snapshot_id: params.snapshotId },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.restore',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { snapshot_id: params.snapshotId, job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.post('/api/v1/routers/:id/service', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ action: z.enum(['restart', 'start', 'stop', 'enable', 'disable']) })
      .strict()
      .parse(request.body);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const job = await enqueueJob(pool, {
      type: 'service_action',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 180,
      idempotencyKey: idempotencyKey(request, request.headers['idempotency-key']),
      payload: { action: body.action },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.service_action',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { action: body.action, job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.get('/api/v1/routers/:id/product-catalog', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    const current =
      router.product === 'tachyon' ||
      router.product === 'forkop' ||
      router.product === 'podkop' ||
      router.product === 'prokop'
        ? { [router.product as ProductId]: router.product_version }
        : {};
    return { items: await productCatalog(current) };
  });

  // Смена продукта на роутере. Пока поддерживается установка Tachyon
  // поверх Podkop/Forkop/Prokop: официальный установщик сам удаляет
  // конфликтующие пакеты, сохраняя их конфиги для миграции.
  app.post(
    '/api/v1/routers/:id/product-switch',
    { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (auth.role === 'user') {
        throw forbidden('Смена продукта доступна только администратору');
      }
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          product: z.enum(['tachyon', 'forkop', 'podkop', 'prokop']),
          version: z
            .string()
            .trim()
            .regex(/^\d+(\.\d+){2,3}$/)
            .optional(),
        })
        .strict()
        .parse(request.body);
      const router = await getRouter(pool, auth, params.id);
      if (router.archived_at) throw forbidden('Роутер архивирован');
      // Смена продукта — единственная операция, которая может устранить
      // конфликт «оба продукта обнаружены». Поэтому status=conflict разрешён.
      if (router.status !== 'online' && router.status !== 'conflict') {
        throw conflict(
          'router_offline',
          router.status === 'pending'
            ? 'Роутер ещё не подключался к серверу'
            : 'Роутер не в сети — команда не может быть доставлена',
        );
      }

      const job = await enqueueJob(pool, {
        type: 'product_switch',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 1900,
        maxAttempts: 1,
        idempotencyKey: `product_switch:${router.id}:${body.product}:${body.version ?? 'latest'}:${Date.now()}`,
        payload: { product: body.product, version: body.version ?? null },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.product_switch',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          from: router.product,
          to: body.product,
          version: body.version ?? null,
          job_id: job.id,
        },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  // Удаление выбранных пакетов продуктов. Нужно, когда на роутере остались
  // пакеты от прошлых установок и пользователь хочет убрать их вручную.
  app.post(
    '/api/v1/routers/:id/packages/remove',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (auth.role === 'user') {
        throw forbidden('Удаление пакетов доступно только администратору');
      }
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ packages: z.array(z.string().trim().min(1).max(80)).min(1).max(30) })
        .strict()
        .parse(request.body);
      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      const job = await enqueueJob(pool, {
        type: 'remove_packages',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 360,
        maxAttempts: 1,
        idempotencyKey: `remove_packages:${router.id}:${body.packages.slice().sort().join(',')}:${Date.now()}`,
        payload: { packages: [...new Set(body.packages)] },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.packages_remove',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { packages: [...new Set(body.packages)], job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  // Перезагрузка самого роутера. Агент отвечает до reboot, поэтому задача
  // успевает завершиться; после перезагрузки связь восстанавливается сама.
  app.post(
    '/api/v1/routers/:id/reboot',
    { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      const job = await enqueueJob(pool, {
        type: 'reboot',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 60,
        idempotencyKey: `reboot:${router.id}:${Math.floor(Date.now() / 60_000)}`,
        payload: {},
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.reboot',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  // Заготовка для локального lab-теста без роутера: только чтение, без записи.
  app.get('/api/v1/routers/:id/credential-info', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);
    const result = await pool.query(
      'select token_prefix, created_at, rotated_at, expires_at, revoked_at from router_credentials where router_id = $1',
      [params.id],
    );
    return {
      credential: result.rows[0]
        ? {
            prefix: result.rows[0].token_prefix,
            created_at: result.rows[0].created_at?.toISOString(),
            rotated_at: result.rows[0].rotated_at?.toISOString() ?? null,
            revoked_at: result.rows[0].revoked_at?.toISOString() ?? null,
          }
        : null,
    };
  });

  void sha256Hex;
  void randomToken;
}
