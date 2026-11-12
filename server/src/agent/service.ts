import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { hmacSha256Hex, sha256Hex } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';
import { HttpError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import type { PlatformSettings } from '../settings.js';

export const MUTATING_OPS = new Set([
  'apply_uci',
  'apply_connections',
  'manage_connection',
  'delete_section',
  'reload',
  'snapshot_create',
  'snapshot_restore',
  'service_action',
  'sb_install',
  'product_switch',
]);

export const READ_OPS = new Set([
  'precheck',
  'product_probe',
  'read_state',
  'snapshot_list',
  'verify',
  'diagnostics_quick',
  'diagnostics_full',
  'proxy_latency',
  'proxy_latencies',
  'monitor_probe',
  'sb_check_update',
  'sb_versions',
  'logs_tail',
  'dns_benchmark',
]);

export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export interface AgentCommand {
  id: string;
  router_id: string;
  job_id: string;
  op: string;
  args: Record<string, unknown>;
  attempt: number;
  expires_at: Date;
}

export interface RouterRow {
  id: string;
  owner_id: string;
  product: string;
  status: string;
  agent_version: string | null;
}

const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(0);

export function notifyAgent(routerId: string): void {
  agentEvents.emit(`router:${routerId}`);
}

/** Ожидание пробуждения long-poll без таймеров на каждый цикл. */
export function waitForAgentWake(routerId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const key = `router:${routerId}`;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      agentEvents.removeListener(key, finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    agentEvents.once(key, finish);
  });
}

function sleep(ms: number): Promise<void> {
  return delay(ms);
}

export async function createCommand(
  pool: Pool,
  input: {
    routerId: string;
    jobId: string;
    op: string;
    args?: Record<string, unknown>;
    settings: PlatformSettings;
    mutate?: boolean;
    ttlSeconds?: number;
  },
): Promise<AgentCommand> {
  const mutate = input.mutate ?? MUTATING_OPS.has(input.op);
  const ttl = input.ttlSeconds ?? (mutate
    ? input.settings.agent.commandTtlMutateSeconds
    : input.settings.agent.commandTtlReadSeconds);

  const result = await pool.query<AgentCommand>(
    `insert into agent_commands (id, router_id, job_id, op, args, expires_at)
     values ($1,$2,$3,$4,$5::jsonb, now() + ($6 || ' seconds')::interval)
     returning id, router_id, job_id, op, args, attempt, expires_at`,
    [uuidv7(), input.routerId, input.jobId, input.op, JSON.stringify(input.args ?? {}), ttl],
  );

  notifyAgent(input.routerId);
  return result.rows[0]!;
}

export async function claimCommand(
  pool: Pool,
  routerId: string,
): Promise<AgentCommand | null> {
  const result = await pool.query<AgentCommand>(
    `with candidate as (
       select id from agent_commands
        where router_id = $1
          and expires_at > now()
          and (
            status = 'pending'
            or (status = 'delivered' and delivered_at < now() - interval '30 seconds')
          )
        order by created_at asc
        limit 1
        for update skip locked
     )
     update agent_commands c
        set status = 'delivered', delivered_at = now(), attempt = c.attempt + 1
       from candidate
      where c.id = candidate.id
      returning c.id, c.router_id, c.job_id, c.op, c.args, c.attempt, c.expires_at`,
    [routerId],
  );
  return result.rows[0] ?? null;
}

