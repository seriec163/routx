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
import { buildRuleViews, type AgentSection, type StoredConnection } from '../domain/rules.js';
import { resolveCommunityLists } from '../domain/community-lists.js';
import { resolveRouterSection } from '../domain/managed-section.js';

interface RouteContext {
  pool: Pool;
  masterKey: string;
}

const SECTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// Теги Forkop 2.x — это человекочитаемые label и имена серверов:
// пробелы, кириллица, эмодзи и слэш допустимы.
const PROXY_TAG_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

function textLines(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

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
    proxy_config_type: z.enum(['url', 'selector', 'urltest', 'outbound']).optional(),
    user_domain_list_type: z.enum(['disabled', 'dynamic', 'text']).optional(),
    user_domains_text: z.string().max(200000).optional(),
    user_subnet_list_type: z.enum(['disabled', 'dynamic', 'text']).optional(),
    user_subnets_text: z.string().max(200000).optional(),
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
      sections: AgentSection[] | null;
      collected_at: Date | null;
    }>('select managed, sections, collected_at from router_state where router_id = $1', [router.id]);
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
      agentSections: Array.isArray(state.rows[0]?.sections) ? state.rows[0].sections : [],
      connections: await loadConnections(pool, router.id, masterKey),
      extras,
      source: 'cache',
      product: router.product,
      productVersion: router.product_version,
    });

    return {
      rules,
      source: 'cache',
      managed_section: (await resolveRouterSection(pool, router.id)) ?? '',
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
        const communityLists = Array.isArray(body.resources.community_lists)
          ? body.resources.community_lists.map(String)
          : body.resources.community_lists == null
            ? []
            : [String(body.resources.community_lists)];
        const fallback = await resolveCommunityLists(
          communityLists,
          'podkop',
          router.product_version,
        );
        const domainLines = [
          ...new Set([
            ...textLines(body.user_domains_text),
            ...(body.manual_domains ?? []),
            ...fallback.domains,
          ]),
        ];
        const subnetLines = [
          ...new Set([
            ...textLines(body.user_subnets_text),
            ...(body.manual_ips ?? []),
            ...fallback.subnets,
          ]),
        ];
        const payload = {
          section: body.section,
          label: body.label,
          create: body.create,
          enabled: body.enabled,
          connection_type: connectionType,
          proxy_config_type: body.proxy_config_type,
          user_domain_list_type:
            fallback.domains.length > 0 ? 'text' : body.user_domain_list_type,
          user_domains_text:
            fallback.domains.length > 0 ? domainLines.join('\n') : body.user_domains_text,
          user_subnet_list_type:
            fallback.subnets.length > 0 ? 'text' : body.user_subnet_list_type,
          user_subnets_text:
            fallback.subnets.length > 0 ? subnetLines.join('\n') : body.user_subnets_text,
          community_lists: fallback.native,
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

  app.post('/api/v1/routers/:id/proxies/select', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        group: z.string().trim().regex(PROXY_TAG_RE),
        tag: z.string().trim().regex(PROXY_TAG_RE),
      })
      .strict()
      .parse(request.body);

    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);
    const job = await enqueueJob(pool, {
      type: 'proxy_select',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 90,
      payload: { group: body.group, tag: body.tag },
    });
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.proxy_select',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { group: body.group, tag: body.tag, job_id: job.id },
    });
    reply.code(202);
    return { job: jobJson(job) };
  });

  app.put('/api/v1/routers/:id/podkop/outbound', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        section: z.string().regex(SECTION_RE),
        outbound_json: z.string().trim().min(2).max(65535),
      })
      .strict()
      .parse(request.body);

    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);
    if (
      router.product === 'podkop' ||
      router.product === 'forkop' ||
      router.product === 'tachyon' ||
      router.product === 'prokop' ||
      router.product === 'unknown' ||
      router.product === 'conflict'
    ) {
      throw badRequest(
        'json_outbound_disabled',
        'Добавление подключений через JSON отключено. Используйте подписку или отдельные VLESS-ссылки.',
      );
    }
    if (router.product !== 'podkop') {
      throw badRequest('podkop_required', 'Outbound JSON доступен только для Podkop');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.outbound_json);
    } catch {
      throw badRequest('invalid_outbound_json', 'Outbound JSON не является корректным JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('invalid_outbound_json', 'Outbound JSON должен быть объектом');
    }
    const outbound = parsed as Record<string, unknown>;
    if (typeof outbound.type !== 'string' || outbound.type.trim() === '') {
      throw badRequest('invalid_outbound_json', 'В outbound JSON не указано поле type');
    }
    const forbidden = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);
    if (forbidden.has(outbound.type.toLowerCase())) {
      throw badRequest(
        'outbound_type_not_allowed',
        `Тип outbound «${outbound.type}» нельзя использовать в этой секции`,
      );
    }

    const job = await enqueueJob(pool, {
      type: 'podkop_outbound',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 300,
      payload: { section: body.section, outbound_json: body.outbound_json },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.podkop_outbound',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        section: body.section,
        type: outbound.type,
        size: body.outbound_json.length,
        job_id: job.id,
      },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });
}
