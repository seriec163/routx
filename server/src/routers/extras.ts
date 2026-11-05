import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { isCommentLine, parseManualDomain } from '../domain/uci.js';
import { resolveRouterSection } from '../domain/managed-section.js';
import { badRequest } from '../lib/errors.js';
import { getRouter } from './service.js';

const SECTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

const bodySchema = z
  .object({
    section: z.string().regex(SECTION_RE),
    rule_set: z.array(z.string().trim().min(1).max(2048)).max(100).default([]),
    remote_domain_lists: z.array(z.string().trim().min(1).max(2048)).max(100).default([]),
    remote_subnet_lists: z.array(z.string().trim().min(1).max(2048)).max(100).default([]),
    manual_domains: z.array(z.string().trim().min(1).max(512)).max(2000).default([]),
    manual_ips: z.array(z.string().trim().min(1).max(64)).max(2000).default([]),
  })
  .strict();

function normalizeIp(value: string): string {
  const text = value.trim();
  const [address, prefixText] = text.split('/');
  const family = address?.includes(':') ? 6 : 4;
  const isV4 =
    family === 4 &&
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address ?? '') &&
    (address ?? '').split('.').every((part) => Number(part) <= 255);
  const isV6 = family === 6 && /^[0-9a-f:]+$/i.test(address ?? '') && (address ?? '').includes(':');
  if (!isV4 && !isV6) throw badRequest('invalid_ip', `Некорректный IP/CIDR: ${value}`);
  const limit = family === 6 ? 128 : 32;
  const prefix = prefixText === undefined ? limit : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > limit) {
    throw badRequest('invalid_ip', `Некорректный префикс CIDR: ${value}`);
  }
  return `${address}/${prefix}`;
}

function normalizeReference(value: string, kind: 'rule_set' | 'plain'): string {
  const text = value.trim();
  if (URL_RE.test(text)) return text;
  if (text.startsWith('/') && (kind === 'rule_set' ? /\.(srs|json)$/i.test(text) : /\.lst$/i.test(text))) {
    return text;
  }
  throw badRequest(
    'invalid_list_url',
    kind === 'rule_set'
      ? `Ссылка должна начинаться с http(s):// или быть путём к .srs/.json: ${value}`
      : `Ссылка должна начинаться с http(s):// или быть путём к .lst: ${value}`,
  );
}

export async function registerRouterExtrasRoutes(
  app: FastifyInstance,
  ctx: { pool: Pool },
): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/routers/:id/list-extras', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    const managedSection = await resolveRouterSection(pool, router.id);
    return {
      managed_section: managedSection ?? '',
      extras: router.list_extras ?? {},
    };
  });

  app.put('/api/v1/routers/:id/list-extras', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = bodySchema.parse(request.body);
    const router = await getRouter(pool, auth, params.id);
    if (router.archived_at) throw badRequest('router_archived', 'Роутер архивирован');

    const entry = {
      rule_set: body.rule_set
        .map((value) => value.trim())
        .filter((value) => value !== '' && !isCommentLine(value))
        .map((value) => normalizeReference(value, 'rule_set')),
      remote_domain_lists: body.remote_domain_lists
        .map((value) => value.trim())
        .filter((value) => value !== '' && !isCommentLine(value))
        .map((value) => normalizeReference(value, 'plain')),
      remote_subnet_lists: body.remote_subnet_lists
        .map((value) => value.trim())
        .filter((value) => value !== '' && !isCommentLine(value))
        .map((value) => normalizeReference(value, 'plain')),
      manual_domains: [
        ...new Set(
          body.manual_domains
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => {
              if (isCommentLine(value)) return value;
              if (!parseManualDomain(value)) {
                throw badRequest(
                  'invalid_domain',
                  `Некорректный домен: ${value}. Используйте домен, full:, keyword: или regex:.`,
                );
              }
              return value;
            }),
        ),
      ],
      manual_ips: [
        ...new Set(
          body.manual_ips
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => {
              if (isCommentLine(value)) return value;
              return normalizeIp(value);
            }),
        ),
      ],
    };

    const extras = { ...(router.list_extras ?? {}) } as Record<string, unknown>;
    const empty =
      entry.rule_set.length === 0 &&
      entry.remote_domain_lists.length === 0 &&
      entry.remote_subnet_lists.length === 0 &&
      entry.manual_domains.length === 0 &&
      entry.manual_ips.length === 0;
    if (empty) delete extras[body.section];
    else extras[body.section] = entry;

    const updated = await pool.query(
      `update routers set list_extras = $2::jsonb, updated_at = now()
        where id = $1 returning list_extras`,
      [params.id, JSON.stringify(extras)],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.list_extras_update',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        section: body.section,
        rule_set: entry.rule_set.length,
        remote_domain_lists: entry.remote_domain_lists.length,
        remote_subnet_lists: entry.remote_subnet_lists.length,
        manual_domains: entry.manual_domains.length,
        manual_ips: entry.manual_ips.length,
      },
    });

    return { extras: updated.rows[0]?.list_extras ?? {} };
  });
}