export async function expireCommands(pool: Pool): Promise<number> {
  const result = await pool.query(
    `update agent_commands
        set status = 'expired', acked_at = now()
      where status in ('pending','delivered') and expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

export async function collectCommandResult(
  pool: Pool,
  routerId: string,
  commandId: string,
  status: string,
  result: unknown,
  error: { code?: string; message?: string } | null,
  rawSize: number,
): Promise<{ jobId: string }> {
  if (rawSize > MAX_RESULT_BYTES) {
    throw badRequest('result_too_large', 'Результат команды превышает 256 КиБ');
  }
  if (!['success', 'failed', 'cancelled', 'timeout'].includes(status)) {
    throw badRequest('invalid_status', 'Некорректный статус результата');
  }

  const row = await pool.query<{ job_id: string; status: string }>(
    `update agent_commands
        set status = $3, acked_at = now(),
            result = $4::jsonb
      where id = $1 and router_id = $2 and status in ('delivered','pending')
      returning job_id, status`,
    [
      commandId,
      routerId,
      status === 'success' ? 'acked' : 'failed',
      JSON.stringify({
        status,
        result: result ?? null,
        error: error ?? null,
        received_at: new Date().toISOString(),
      }),
    ],
  );

  if (!row.rows[0]) {
    // Повторная доставка результата идемпотентна: команда уже закрыта.
    const existing = await pool.query<{ job_id: string }>(
      'select job_id from agent_commands where id = $1 and router_id = $2',
      [commandId, routerId],
    );
    if (!existing.rows[0]) throw new HttpError(404, 'not_found', 'Команда не найдена');
    notifyAgent(routerId);
    return { jobId: existing.rows[0].job_id };
  }

  notifyAgent(routerId);
  return { jobId: row.rows[0].job_id };
}

export interface CommandOutcome {
  status: 'success' | 'failed' | 'cancelled' | 'timeout';
  result: unknown;
  error: { code?: string; message?: string } | null;
}

/** Ожидание результата команды внутри обработчика job (без блокировки пула). */
export async function waitForCommand(
  pool: Pool,
  commandId: string,
  options: { timeoutMs: number; isCancelled?: () => Promise<boolean> },
): Promise<CommandOutcome> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const row = await pool.query<{
      status: string;
      result: {
        status?: string;
        result?: unknown;
        error?: { code?: string; message?: string } | null;
      } | null;
      expires_at: Date;
    }>('select status, result, expires_at from agent_commands where id = $1', [commandId]);

    const command = row.rows[0];
    if (!command) {
      return { status: 'failed', result: null, error: { code: 'command_missing', message: 'Команда не найдена' } };
    }

    if (command.status === 'acked' || command.status === 'failed') {
      const payload = command.result;
      const status = payload?.status;
      return {
        status:
          status === 'success' || status === 'cancelled' || status === 'timeout'
            ? status
            : 'failed',
        result: payload?.result ?? null,
        error: payload?.error ?? null,
      };
    }

    if (command.status === 'expired' || command.expires_at.getTime() <= Date.now()) {
      return {
        status: 'timeout',
        result: null,
        error: { code: 'command_expired', message: 'Агент не получил команду вовремя' },
      };
    }

    if (options.isCancelled && (await options.isCancelled())) {
      return {
        status: 'cancelled',
        result: null,
        error: { code: 'cancelled', message: 'Задача отменена пользователем' },
      };
    }

    await sleep(300);
  }

  return {
    status: 'timeout',
    result: null,
    error: { code: 'command_timeout', message: 'Истекло время ожидания ответа агента' },
  };
}

export interface AgentAuthContext {
  routerId: string;
  ownerId: string;
  product: string;
  status: string;
  agentVersion: string | null;
  token: string;
}

export async function authenticateAgent(
  pool: Pool,
  input: {
    authorization?: string;
    timestamp?: string;
    nonce?: string;
    signature?: string;
    method: string;
    path: string;
    rawBody: Buffer;
    requireSignature: boolean;
  },
): Promise<AgentAuthContext> {
  const header = input.authorization ?? '';
  if (!header.startsWith('Bearer ')) throw unauthorized('Отсутствует токен агента');
  const token = header.slice(7).trim();
  if (token.length < 32 || token.length > 128) throw unauthorized('Некорректный токен агента');

  const result = await pool.query<
    RouterRow & { token_prefix: string }
  >(
    `select r.id, r.owner_id, r.product, r.status, r.agent_version, c.token_prefix
       from routers r
       join router_credentials c on c.router_id = r.id
      where (c.token_hash = $1
             or (c.previous_token_hash = $1 and c.previous_expires_at > now()))
        and c.revoked_at is null
        and (c.expires_at is null or c.expires_at > now())`,
    [sha256Hex(token)],
  );

  const router = result.rows[0];
  if (!router) throw unauthorized('Токен агента неизвестен или отозван');

  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    throw unauthorized('Метка времени агента вне допустимого окна');
  }
  const nonce = input.nonce ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw unauthorized('Некорректный nonce агента');
  }

  const nonceInsert = await pool.query(
    'insert into nonces (nonce, router_id) values ($1,$2) on conflict (nonce) do nothing returning nonce',
    [nonce, router.id],
  );
  if (!nonceInsert.rows[0]) throw unauthorized('Повторное использование nonce');

  if (input.requireSignature) {
    const expected = hmacSha256Hex(
      token,
      `${input.method}\n${input.path}\n${timestamp}\n${nonce}\n${sha256Hex(input.rawBody)}`,
    );
    if (!input.signature || input.signature !== expected) {
      throw unauthorized('Неверная подпись запроса агента');
    }
  }

  return {
    routerId: router.id,
    ownerId: router.owner_id,
    product: router.product,
    status: router.status,
    agentVersion: router.agent_version,
    token,
  };
}

export function assertRouterOperable(product: string, status: string): void {
  if (status === 'conflict' || product === 'conflict') {
    throw conflict(
      'router_conflict',
      'На роутере обнаружено несколько продуктов (Forkop/Prokop/Podkop). Изменения запрещены до устранения конфликта.',
    );
  }
  if (status === 'unsupported') {
    throw conflict('unsupported_platform', 'Платформа роутера не поддерживается для записи');
  }
}

export async function withRouterLock<T>(
  pool: Pool,
  routerId: string,
  holder: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const locked = await client.query(
      `insert into router_locks (router_id, holder, expires_at)
       values ($1,$2, now() + interval '15 minutes')
       on conflict (router_id) do update
         set holder = excluded.holder, expires_at = excluded.expires_at
         where router_locks.expires_at < now()
       returning router_id`,
      [routerId, holder],
    );
    if (!locked.rows[0]) {
      throw conflict('job_busy', 'Другая операция уже выполняется на этом роутере');
    }
    try {
      return await fn();
    } finally {
      await client.query('delete from router_locks where router_id = $1 and holder = $2', [
        routerId,
        holder,
      ]);
    }
  } finally {
    client.release();
  }
}

export async function touchRouterSeen(
  pool: Pool | PoolClient,
  routerId: string,
  info: {
    agentVersion?: string | null;
    product?: string;
    productVersion?: string | null;
    singBoxVersion?: string | null;
    singBoxVariant?: string | null;
    openwrt?: string | null;
    arch?: string | null;
    model?: string | null;
    health?: string | null;
    status?: 'online' | 'conflict' | 'unsupported';
  },
): Promise<void> {
  await pool.query(
    `update routers
        set last_seen_at = now(),
            updated_at = now(),
            agent_version = coalesce($2, agent_version),
            product = coalesce($3, product),
            product_version = coalesce($4, product_version),
            sing_box_version = coalesce($5, sing_box_version),
            sing_box_variant = coalesce($6, sing_box_variant),
            openwrt_version = coalesce($7, openwrt_version),
            arch = coalesce($8, arch),
            model = coalesce($9, model),
            status = case
              when product = 'conflict' then 'conflict'
              when $10::text is not null then $10::text
              when status = 'pending' then 'online'
              else status
            end
      where id = $1`,
    [
      routerId,
      info.agentVersion ?? null,
      info.product ?? null,
      info.productVersion ?? null,
      info.singBoxVersion ?? null,
      info.singBoxVariant ?? null,
      info.openwrt ?? null,
      info.arch ?? null,
      info.model ?? null,
      info.status ?? null,
    ],
  );
}

export async function updateRouterFromProbe(
  client: PoolClient | Pool,
  routerId: string,
  probe: Record<string, unknown>,
): Promise<void> {
  const str = (key: string): string | null => {
    const value = probe[key];
    return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null;
  };
  const product = str('product');
  const conflict = probe.conflict === true || product === 'conflict';

  await client.query(
    `update routers set
        product = case
          when $2::boolean then 'conflict'
          when $3 in ('forkop','prokop','podkop','tachyon') then $3
          else product end,
        product_version = coalesce($4, product_version),
        agent_version = coalesce($5, agent_version),
        manifest_version = coalesce($6, manifest_version),
        openwrt_version = coalesce($7, openwrt_version),
        arch = coalesce($8, arch),
        model = coalesce($9, model),
        sing_box_version = coalesce($10, sing_box_version),
        sing_box_variant = coalesce($11, sing_box_variant),
        managed_section = case
          when $3 = 'podkop' and (managed_section is null or managed_section = '')
            then 'main'
          else managed_section end,
        status = case
          when $2::boolean then 'conflict'
          when $12 = 'unsupported' then 'unsupported'
          when status in ('conflict','unsupported') and not $2::boolean then 'online'
          else status end,
        last_error = $13,
        installed_products = coalesce($14::jsonb, installed_products),
        updated_at = now()
      where id = $1`,
    [
      routerId,
      conflict,
      product,
      str('product_version'),
      str('agent_version'),
      Number.isFinite(Number(probe.manifest_version)) ? Number(probe.manifest_version) : null,
      str('openwrt'),
      str('arch'),
      str('model'),
      str('sing_box_version'),
      str('sing_box_variant'),
      str('platform_state') ?? (conflict ? 'conflict' : 'ok'),
      str('last_error'),
      Array.isArray(probe.installed_products) ? JSON.stringify(probe.installed_products) : null,
    ],
  );
}
