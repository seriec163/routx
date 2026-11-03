import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { decryptSecret } from '../lib/crypto.js';
import { conflict, badRequest } from '../lib/errors.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { getRouter, getRouterForMutation, assertOnline } from './service.js';
import {
  buildPlan,
  sectionRulePayload,
  uciValueSchema,
  type RouterListExtras,
  type UciValue,
} from '../domain/uci.js';
import { buildRuleViews, type StoredConnection } from '../domain/rules.js';

interface RouteContext {
  pool: Pool;
  masterKey: string;
}

const SECTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ruleBodySchema = z
  .object({
    section: z.string().regex(SECTION_RE),
    label: z.string().trim().min(1).max(120).optional(),
    action: z.enum(['connection', 'bypass', 'block', 'dns']),
    enabled: z.boolean().default(true),
    create: z.boolean().default(false),
    resources: z.record(z.string(), uciValueSchema).default({}),
    manual_domains: z.array(z.string().max(512)).max(5000).default([]),
    manual_ips: z.array(z.string().max(64)).max(5000).default([]),
    settings: z.record(z.string(), uciValueSchema).default({}),
    connection_type: z.enum(['proxy', 'vpn', 'block', 'exclusion']).optional(),
    proxy_config_type: z.enum(['url', 'selector', 'urltest']).optional(),
    podkop_options: z.record(z.string(), uciValueSchema).default({}),
    reason: z.string().max(200).optional(),
  })
  .strict();

async function loadConnections(
  pool: Pool,
  routerId: string,
  masterKey: string,
): Promise<StoredConnection[]> {
  const result = await pool.query<{
    id: string;
    kind: 'subscription' | 'vless';
    label: string;
    section: string;
    secret_enc: string;
    enabled: boolean;
  }>(
    `select id, kind, label, section, secret_enc, enabled
       from router_connections where router_id = $1 order by created_at asc`,
    [routerId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    section: row.section,
    value: decryptSecret(row.secret_enc, masterKey),
    enabled: row.enabled,
  }));
}

export async function registerRouterRuleRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool, masterKey } = ctx;

  /**
   * Последнее прочитанное состояние. Используется как быстрый ответ и как
   * запасной вариант, если роутер офлайн. Живое чтение — ниже.
   */
  app.get('/api/v1/routers/:id/rules', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);

    const state = await pool.query<{
      managed: Record<string, UciValue> | null;
      collected_at: Date | null;
    }>('select managed, collected_at from router_state where router_id = $1', [router.id]);
    const extrasResult = await pool.query<{ list_extras: unknown }>(
      'select list_extras from routers where id = $1',
      [router.id],
    );
    const extras =
      extrasResult.rows[0]?.list_extras &&
      typeof extrasResult.rows[0].list_extras === 'object' &&
      !Array.isArray(extrasResult.rows[0].list_extras)
        ? (extrasResult.rows[0].list_extras as RouterListExtras)
        : {};

    const rules = buildRuleViews({
      managed: state.rows[0]?.managed ?? {},
      connections: await loadConnections(pool, router.id, masterKey),
      extras,
      source: 'cache',
      product: router.product,
    });

    return {
      rules,
      source: 'cache',
      managed_section: router.managed_section ?? 'router_control',
      state_collected_at: state.rows[0]?.collected_at?.toISOString() ?? null,
    };
  });

  app.post('/api/v1/routers/:id/rules/read', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const job = await enqueueJob(pool, {
      type: 'read_rules',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 120,
      payload: {},
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  /**
   * Сравнение ручного правила. Шаблон здесь уже не нужен: клиент присылает
   * полный желаемый набор для одной секции.
   */
  app.post(
    '/api/v1/routers/:id/rules/diff',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = ruleBodySchema.parse(request.body);
      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      if (router.product === 'podkop') {
        const connectionType = body.connection_type;
        if (!connectionType) {
          throw badRequest('connection_type_required', 'Укажите тип секции Podkop');
        }
        const payload = {
          section: body.section,
          label: body.label,
          create: body.create,
          enabled: body.enabled,
          connection_type: connectionType,
          proxy_config_type: body.proxy_config_type,
          community_lists: Array.isArray(body.resources.community_lists)
            ? body.resources.community_lists.map(String)
            : body.resources.community_lists == null
              ? []
              : [String(body.resources.community_lists)],
          manual_domains: body.manual_domains,
          manual_ips: body.manual_ips,
          options: body.podkop_options,
        };
        const job = await enqueueJob(pool, {
          type: 'diff_podkop',
          routerId: router.id,
          requestedBy: auth.userId,
          timeoutSeconds: 120,
          payload: { payload, reason: body.reason ?? null },
        });
        await audit(pool, {
          actorId: auth.userId,
          actorRole: auth.role,
          action: 'router.podkop_section_diff',
          targetType: 'router',
          targetId: router.id,
          routerId: router.id,
          result: 'ok',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: {
            section: body.section,
            connection_type: connectionType,
            create: body.create,
            job_id: job.id,
          },
        });
        reply.code(202);
        return { job: jobJson(job) };
      }

      // Prokop не может собрать конфигурацию, если не осталось ни одной
      // включённой секции. Не даём выключить последнее включённое правило.
      if (!body.enabled) {
        const state = await pool.query<{ managed: Record<string, UciValue> | null }>(
          'select managed from router_state where router_id = $1',
          [router.id],
        );
        const managed = state.rows[0]?.managed ?? {};
        const enabledSections = new Set<string>();
        for (const [path, value] of Object.entries(managed)) {
          const match = /^section\.([A-Za-z0-9_.-]{1,64})\.enabled$/.exec(path);
          if (match && String(value) !== '0') enabledSections.add(match[1]!);
        }
        const targetEnabled = String(managed[`section.${body.section}.enabled`] ?? '1') !== '0';
        if (targetEnabled && enabledSections.size <= 1 && enabledSections.has(body.section)) {
          throw conflict(
            'last_enabled_rule',
            'Нельзя выключить последнее включённое правило: Prokop не сможет собрать конфигурацию. Сначала включите другое правило.',
          );
        }
      }

      const payload = sectionRulePayload({
        section: body.section,
        label: body.label,
        action: body.action,
        enabled: body.enabled,
        resources: body.resources,
        manual_domains: body.manual_domains,
        manual_ips: body.manual_ips,
        settings: body.settings,
        create: body.create,
      });
      // Ранняя проверка: ошибки домена/IP/списка должны вернуться сразу,
      // а не после похода к роутеру.
      buildPlan(payload, [], {});

      const job = await enqueueJob(pool, {
        type: 'diff_custom',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 120,
        payload: { payload, exclusions: [], reason: body.reason ?? null },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.rule_diff',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          section: body.section,
          action: body.action,
          create: body.create,
          job_id: job.id,
        },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );
}
