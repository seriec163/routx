import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { hashCanonical } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { sanitizeAgentState, type UciValue } from '../domain/uci.js';
import { assertOnline, getRouter, getRouterForMutation } from './service.js';

interface RouteContext {
  pool: Pool;
}

const DNS_PATHS = [
  'settings.dns_type',
  'settings.dns_server',
  'settings.bootstrap_dns_server',
] as const;

const dnsProposalSchema = z
  .object({
    dns_type: z.enum(['udp', 'doh']),
    dns_server: z.array(z.string().trim().min(1).max(2048)).min(1).max(4),
    bootstrap_dns_server: z.array(z.string().trim().min(1).max(64)).min(1).max(4),
  })
  .strict();

function listValue(value: UciValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string') return value.trim() ? value.trim().split(/\s+/) : [];
  return [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isIp(value: string): boolean {
  return isIP(value) !== 0;
}

export function validateProposal(input: z.infer<typeof dnsProposalSchema>) {
  const servers = dedupe(input.dns_server);
  const bootstrap = dedupe(input.bootstrap_dns_server);
  if (servers.length === 0) throw badRequest('dns_servers_empty', 'Укажите хотя бы один DNS-сервер');
  if (bootstrap.length === 0) {
    throw badRequest('bootstrap_empty', 'Укажите хотя бы один bootstrap DNS');
  }

  for (const server of servers) {
    if (input.dns_type === 'udp') {
      if (!isIp(server)) {
        throw badRequest('invalid_dns_server', 'Для UDP укажите IP-адрес DNS-сервера');
      }
    } else {
      let parsed: URL;
      try {
        parsed = new URL(server);
      } catch {
        throw badRequest('invalid_dns_server', 'Для DoH укажите полный https:// URL');
      }
      if (parsed.protocol !== 'https:') {
        throw badRequest('invalid_dns_server', 'DoH должен использовать https://');
      }
      if (parsed.username || parsed.password) {
        throw badRequest('invalid_dns_server', 'DoH URL не должен содержать логин или пароль');
      }
    }
  }
  for (const server of bootstrap) {
    if (!isIp(server)) {
      throw badRequest('invalid_bootstrap', 'Bootstrap DNS должен быть IP-адресом');
    }
  }

  return {
    dns_type: input.dns_type,
    dns_server: servers,
    bootstrap_dns_server: bootstrap,
  };
}

interface DnsState {
  managed: Record<string, UciValue>;
  state_hash: string | null;
  collected_at: Date | null;
}

async function loadDnsState(pool: Pool, routerId: string): Promise<DnsState | null> {
  const result = await pool.query<{
    managed: unknown;
    state_hash: string | null;
    collected_at: Date | null;
  }>('select managed, state_hash, collected_at from router_state where router_id = $1', [routerId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    managed: sanitizeAgentState(row.managed),
    state_hash: row.state_hash,
    collected_at: row.collected_at,
  };
}

async function templateDnsOwner(
  pool: Pool,
  routerId: string,
): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    payload: unknown;
    exclusions: unknown;
  }>(
    `select t.id, t.name, r.payload, r.exclusions
       from template_assignments a
       join templates t on t.id = a.template_id and t.archived_at is null
       join template_revisions r on r.template_id = a.template_id and r.revision = a.revision
      where a.router_id = $1`,
    [routerId],
  );

  for (const row of result.rows) {
    const payload =
      row.payload && typeof row.payload === 'object'
        ? (row.payload as { settings?: Record<string, unknown> })
        : {};
    const exclusions = new Set(
      Array.isArray(row.exclusions) ? row.exclusions.map((item) => String(item)) : [],
    );
    for (const path of DNS_PATHS) {
      const option = path.split('.')[1]!;
      if (
        payload.settings &&
        payload.settings[option] !== undefined &&
        payload.settings[option] !== null &&
        !exclusions.has(path)
      ) {
        return { id: row.id, name: row.name };
      }
    }
  }
  return null;
}

function sectionDnsNames(managed: Record<string, UciValue>): string[] {
  const names = new Set<string>();
  for (const path of Object.keys(managed)) {
    const match = /^section\.([A-Za-z0-9_.-]{1,64})\.(dns_type|dns_server)$/.exec(path);
    if (match) names.add(match[1]!);
  }
  return [...names].sort();
}

export async function registerDnsRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/routers/:id/dns', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);

    const state = await loadDnsState(pool, params.id);
    const managed = state?.managed ?? {};
    const template = await templateDnsOwner(pool, params.id);
    const sections = sectionDnsNames(managed);
    const detourEnabled = managed['settings.dns_detour_enabled'] === '1';
    const detourSection =
      typeof managed['settings.dns_detour_section'] === 'string'
        ? managed['settings.dns_detour_section']
        : null;

    const warnings: string[] = [];
    if (template) {
      warnings.push(
        `DNS управляется шаблоном «${template.name}». Ручное изменение будет перезаписано при следующем применении.`,
      );
    }
    if (detourEnabled) {
      warnings.push(
        `DNS идёт через секцию «${detourSection ?? 'не выбрана'}». Прямой замер не отражает реальный путь; применение заблокировано.`,
      );
    }
    if (sections.length > 0) {
      warnings.push(
        `У секций ${sections.map((name) => `«${name}»`).join(', ')} свой DNS. Глобальные настройки их не изменят.`,
      );
    }
    if (!state) {
      warnings.push('Состояние ещё не прочитано. Нажмите «Прочитать состояние» на вкладке «Обзор».');
    }

    return {
      current: state
        ? {
            dns_type:
              typeof managed['settings.dns_type'] === 'string'
                ? managed['settings.dns_type']
                : 'udp',
            dns_server: listValue(managed['settings.dns_server']),
            bootstrap_dns_server: listValue(managed['settings.bootstrap_dns_server']),
            detour_enabled: detourEnabled,
            detour_section: detourSection,
          }
        : null,
      state_available: Boolean(state),
      state_collected_at: state?.collected_at?.toISOString() ?? null,
      template,
      sections,
      warnings,
    };
  });

  app.post('/api/v1/routers/:id/dns/benchmark', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const active = await pool.query<{ id: string }>(
      `select id from jobs
        where router_id = $1 and type = 'dns_benchmark' and status in ('queued','running')
        limit 1`,
      [params.id],
    );
    if (active.rows[0]) {
      throw conflict('dns_benchmark_running', 'Тест DNS уже выполняется');
    }

    const job = await enqueueJob(pool, {
      type: 'dns_benchmark',
      routerId: params.id,
      requestedBy: auth.userId,
      timeoutSeconds: 900,
      payload: {},
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.dns_benchmark',
      targetType: 'router',
      targetId: params.id,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.get('/api/v1/routers/:id/dns/benchmark/latest', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);

    const latest = await pool.query(
      `select * from jobs
        where router_id = $1 and type = 'dns_benchmark' and status = 'success'
        order by finished_at desc nulls last, created_at desc
        limit 1`,
      [params.id],
    );
    const active = await pool.query(
      `select * from jobs
        where router_id = $1 and type = 'dns_benchmark' and status in ('queued','running')
        order by created_at desc limit 1`,
      [params.id],
    );

    return {
      latest: latest.rows[0] ? jobJson(latest.rows[0]) : null,
      active: active.rows[0] ? jobJson(active.rows[0]) : null,
    };
  });

  app.post('/api/v1/routers/:id/dns/diff', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = dnsProposalSchema.parse(request.body);
    const proposal = validateProposal(body);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);

    const state = await loadDnsState(pool, params.id);
    if (!state) {
      throw conflict(
        'state_missing',
        'Сначала прочитайте состояние роутера на вкладке «Обзор», затем повторите.',
      );
    }

    const template = await templateDnsOwner(pool, params.id);
    if (template) {
      throw conflict(
        'dns_managed_by_template',
        `DNS управляется шаблоном «${template.name}». Сначала исключите DNS из шаблона или измените его там.`,
      );
    }

    if (state.managed['settings.dns_detour_enabled'] === '1') {
      const section =
        typeof state.managed['settings.dns_detour_section'] === 'string'
          ? state.managed['settings.dns_detour_section']
          : 'не выбрана';
      throw conflict(
        'dns_detour_enabled',
        `DNS идёт через секцию «${section}». Прямой замер и применение недоступны. Выключите detour в Prokop/Forkop, подберите DNS и включите detour обратно.`,
      );
    }

    const desired: Array<[string, UciValue]> = [
      ['settings.dns_type', proposal.dns_type],
      ['settings.dns_server', proposal.dns_server],
      ['settings.bootstrap_dns_server', proposal.bootstrap_dns_server],
    ];

    const diff = desired
      .map(([path, after]) => {
        const before = state.managed[path] ?? null;
        if (hashCanonical(before) === hashCanonical(after)) return null;
        return {
          op: before === null ? ('add' as const) : ('change' as const),
          path,
          before,
          after,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.path.localeCompare(b.path));

    const diffHash = hashCanonical(diff);
    const applyRunId = uuidv7();

    if (diff.length === 0) {
      await pool.query(
        `insert into apply_runs
           (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, status, requested_by, finished_at)
         values ($1,$2,null,null,$3::jsonb,$4,$5,'success',$6, now())`,
        [applyRunId, params.id, JSON.stringify([]), diffHash, state.state_hash, auth.userId],
      );
    } else {
      await pool.query(
        `insert into apply_runs
           (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, status, requested_by)
         values ($1,$2,null,null,$3::jsonb,$4,$5,'awaiting_confirmation',$6)`,
        [
          applyRunId,
          params.id,
          JSON.stringify(diff),
          diffHash,
          state.state_hash,
          auth.userId,
        ],
      );
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.dns_diff',
      targetType: 'apply_run',
      targetId: applyRunId,
      routerId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { dns_type: proposal.dns_type, servers: proposal.dns_server.length },
    });

    return {
      apply_run_id: applyRunId,
      diff,
      diff_hash: diffHash,
      warnings: sectionDnsNames(state.managed).map(
        (name) => `У секции «${name}» свой DNS; глобальное изменение её не затронет.`,
      ),
    };
  });
}
