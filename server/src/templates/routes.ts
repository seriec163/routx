import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { badRequest, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings } from '../settings.js';
import { getRouter } from '../routers/service.js';
import {
  buildPlan,
  presetFromPayload,
  templateInputSchema,
  templatePayloadSchema,
  templateToDesired,
  validateManualEntries,
  validateTemplateResources,
  type TemplateInput,
} from '../domain/uci.js';

interface RouteContext {
  pool: Pool;
}

function validate(input: TemplateInput) {
  validateTemplateResources(input.payload.resources);
  validateManualEntries(input.payload.manual_domains, input.payload.manual_ips);
  const plan = buildPlan(input.payload, input.exclusions);
  const desired = plan.desired;
  const exclusions = plan.exclusions;

  for (const path of exclusions) {
    if (desired.has(path)) {
      throw badRequest('conflicting_exclusion', `Параметр «${path}» задан и исключён одновременно`, {
        path,
      });
    }
  }

  return { desired, exclusions, desiredHash: plan.desiredHash, localLists: plan.localLists };
}

export async function registerTemplateRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/templates', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({ include_archived: z.enum(['true', 'false']).optional() })
      .parse(request.query);
    const includeArchived = query.include_archived === 'true';
    const result = await pool.query(
      `select t.id, t.owner_id, u.email as owner_email, t.name, t.description,
              t.schema_version, t.current_revision, t.shared,
              t.archived_at, t.created_at, t.updated_at,
              (select count(*)::int from template_assignments a where a.template_id = t.id) as assignment_count,
              tr.payload as payload
         from templates t
         join users u on u.id = t.owner_id
         left join template_revisions tr
           on tr.template_id = t.id and tr.revision = t.current_revision
        where ($1::uuid is null or t.owner_id = $1 or (t.shared and t.archived_at is null))
          and ($2::boolean or t.archived_at is null)
        order by t.updated_at desc`,
      [auth.role === 'superadmin' ? null : auth.userId, includeArchived],
    );
    return {
      items: result.rows.map((row) => {
        let preset = null;
        try {
          preset = presetFromPayload(templatePayloadSchema.parse(row.payload));
        } catch {
          preset = null;
        }
        return {
          ...row,
          payload: undefined,
          preset_action: preset?.action ?? null,
          preset_resources: preset ? Object.keys(preset.resources).length : 0,
        };
      }),
    };
  });

  app.post(
    '/api/v1/templates',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const input = templateInputSchema.parse(request.body);
      const { exclusions, desiredHash } = validate(input);
      const settings = await loadSettings(pool);

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtext('routx:templates'))");
        const count = await client.query<{ count: string }>(
          'select count(*)::text as count from templates where owner_id = $1 and archived_at is null',
          [auth.userId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= settings.limits.templatesPerUser) {
          throw badRequest(
            'limit_reached',
            `Достигнут лимит шаблонов на пользователя (${settings.limits.templatesPerUser})`,
          );
        }

        const id = uuidv7();
        const template = await client.query(
          `insert into templates (id, owner_id, name, description, current_revision)
           values ($1,$2,$3,$4,1) returning *`,
          [id, auth.userId, input.name, input.description ?? null],
        );
        await client.query(
          `insert into template_revisions (template_id, revision, payload, exclusions, created_by)
           values ($1, 1, $2::jsonb, $3::jsonb, $4)`,
          [id, JSON.stringify(input.payload), JSON.stringify(exclusions), auth.userId],
        );
        await client.query('commit');

        await audit(pool, {
          actorId: auth.userId,
          actorRole: auth.role,
          action: 'template.create',
          targetType: 'template',
          targetId: id,
          result: 'ok',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { name: input.name, paths: templateToDesired(input.payload).size },
        });

        reply.code(201);
        return {
          template: {
            ...template.rows[0],
            desired_hash: desiredHash,
            revision: 1,
            payload: input.payload,
            exclusions,
          },
        };
      } catch (error) {
        await client.query('rollback');
        if ((error as { code?: string }).code === '23505') {
          throw badRequest('template_name_taken', 'Шаблон с таким именем уже существует');
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get('/api/v1/templates/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `select t.*, u.email as owner_email
         from templates t join users u on u.id = t.owner_id
        where t.id = $1 and t.archived_at is null`,
      [params.id],
    );
    const template = result.rows[0];
    if (!template) throw notFound('Шаблон не найден');
    if (
      auth.role !== 'superadmin' &&
      template.owner_id !== auth.userId &&
      template.shared !== true
    ) {
      throw notFound('Шаблон не найден');
    }

    const revision = await pool.query(
      `select revision, payload, exclusions, created_by, created_at
         from template_revisions where template_id = $1 and revision = $2`,
      [params.id, template.current_revision],
    );

    const revisionRow = revision.rows[0];
    let preset = null;
    let presetError: string | null = null;
    if (revisionRow) {
      try {
        preset = presetFromPayload(templatePayloadSchema.parse(revisionRow.payload));
      } catch (error) {
        presetError = (error as Error).message.slice(0, 500);
      }
    }

    return {
      template: {
        ...template,
        revision: revisionRow?.revision,
        payload: revisionRow?.payload,
        exclusions: revisionRow?.exclusions,
        preset,
        preset_error: presetError,
      },
    };
  });

  app.patch('/api/v1/templates/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        shared: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);

    const found = await pool.query('select owner_id from templates where id = $1 and archived_at is null', [
      params.id,
    ]);
    if (!found.rows[0]) throw notFound('Шаблон не найден');
    if (auth.role !== 'superadmin' && found.rows[0].owner_id !== auth.userId) {
      throw notFound('Шаблон не найден');
    }

    const result = await pool.query(
      `update templates set
          name = coalesce($2,name),
          description = case when $3::boolean then $4 else description end,
          shared = coalesce($5::boolean, shared),
          updated_at = now()
        where id = $1 returning *`,
      [
        params.id,
        body.name ?? null,
        body.description !== undefined,
        body.description ?? null,
        body.shared ?? null,
      ],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'template.update',
      targetType: 'template',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: body,
    });

    return { template: result.rows[0] };
  });

  app.delete('/api/v1/templates/:id', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ purge: z.enum(['true', 'false']).optional() }).parse(request.query);
    const found = await pool.query(
      'select owner_id, name, archived_at from templates where id = $1',
      [params.id],
    );
    const template = found.rows[0];
    if (!template) throw notFound('Шаблон не найден');
    if (auth.role !== 'superadmin' && template.owner_id !== auth.userId) {
      throw notFound('Шаблон не найден');
    }

    if (query.purge === 'true') {
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'template.purge',
        targetType: 'template',
        targetId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { name: template.name, archived: Boolean(template.archived_at) },
      });
      await pool.query('delete from templates where id = $1', [params.id]);
      reply.code(204);
      return;
    }

    if (template.archived_at) {
      reply.code(204);
      return;
    }

    await pool.query('update templates set archived_at = now(), updated_at = now() where id = $1', [
      params.id,
    ]);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'template.archive',
      targetType: 'template',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.code(204);
  });

  app.post('/api/v1/templates/:id/restore', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const found = await pool.query('select owner_id, archived_at from templates where id = $1', [
      params.id,
    ]);
    const template = found.rows[0];
    if (!template) throw notFound('Шаблон не найден');
    if (auth.role !== 'superadmin' && template.owner_id !== auth.userId) {
      throw notFound('Шаблон не найден');
    }
    if (!template.archived_at) throw badRequest('template_not_archived', 'Шаблон не в архиве');

    await pool.query('update templates set archived_at = null, updated_at = now() where id = $1', [
      params.id,
    ]);

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'template.restore',
      targetType: 'template',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { ok: true };
  });

  app.get('/api/v1/templates/:id/revisions', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const found = await pool.query('select owner_id, shared from templates where id = $1', [params.id]);
    if (!found.rows[0]) throw notFound('Шаблон не найден');
    if (
      auth.role !== 'superadmin' &&
      found.rows[0].owner_id !== auth.userId &&
      found.rows[0].shared !== true
    ) {
      throw notFound('Шаблон не найден');
    }
    const result = await pool.query(
      `select revision, payload, exclusions, created_by, created_at
         from template_revisions where template_id = $1 order by revision desc limit 100`,
      [params.id],
    );
    return { items: result.rows };
  });

  app.post('/api/v1/templates/:id/revisions', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        payload: templateInputSchema.shape.payload,
        exclusions: templateInputSchema.shape.exclusions,
        comment: z.string().max(500).optional(),
      })
      .strict()
      .parse(request.body);

    const { exclusions, desiredHash } = validate({
      name: 'revision',
      payload: body.payload,
      exclusions: body.exclusions,
    });

    const client = await pool.connect();
    try {
      await client.query('begin');
      const found = await client.query<{ owner_id: string; current_revision: number }>(
        'select owner_id, current_revision from templates where id = $1 and archived_at is null for update',
        [params.id],
      );
      const template = found.rows[0];
      if (!template) throw notFound('Шаблон не найден');
      if (auth.role !== 'superadmin' && template.owner_id !== auth.userId) {
        throw notFound('Шаблон не найден');
      }

      const next = template.current_revision + 1;
      await client.query(
        `insert into template_revisions (template_id, revision, payload, exclusions, created_by)
         values ($1,$2,$3::jsonb,$4::jsonb,$5)`,
        [params.id, next, JSON.stringify(body.payload), JSON.stringify(exclusions), auth.userId],
      );
      await client.query(
        'update templates set current_revision = $2, updated_at = now() where id = $1',
        [params.id, next],
      );

      // Новая ревизия должна применяться к уже назначенным роутерам.
      // Но шаблон нового формата (без имени секции) применяется к выбранной
      // секции на странице роутера, а не через старое назначение. Поэтому
      // назначения обновляем только для шаблонов старого формата.
      const legacyAssignment =
        Object.keys(body.payload.sections).length > 0 &&
        !body.payload.action &&
        Object.keys(body.payload.resources ?? {}).length === 0;
      const assignments = legacyAssignment
        ? await client.query(
            `update template_assignments
                set revision = $2, desired_hash = $3, drift = 'unknown',
                    applied_hash = null, applied_at = null
              where template_id = $1`,
            [params.id, next, desiredHash],
          )
        : { rowCount: 0 };
      await client.query('commit');

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'template.revision_create',
        targetType: 'template',
        targetId: params.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          revision: next,
          desired_hash: desiredHash,
          assignments: assignments.rowCount ?? 0,
        },
      });

      reply.code(201);
      return {
        revision: next,
        desired_hash: desiredHash,
        payload: body.payload,
        exclusions,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/templates/validate', async (request) => {
    requireUser(request);
    const body = z
      .object({
        payload: templateInputSchema.shape.payload,
        exclusions: templateInputSchema.shape.exclusions,
      })
      .strict()
      .parse(request.body);

    const { desired, exclusions, desiredHash, localLists } = validate({
      name: 'validate',
      payload: body.payload,
      exclusions: body.exclusions,
    });

    return {
      ok: true,
      desired_hash: desiredHash,
      paths: [...desired.entries()].map(([path, value]) => ({ path, value })),
      exclusions,
      local_lists: localLists,
    };
  });

  app.get('/api/v1/settings/routing-catalog', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({ router_id: z.string().uuid().optional() })
      .parse(request.query ?? {});
    const { ROUTING_ACTIONS } = await import('../domain/routing.js');
    const { CATALOG_GROUPS, catalogForRouter } = await import('../domain/list-catalog.js');
    let product: string | null = null;
    let version: string | null = null;
    if (query.router_id) {
      const router = await getRouter(pool, auth, query.router_id);
      product = router.product;
      version = router.product_version;
    }
    return {
      services: catalogForRouter(product ?? 'prokop', version),
      groups: CATALOG_GROUPS,
      actions: ROUTING_ACTIONS,
      product: product ?? 'prokop',
    };
  });

  app.get('/api/v1/settings/template-allowlist', async (request) => {
    requireUser(request);
    const { SETTINGS_OPTIONS, SECTION_OPTIONS, URLTEST_OPTIONS, SECRET_OPTIONS } = await import(
      '../domain/uci.js'
    );
    return {
      settings: [...SETTINGS_OPTIONS],
      section: [...SECTION_OPTIONS],
      urltest: [...URLTEST_OPTIONS],
      forbidden: [...SECRET_OPTIONS],
    };
  });
}
