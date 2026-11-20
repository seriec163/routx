import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { fetchSubscription, isUnsupportedPodkopLink } from '../domain/subscription.js';
import { assertOnline, getRouter, getRouterForMutation } from './service.js';
import { resolveRouterSection } from '../domain/managed-section.js';
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

const VLESS_RE = /^(vless|vmess|trojan|ss|ssr|hysteria|hysteria2|hy2|tuic|anytls|socks|socks4|socks4a|socks5|socks5h):\/\/\S+$/i;
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

function subscriptionHostLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host.slice(0, 120);
  } catch {
    return 'Подписка';
  }
}

function subscriptionLinkLabel(link: string, index: number): string {
  const hash = link.indexOf('#');
  if (hash >= 0) {
    const raw = link.slice(hash + 1);
    try {
      const decoded = decodeURIComponent(raw).trim();
      if (decoded !== '') return decoded.slice(0, 120);
    } catch {
      if (raw.trim() !== '') return raw.trim().slice(0, 120);
    }
  }
  const match = /^[a-z0-9]+:\/\/(?:[^@/]+@)?([^:/?#]+)/i.exec(link);
  return (match?.[1] ?? `link ${index + 1}`).slice(0, 120);
}

function validateValue(kind: 'subscription' | 'vless', value: string): string {  const text = value.trim();
  if (text.length < 8 || text.length > 8192) {
    throw badRequest('invalid_connection', 'Ссылка пустая или слишком длинная');
  }
  if (kind === 'subscription') {
    if (!SUBSCRIPTION_RE.test(text)) {
      throw badRequest('invalid_subscription', 'Ссылка на подписку должна начинаться с http:// или https://');
    }
  } else if (!VLESS_RE.test(text)) {
    throw badRequest(
      'invalid_vless',
      'Поддерживаются ссылки vless://, vmess://, trojan://, ss://, ssr://, hysteria2://, hy2://, tuic://, anytls://, socks://',
    );
  }
  return text;
}

async function storeImportedLinks(args: {
  pool: Pool;
  masterKey: string;
  routerId: string;
  section: string;
  parsed: { links: string[]; total: number; skipped: number };
  sourceConnectionId: string | null;
  userId: string;
  replace?: boolean;
  subscription?: {
    url: string;
    label: string;
    catalogId?: string | null;
    connectionId?: string | null;
    enabled?: boolean;
  };
}): Promise<{
  imported: number;
  total: number;
  skipped: number;
  job: Awaited<ReturnType<typeof enqueueJob>>;
}> {
  const { pool, masterKey, routerId, section, parsed, sourceConnectionId, userId } = args;
  if (args.replace) {
    await pool.query(
      "delete from router_connections where router_id = $1 and section = $2 and kind = 'vless'",
      [routerId, section],
    );
  }
  const existing = await pool.query<{ id: string; secret_enc: string; label: string }>(
    `select id, secret_enc, label from router_connections
      where router_id = $1 and section = $2 and kind = 'vless'`,
    [routerId, section],
  );
  const existingLinks = new Set<string>();
  const existingLabels = new Set<string>();
  const unsupportedIds: string[] = [];
  for (const row of existing.rows) {
    const value = decryptSecret(row.secret_enc, masterKey);
    if (isUnsupportedPodkopLink(value)) {
      unsupportedIds.push(row.id);
      continue;
    }
    existingLinks.add(value);
    existingLabels.add(row.label);
  }
  if (unsupportedIds.length > 0) {
    await pool.query('delete from router_connections where router_id = $1 and id = any($2::uuid[])', [
      routerId,
      unsupportedIds,
    ]);
  }
  const usedLabels = new Set(existingLabels);
  const fresh: Array<{ link: string; label: string }> = [];
  let duplicateLinks = 0;
  let index = 0;
  for (const link of parsed.links) {
    if (existingLinks.has(link)) {
      duplicateLinks++;
      continue;
    }
    const base = subscriptionLinkLabel(link, index++);
    if (existingLabels.has(base)) {
      duplicateLinks++;
      continue;
    }
    let label = base;
    let suffix = 2;
    while (usedLabels.has(label)) {
      label = `${base.slice(0, 114)} #${suffix++}`;
    }
    usedLabels.add(label);
    fresh.push({ link, label });
  }
  const skipped = parsed.skipped + duplicateLinks;

  if (fresh.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const item of fresh) {
        await client.query(
          `insert into router_connections
             (id, router_id, section, kind, label, secret_enc, enabled, created_by)
           values ($1,$2,$3,'vless',$4,$5,true,$6)`,
          [
            uuidv7(),
            routerId,
            section,
            item.label,
            encryptSecret(item.link, masterKey),
            userId,
          ],
        );
      }
      if (sourceConnectionId) {
        await client.query(
          'update router_connections set enabled = false, section = $2, updated_at = now() where id = $1',
          [sourceConnectionId, section],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  if (args.subscription) {
    const sub = args.subscription;
    const client = await pool.connect();
    try {
      await client.query('begin');
      const existingSub = sub.connectionId
        ? await client.query<{ id: string }>(
            'select id from router_connections where id = $1 and router_id = $2',
            [sub.connectionId, routerId],
          )
        : await client.query<{ id: string }>(
            `select id from router_connections
              where router_id = $1 and section = $2 and kind = 'subscription'
              order by created_at asc limit 1`,
            [routerId, section],
          );
      const secret = encryptSecret(sub.url, masterKey);
      const sourceEnabled = sub.enabled === true;
      if (existingSub.rows[0]) {
        await client.query(
          `update router_connections
              set section = $2, kind = 'subscription', label = $3, secret_enc = $4,
                  enabled = $6, subscription_id = $5, updated_at = now()
            where id = $1`,
          [
            existingSub.rows[0].id,
            section,
            sub.label.slice(0, 120),
            secret,
            sub.catalogId ?? null,
            sourceEnabled,
          ],
        );
      } else {
        await client.query(
          `insert into router_connections
             (id, router_id, section, kind, label, secret_enc, enabled, created_by, subscription_id)
           values ($1,$2,$3,'subscription',$4,$5,$6,$7,$8)`,
          [
            uuidv7(),
            routerId,
            section,
            sub.label.slice(0, 120),
            secret,
            sourceEnabled,
            userId,
            sub.catalogId ?? null,
          ],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  const job = await enqueueJob(pool, {
    type: 'connections_apply',
    routerId,
    requestedBy: userId,
    timeoutSeconds: 600,
    payload: { reason: 'subscription_import', section },
  });
  return { imported: fresh.length, total: parsed.total, skipped, job };
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
      section: string;
      catalog_name: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select c.id, c.kind, c.label, c.secret_enc, c.compact_secret, c.enabled, c.subscription_id,
              c.section, s.name as catalog_name, c.created_at, c.updated_at
         from router_connections c
         left join subscriptions s on s.id = c.subscription_id
        where c.router_id = $1
        order by c.section asc, c.created_at asc`,
      [params.id],
    );

    const managedSection = await resolveRouterSection(pool, params.id);
    return {
      managed_section: managedSection ?? '',
      items: result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        masked: maskValue(decryptSecret(row.secret_enc, masterKey)),
        compact: Boolean(row.compact_secret),
        compact_length: row.compact_secret?.length ?? null,
        enabled: row.enabled,
        subscription_id: row.subscription_id,
        section: row.section,
        catalog_name: row.catalog_name,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
    };
  });

  app.delete(
    '/api/v1/routers/:id/sections/:section',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z
        .object({
          id: z.string().uuid(),
          section: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
        })
        .parse(request.params);
      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      const managedSection = await resolveRouterSection(pool, router.id);
      if (managedSection === params.section) {
        throw badRequest(
          'section_managed',
          'Это основная секция роутера. Сначала сделайте основной другую секцию.',
        );
      }

      const state = await pool.query<{ managed: Record<string, unknown> | null }>(
        'select managed from router_state where router_id = $1',
        [router.id],
      );
      const managed = state.rows[0]?.managed ?? {};
      const prefix = `section.${params.section}.`;
      if (String(managed[`${prefix}enabled`] ?? '1') !== '0') {
        throw badRequest('section_not_empty', 'Удалять можно только выключенные секции');
      }
      const allowed = new Set([
        'enabled',
        'label',
        'action',
        'connection_type',
        'proxy_config_type',
      ]);
      for (const path of Object.keys(managed)) {
        if (!path.startsWith(prefix)) continue;
        const option = path.slice(prefix.length);
        if (!allowed.has(option)) {
          throw badRequest('section_not_empty', 'В секции есть настройки, списки или ресурсы');
        }
      }
      for (const [path, value] of Object.entries(managed)) {
        if (
          (path.startsWith('subscription_url.') || path.startsWith('outbound_source.')) &&
          path.endsWith('.section') &&
          value === params.section
        ) {
          throw badRequest('section_not_empty', 'В секции есть подписка или подключение');
        }
      }
      const connections = await pool.query(
        'select 1 from router_connections where router_id = $1 and section = $2 limit 1',
        [router.id, params.section],
      );
      if ((connections.rowCount ?? 0) > 0) {
        throw badRequest('section_not_empty', 'В секции есть подключения RoutX');
      }

      const job = await enqueueJob(pool, {
        type: 'section_delete',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 300,
        maxAttempts: 1,
        payload: { section: params.section },
      });
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.section_delete',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { section: params.section, job_id: job.id },
      });
      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.post(
    '/api/v1/routers/:id/connections/list',
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);
      const body = z
        .object({ section: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional() })
        .strict()
        .parse(request.body ?? {});
      const job = await enqueueJob(pool, {
        type: 'list_connections',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 60,
        payload: {
          section: body.section ?? (await resolveRouterSection(pool, router.id)) ?? '',
        },
      });
      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.post(
    '/api/v1/routers/:id/connections/manage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          action: z.enum(['delete', 'replace']),
          kind: z.enum(['subscription', 'link']),
          name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
          hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
          value: z.string().trim().min(8).max(8192).optional(),
          subscription_id: z.string().uuid().optional(),
          section: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.kind === 'subscription'
              ? Boolean(value.name) && !value.hash
              : Boolean(value.hash) && !value.name,
          { message: 'Для подписки нужен name, для ссылки — hash' },
        )
        .refine(
          (value) =>
            value.action === 'replace'
              ? Boolean(value.value || value.subscription_id)
              : !value.value && !value.subscription_id,
          { message: 'Для замены нужно новое значение, для удаления оно не требуется' },
        )
        .parse(request.body);

      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);

      let replacement = body.value ?? '';
      if (body.subscription_id) {
        const catalog = await loadAccessibleSubscription(pool, auth, body.subscription_id);
        replacement = decryptSecret(catalog.secret_enc, masterKey);
      }
      if (replacement) {
        if (body.kind === 'subscription') {
          if (!SUBSCRIPTION_RE.test(replacement)) {
            throw badRequest(
              'invalid_subscription',
              'Ссылка на подписку должна начинаться с http:// или https://',
            );
          }
        } else if (!VLESS_RE.test(replacement)) {
          throw badRequest(
            'invalid_link',
            'Поддерживаются ссылки vless://, vmess://, trojan://, ss://, ssr://, hysteria2://, hy2://, tuic://, anytls://, socks://',
          );
        }
      }

      const section = body.section ?? (await resolveRouterSection(pool, router.id)) ?? '';
      let editId: string | null = null;
      if (body.action === 'replace' && replacement) {
        editId = uuidv7();
        await pool.query(
          'insert into connection_edits (id, router_id, secret_enc) values ($1,$2,$3)',
          [editId, router.id, encryptSecret(replacement, masterKey)],
        );
      }

      const job = await enqueueJob(pool, {
        type: 'manage_connection',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 600,
        payload: {
          section,
          action: body.action,
          kind: body.kind,
          name: body.name ?? null,
          hash: body.hash ?? null,
          edit_id: editId,
        },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.connection_manage',
        targetType: 'router_connection',
        targetId: body.name ?? body.hash ?? null,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          operation: body.action,
          kind: body.kind,
          name: body.name ?? null,
          hash: body.hash ?? null,
          section,
        },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

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
          section: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
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
      if (router.product === 'podkop' && body.kind === 'subscription') {
        let sourceUrl = body.value ?? '';
        if (body.subscription_id) {
          const catalog = await loadAccessibleSubscription(pool, auth, body.subscription_id);
          sourceUrl = decryptSecret(catalog.secret_enc, masterKey);
        }
        if (!SUBSCRIPTION_RE.test(sourceUrl)) {
          throw badRequest(
            'invalid_subscription',
            'Ссылка на подписку должна начинаться с http:// или https://',
          );
        }
        const section =
          body.section ?? (await resolveRouterSection(pool, router.id)) ?? 'main';
        const state = await pool.query<{ managed: Record<string, unknown> | null }>(
          'select managed from router_state where router_id = $1',
          [router.id],
        );
        if (state.rows[0]?.managed?.[`section.${section}.connection_type`] === undefined) {
          throw badRequest(
            'section_missing',
            `Секция «${section}» не найдена в Podkop. Сначала прочитайте состояние роутера.`,
          );
        }
        const parsed = await fetchSubscription(sourceUrl);
        const result = await storeImportedLinks({
          pool,
          masterKey,
          routerId: router.id,
          section,
          parsed,
          sourceConnectionId: null,
          userId: auth.userId,
        });
        await audit(pool, {
          actorId: auth.userId,
          actorRole: auth.role,
          action: 'router.podkop_subscription_autoimport',
          targetType: 'router',
          targetId: router.id,
          routerId: router.id,
          result: 'ok',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: {
            section,
            imported: result.imported,
            total: result.total,
            skipped: result.skipped,
            source: body.subscription_id ? 'catalog' : 'url',
            job_id: result.job.id,
          },
        });
        reply.code(202);
        return {
          imported: result.imported,
          total: result.total,
          skipped: result.skipped,
          job: jobJson(result.job),
        };
      }

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

      const section =
        body.section ?? (await resolveRouterSection(pool, router.id)) ?? '';
      if (!section) {
        throw badRequest('section_unknown', 'Не удалось определить секцию роутера');
      }
      const id = uuidv7();
      const baseLabel = label;
      let inserted = false;
      for (let attempt = 0; attempt < 20 && !inserted; attempt += 1) {
        const nextLabel = attempt === 0 ? baseLabel : `${baseLabel} ${attempt + 1}`.slice(0, 120);
        try {
          await pool.query(
            `insert into router_connections
               (id, router_id, section, kind, label, secret_enc, compact_secret, enabled, created_by, subscription_id)
             values ($1,$2,$3,$4,$5,$6,$7,true,$8,$9)`,
            [
              id,
              params.id,
              section,
              body.kind,
              nextLabel,
              encryptSecret(value, masterKey),
              compactSecret,
              auth.userId,
              catalogId,
            ],
          );
          label = nextLabel;
          inserted = true;
        } catch (error) {
          if ((error as { code?: string }).code === '23505') continue;
          throw error;
        }
      }
      if (!inserted) {
        throw conflict('connection_label_taken', 'Не удалось подобрать уникальное название подключения');
      }

      const job = await enqueueJob(pool, {
        type: 'connections_apply',
        routerId: params.id,
        requestedBy: auth.userId,
        payload: { reason: 'connection_add', section },
        timeoutSeconds: 600,
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
          section,
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
          subscription_id: z.string().uuid().optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
        .refine((value) => [value.value, value.secret, value.subscription_id].filter(Boolean).length <= 1, {
          message: 'Укажите ссылку, компактный секрет или подписку из каталога',
        })
        .parse(request.body);
      assertOnline(await getRouterForMutation(pool, auth, params.id));

      const existing = await pool.query<{ kind: 'subscription' | 'vless'; label: string; section: string }>(
        'select kind, label, section from router_connections where id = $1 and router_id = $2',
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
      if (body.subscription_id) {
        if (row.kind !== 'subscription') {
          throw badRequest('invalid_connection_kind', 'Подписку можно заменить только подпиской');
        }
        const catalog = await loadAccessibleSubscription(pool, auth, body.subscription_id);
        const url = decryptSecret(catalog.secret_enc, masterKey);
        values.push(encryptSecret(validateValue('subscription', url), masterKey));
        sets.push(`secret_enc = $${values.length}`);
        sets.push('compact_secret = null');
        values.push(body.subscription_id);
        sets.push(`subscription_id = $${values.length}`);
      } else if (compactSecret) {
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

      try {
        await pool.query(
          `update router_connections set ${sets.join(', ')}
            where id = $${values.length - 1} and router_id = $${values.length}`,
          values,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict(
            'connection_label_taken',
            'Подключение с таким названием уже есть в этой секции',
          );
        }
        throw error;
      }

      const job = await enqueueJob(pool, {
        type: 'connections_apply',
        routerId: params.id,
        requestedBy: auth.userId,
        payload: { reason: 'connection_update', section: row.section },
        timeoutSeconds: 600,
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

    const removed = await pool.query<{ section: string }>(
      'delete from router_connections where id = $1 and router_id = $2 returning section',
      [params.connectionId, params.id],
    );
    if ((removed.rowCount ?? 0) === 0) throw notFound('Подключение не найдено');
    const section =
      removed.rows[0]?.section || (await resolveRouterSection(pool, params.id)) || '';

    const job = await enqueueJob(pool, {
      type: 'connections_apply',
      routerId: params.id,
      requestedBy: auth.userId,
      payload: { reason: 'connection_delete', section },
      timeoutSeconds: 600,
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

  app.post(
    '/api/v1/routers/:id/podkop/import-subscription',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          section: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
          subscription_id: z.string().uuid().optional(),
          connection_id: z.string().uuid().optional(),
          url: z.string().trim().max(2048).optional(),
        })
        .strict()
        .refine(
          (value) =>
            [value.subscription_id, value.connection_id, value.url].filter(Boolean).length === 1,
          { message: 'Укажите подписку из каталога, существующее подключение или URL' },
        )
        .parse(request.body);

      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);
      if (router.product !== 'podkop' && router.product !== 'forkop' && router.product !== 'tachyon') {
        throw badRequest(
          'product_subscription_unsupported',
          'Импорт подписок доступен для Podkop, Forkop и Tachyon',
        );
      }

      let sourceUrl = body.url ?? '';
      let section =
        body.section ??
        (await resolveRouterSection(pool, router.id)) ??
        (router.product === 'podkop' ? 'main' : '');
      if (!section) {
        throw badRequest('section_unknown', 'Не удалось определить секцию роутера');
      }
      let sourceConnectionId: string | null = null;

      if (body.subscription_id) {
        const catalog = await loadAccessibleSubscription(pool, auth, body.subscription_id);
        sourceUrl = decryptSecret(catalog.secret_enc, masterKey);
      } else if (body.connection_id) {
        const source = await pool.query<{ kind: string; section: string; secret_enc: string }>(
          'select kind, section, secret_enc from router_connections where id = $1 and router_id = $2',
          [body.connection_id, router.id],
        );
        const row = source.rows[0];
        if (!row || row.kind !== 'subscription') {
          throw notFound('Подписка не найдена');
        }
        sourceUrl = decryptSecret(row.secret_enc, masterKey);
        if (!body.section) section = row.section || section;
        sourceConnectionId = body.connection_id;
      }

      const state = await pool.query<{ managed: Record<string, unknown> | null }>(
        'select managed from router_state where router_id = $1',
        [router.id],
      );
      const managed = state.rows[0]?.managed ?? {};
      if (managed[`section.${section}.connection_type`] === undefined) {
        throw badRequest(
          'section_missing',
          `Секция «${section}» не найдена в Podkop. Сначала прочитайте состояние или создайте секцию.`,
        );
      }

      const parsed = await fetchSubscription(sourceUrl);

      const existing = await pool.query<{ id: string; secret_enc: string; label: string }>(
        `select id, secret_enc, label from router_connections
          where router_id = $1 and section = $2`,
        [router.id, section],
      );
      const existingLinks = new Set<string>();
      const existingLabels = new Set<string>();
      const unsupportedIds: string[] = [];
      for (const row of existing.rows) {
        const value = decryptSecret(row.secret_enc, masterKey);
        if (isUnsupportedPodkopLink(value)) {
          unsupportedIds.push(row.id);
          continue;
        }
        existingLinks.add(value);
        existingLabels.add(row.label);
      }
      if (unsupportedIds.length > 0) {
        await pool.query(
          'delete from router_connections where router_id = $1 and id = any($2::uuid[])',
          [router.id, unsupportedIds],
        );
      }
      const usedLabels = new Set(existingLabels);
      const fresh: Array<{ link: string; label: string }> = [];
      let duplicateLinks = 0;
      let index = 0;
      for (const link of parsed.links) {
        if (existingLinks.has(link)) {
          duplicateLinks++;
          continue;
        }
        const base = subscriptionLinkLabel(link, index++);
        if (existingLabels.has(base)) {
          duplicateLinks++;
          continue;
        }
        let label = base;
        let suffix = 2;
        while (usedLabels.has(label)) {
          label = `${base.slice(0, 114)} #${suffix++}`;
        }
        usedLabels.add(label);
        fresh.push({ link, label });
      }
      const skipped = parsed.skipped + duplicateLinks;

      if (fresh.length === 0) {
        const job = await enqueueJob(pool, {
          type: 'connections_apply',
          routerId: router.id,
          requestedBy: auth.userId,
          timeoutSeconds: 600,
          payload: { reason: 'subscription_import_retry', section },
        });
        return { imported: 0, total: parsed.total, skipped, job: jobJson(job) };
      }

      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const item of fresh) {
          await client.query(
            `insert into router_connections
               (id, router_id, section, kind, label, secret_enc, enabled, created_by)
             values ($1,$2,$3,'vless',$4,$5,true,$6)`,
            [
              uuidv7(),
              router.id,
              section,
              item.label,
              encryptSecret(item.link, masterKey),
              auth.userId,
            ],
          );
        }
        if (sourceConnectionId) {
          await client.query(
            'update router_connections set enabled = false, section = $2, updated_at = now() where id = $1',
            [sourceConnectionId, section],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const job = await enqueueJob(pool, {
        type: 'connections_apply',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 600,
        payload: { reason: 'subscription_import', section },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.podkop_subscription_import',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          section,
          imported: fresh.length,
          total: parsed.total,
          skipped,
          source: body.subscription_id
            ? 'catalog'
            : body.connection_id
              ? 'connection'
              : 'url',
          job_id: job.id,
        },
      });

      reply.code(202);
      return {
        imported: fresh.length,
        total: parsed.total,
        skipped,
        job: jobJson(job),
      };
    },
  );

  app.post(
    '/api/v1/routers/:id/podkop/subscription',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          section: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
          mode: z.enum(['add', 'replace']).default('add'),
          subscription_id: z.string().uuid().optional(),
          connection_id: z.string().uuid().optional(),
          url: z.string().trim().max(2048).optional(),
          label: z.string().trim().min(1).max(120).optional(),
        })
        .strict()
        .refine(
          (value) =>
            [value.subscription_id, value.connection_id, value.url].filter(Boolean).length === 1,
          { message: 'Укажите подписку из каталога, существующую подписку или URL' },
        )
        .parse(request.body);

      const router = await getRouterForMutation(pool, auth, params.id);
      assertOnline(router);
      if (router.product !== 'podkop' && router.product !== 'forkop' && router.product !== 'tachyon') {
        throw badRequest(
          'product_subscription_unsupported',
          'Подписки RoutX доступны для Podkop, Forkop и Tachyon',
        );
      }

      let sourceUrl = body.url ?? '';
      let label = body.label ?? '';
      let catalogId: string | null = null;
      let sourceConnectionId: string | null = null;

      if (body.subscription_id) {
        const catalog = await loadAccessibleSubscription(pool, auth, body.subscription_id);
        sourceUrl = decryptSecret(catalog.secret_enc, masterKey);
        label = body.label ?? catalog.name;
        catalogId = catalog.id;
      } else if (body.connection_id) {
        const source = await pool.query<{ kind: string; label: string; secret_enc: string }>(
          'select kind, label, secret_enc from router_connections where id = $1 and router_id = $2',
          [body.connection_id, router.id],
        );
        const row = source.rows[0];
        if (!row || row.kind !== 'subscription') {
          throw notFound('Подписка не найдена');
        }
        sourceUrl = decryptSecret(row.secret_enc, masterKey);
        label = body.label ?? row.label;
        sourceConnectionId = body.connection_id;
      }

      if (!SUBSCRIPTION_RE.test(sourceUrl)) {
        throw badRequest(
          'invalid_subscription',
          'Ссылка на подписку должна начинаться с http:// или https://',
        );
      }

      const state = await pool.query<{ managed: Record<string, unknown> | null }>(
        'select managed from router_state where router_id = $1',
        [router.id],
      );
      if (
        router.product === 'podkop' &&
        state.rows[0]?.managed?.[`section.${body.section}.connection_type`] === undefined &&
        !Object.keys(state.rows[0]?.managed ?? {}).some((path) =>
          path.startsWith(`section.${body.section}.`),
        )
      ) {
        throw badRequest(
          'section_missing',
          `Секция «${body.section}» не найдена. Сначала прочитайте состояние.`,
        );
      }

      const parsed = await fetchSubscription(sourceUrl);
      if (label.trim() === '' || (sourceConnectionId && label.trim() === 'Подписка')) {
        label = parsed.title ?? subscriptionHostLabel(sourceUrl);
      }
      const result = await storeImportedLinks({
        pool,
        masterKey,
        routerId: router.id,
        section: body.section,
        parsed,
        sourceConnectionId: null,
        userId: auth.userId,
        replace: body.mode === 'replace',
        subscription: {
          url: sourceUrl,
          label,
          catalogId,
          connectionId: sourceConnectionId,
          enabled: router.product !== 'podkop',
        },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.podkop_subscription_save',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          section: body.section,
          mode: body.mode,
          imported: result.imported,
          total: result.total,
          skipped: result.skipped,
          job_id: result.job.id,
        },
      });

      reply.code(202);
      return {
        imported: result.imported,
        total: result.total,
        skipped: result.skipped,
        job: jobJson(result.job),
      };
    },
  );
}
