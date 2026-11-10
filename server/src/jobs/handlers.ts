import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { maskSecrets, sha256Hex, decryptSecret } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';
import { sanitizeReport } from '../audit.js';
import {
  computePlan,
  creatableSections,
  diffHash,
  applySectionMap,
  mapTemplateSections,
  resolveManagedSection,
  sanitizeAgentState,
  stateHash,
  templatePayloadSchema,
  validateExclusions,
  type DiffItem,
  type RouterListExtras,
  type TemplatePayload,
  type UciValue,
} from '../domain/uci.js';
import type { PlatformSettings } from '../settings.js';
import { normalizeTemplateLists } from '../domain/community-lists.js';
import { resolveRouterSection } from '../domain/managed-section.js';
import { createCommand, waitForCommand } from '../agent/service.js';
import { enqueueJob, isCancelRequested } from './queue.js';
import type { JobRow } from './queue.js';
import { notifyRouterOwner } from '../notifications.js';
import {
  buildRuleViews,
  type AgentSection,
  type StoredConnection,
} from '../domain/rules.js';
import { computePodkopPlan, podkopSectionInputSchema, podkopTemplateInput } from '../domain/podkop.js';

export class JobFailure extends Error {
  readonly code: string;
  readonly terminal: 'failed' | 'timeout' | 'cancelled';

  constructor(code: string, message: string, terminal: 'failed' | 'timeout' | 'cancelled' = 'failed') {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.terminal = terminal;
  }
}

export interface HandlerContext {
  pool: Pool;
  settings: PlatformSettings;
  log: FastifyBaseLogger;
  workerId: string;
  masterKey: string;
  publicUrl: string;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Prokop возвращает в лог понятную причину, но CLI-ответ при reload может быть
 * просто JSON. Добавляем подсказку для самых частых случаев.
 */
function prokopReloadHint(message: string): string {
  if (/no enabled sections/i.test(message)) {
    return `${message}. В Prokop не осталось ни одного включённого правила: включите другое правило или добавьте источник подключения.`;
  }
  if (/has no connection/i.test(message)) {
    return `${message}. У правила «через VPN» нет источника подключения: добавьте подписку или VLESS-ссылку.`;
  }
  if (/reload_failed|config/i.test(message) && message.trim().startsWith('{')) {
    return `${message}. Prokop не перезагрузил конфигурацию: проверьте, что осталось включённое правило с источником подключения.`;
  }
  return message;
}

function requireRouter(job: JobRow): string {
  if (!job.router_id) throw new JobFailure('no_router', 'Задача не привязана к роутеру');
  return job.router_id;
}

async function runCommand(
  ctx: HandlerContext,
  job: JobRow,
  op: string,
  args: Json,
  timeoutMs?: number,
): Promise<Json> {
  const routerId = requireRouter(job);
  const effectiveTimeout = timeoutMs ?? Math.max(15_000, job.timeout_seconds * 1000 - 5_000);
  const command = await createCommand(ctx.pool, {
    routerId,
    jobId: job.id,
    op,
    args,
    settings: ctx.settings,
    ttlSeconds: Math.ceil(effectiveTimeout / 1000) + 120,
  });

  const outcome = await waitForCommand(ctx.pool, command.id, {
    timeoutMs: effectiveTimeout,
    isCancelled: () => isCancelRequested(ctx.pool, job.id),
  });

  if (outcome.status === 'cancelled') {
    throw new JobFailure('cancelled', 'Задача отменена', 'cancelled');
  }
  if (outcome.status === 'timeout') {
    throw new JobFailure('agent_timeout', 'Агент не ответил вовремя', 'timeout');
  }
  if (outcome.status !== 'success') {
    throw new JobFailure(
      outcome.error?.code ?? 'agent_failed',
      outcome.error?.message ?? 'Агент сообщил об ошибке',
    );
  }
  return asRecord(outcome.result);
}

/** Обновляет фазу задачи для прогресс-бара в интерфейсе. */
async function setJobPhase(
  ctx: HandlerContext,
  jobId: string,
  phase: string,
  progress?: number,
): Promise<void> {
  const value = progress == null ? { phase } : { phase, progress };
  await ctx.pool
    .query(
      `update jobs set result = coalesce(result, '{}'::jsonb) || $2::jsonb where id = $1`,
      [jobId, JSON.stringify(value)],
    )
    .catch(() => undefined);
}

async function saveState(
  pool: Pool,
  routerId: string,
  raw: Json,
  source: string,
): Promise<Record<string, UciValue>> {  const managed = sanitizeAgentState(raw.managed ?? raw);
  const hash = stateHash(managed);
  const sections = Array.isArray(raw.sections) ? raw.sections : null;

  await pool.query(
    `insert into router_state (router_id, managed, state_hash, health, service, capabilities, sections, collected_at, source)
     values ($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb, now(), $8)
     on conflict (router_id) do update
       set managed = excluded.managed, state_hash = excluded.state_hash,
           health = coalesce(excluded.health, router_state.health),
           service = coalesce(excluded.service, router_state.service),
           capabilities = coalesce(excluded.capabilities, router_state.capabilities),
           sections = coalesce(excluded.sections, router_state.sections),
           collected_at = now(), source = excluded.source`,
    [
      routerId,
      JSON.stringify(managed),
      hash,
      JSON.stringify(raw.health ?? null),
      JSON.stringify(raw.service ?? null),
      JSON.stringify(raw.capabilities ?? null),
      sections == null ? null : JSON.stringify(sections),
      source,
    ],
  );

  // Секции на роутере не обязаны называться router_control/main. Как только
  // агент присылает состояние, выбираем реальную активную секцию и запоминаем
  // её, чтобы дальше не создавать пустой дубль.
  const current = await pool.query<{ managed_section: string | null }>(
    'select managed_section from routers where id = $1',
    [routerId],
  );
  const currentSection = current.rows[0]?.managed_section ?? null;
  const resolved = resolveManagedSection(managed, currentSection);
  if (resolved && resolved !== currentSection) {
    await pool.query('update routers set managed_section = $2, updated_at = now() where id = $1', [
      routerId,
      resolved,
    ]);
  }

  return managed;
}

async function readState(
  ctx: HandlerContext,
  job: JobRow,
  timeoutMs?: number,
): Promise<Record<string, UciValue>> {
  const raw = await runCommand(ctx, job, 'read_state', {}, timeoutMs);
  return saveState(ctx.pool, requireRouter(job), raw, 'command');
}

export async function loadListExtras(pool: Pool, routerId: string): Promise<RouterListExtras> {
  const result = await pool.query<{ list_extras: unknown }>(
    'select list_extras from routers where id = $1',
    [routerId],
  );
  const raw = result.rows[0]?.list_extras;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RouterListExtras) : {};
}

async function loadRevision(
  pool: Pool,
  templateId: string,
  revision: number,
): Promise<{ payload: TemplatePayload; exclusions: string[] }> {
  const result = await pool.query<{ payload: unknown; exclusions: unknown }>(
    'select payload, exclusions from template_revisions where template_id = $1 and revision = $2',
    [templateId, revision],
  );
  const row = result.rows[0];
  if (!row) throw new JobFailure('revision_missing', 'Ревизия шаблона не найдена');
  return {
    payload: templatePayloadSchema.parse(row.payload),
    exclusions: validateExclusions(Array.isArray(row.exclusions) ? row.exclusions.map(String) : []),
  };
}

export async function refreshState(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const managed = await readState(ctx, job);
  const drift = await recomputeDrift(ctx.pool, routerId, managed);
  return { paths: Object.keys(managed).length, state_hash: stateHash(managed), drift };
}

export async function recomputeDrift(
  pool: Pool,
  routerId: string,
  current: Record<string, UciValue>,
): Promise<Record<string, string>> {
  const assignments = await pool.query<{
    template_id: string;
    revision: number;
    payload: unknown;
    exclusions: unknown;
  }>(
    `select a.template_id, a.revision, r.payload, r.exclusions
       from template_assignments a
       join template_revisions r on r.template_id = a.template_id and r.revision = a.revision
       join templates t on t.id = a.template_id and t.archived_at is null
      where a.router_id = $1`,
    [routerId],
  );

  const result: Record<string, string> = {};
  const extras = await loadListExtras(pool, routerId);
  const productRow = await pool.query<{ product: string; product_version: string | null }>(
    'select product, product_version from routers where id = $1',
    [routerId],
  );
  const product = productRow.rows[0]?.product ?? 'unknown';
  const productVersion = productRow.rows[0]?.product_version ?? null;
  for (const assignment of assignments.rows) {
    try {
      const payload = templatePayloadSchema.parse(assignment.payload);
      const exclusions = Array.isArray(assignment.exclusions)
        ? assignment.exclusions.map(String)
        : [];
      const mapped = mapTemplateSections(payload, current);
      const normalized = await normalizeTemplateLists(mapped.payload, product, productVersion);
      const plan = computePlan(normalized, current, exclusions, extras);
      const drift = plan.items.length === 0 ? 'in_sync' : 'drift';
      result[assignment.template_id] = drift;
      await pool.query(
        `update template_assignments
            set drift = $3, last_checked_at = now(), desired_hash = $4,
                applied_hash = case when $3 = 'in_sync' then $4 else applied_hash end,
                applied_at = case when $3 = 'in_sync' then now() else applied_at end
          where router_id = $1 and template_id = $2`,
        [routerId, assignment.template_id, drift, plan.desiredHash],
      );
    } catch {
      result[assignment.template_id] = 'incompatible';
      await pool.query(
        `update template_assignments set drift = 'incompatible', last_checked_at = now()
          where router_id = $1 and template_id = $2`,
        [routerId, assignment.template_id],
      );
    }
  }
  return result;
}

export async function diffTemplate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const templateId = asString(job.payload.template_id);
  const revision = asNumber(job.payload.revision);
  if (!templateId || revision === null) {
    throw new JobFailure('invalid_payload', 'Не указан шаблон или ревизия');
  }

  const { payload, exclusions } = await loadRevision(ctx.pool, templateId, revision);
  const current = await readState(ctx, job);
  await setJobPhase(ctx, job.id, 'plan', 60);
  const provided = asRecord(job.payload.section_map ?? {});
  const providedMap = Object.fromEntries(
    Object.entries(provided).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string>;

  let mapped;
  if (Object.keys(providedMap).length > 0) {
    for (const target of Object.values(providedMap)) {
      const exists = Object.keys(current).some((path) => path.startsWith(`section.${target}.`));
      if (!exists) {
        throw new JobFailure(
          'section_missing',
          `Секция «${target}» из сопоставления не найдена на роутере. Прочитайте состояние или измените сопоставление.`,
        );
      }
    }
    try {
      mapped = {
        payload: applySectionMap(payload, providedMap),
        sectionMap: providedMap,
        warnings: [],
      };
    } catch (error) {
      throw new JobFailure('section_map_invalid', (error as Error).message.slice(0, 500));
    }
  } else {
    mapped = mapTemplateSections(payload, current);
  }

  const extras = await loadListExtras(ctx.pool, routerId);
  const productRow = await ctx.pool.query<{
    product: string;
    product_version: string | null;
    managed_section: string | null;
  }>('select product, product_version, managed_section from routers where id = $1', [routerId]);
  const product = productRow.rows[0]?.product ?? 'unknown';
  const productVersion = productRow.rows[0]?.product_version ?? null;
  const managedSection = productRow.rows[0]?.managed_section ?? 'main';
  mapped = {
    ...mapped,
    payload: await normalizeTemplateLists(mapped.payload, product, productVersion),
  };

  if (product === 'podkop') {
    const sectionNames = new Set([
      ...Object.keys(mapped.payload.sections),
      ...mapped.payload.create_sections,
    ]);
    if (sectionNames.size > 1) {
      throw new JobFailure(
        'podkop_template_section_required',
        'Шаблон Podkop должен содержать не более одной секции',
      );
    }
    const section = sectionNames.size === 1 ? [...sectionNames][0]! : managedSection;
    const poptions = podkopTemplateInput(mapped.payload, section);
    const plan = computePodkopPlan(poptions, current);
    const items = plan.items;
    const hash = diffHash(items);
    const baseHash = stateHash(current);
    const runId = uuidv7();
    await ctx.pool.query(
      `insert into apply_runs
         (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, desired_hash,
          local_lists, section_map, create_sections, status, requested_by)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,'awaiting_confirmation',$12)`,
      [
        runId,
        routerId,
        templateId,
        revision,
        JSON.stringify(items),
        hash,
        baseHash,
        plan.desiredHash,
        JSON.stringify([]),
        JSON.stringify(mapped.sectionMap),
        JSON.stringify(plan.createSections),
        job.requested_by,
      ],
    );
    let seq = 1;
    for (const item of items) {
      await ctx.pool.query(
        `insert into apply_items (apply_run_id, seq, op, path, value_before, value_after)
         values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [
          runId,
          seq++,
          item.op,
          item.path,
          item.before === null ? null : JSON.stringify(item.before),
          item.after === null ? null : JSON.stringify(item.after),
        ],
      );
    }
    const counts = {
      add: items.filter((item) => item.op === 'add').length,
      change: items.filter((item) => item.op === 'change').length,
      delete: items.filter((item) => item.op === 'delete').length,
    };
    await setJobPhase(ctx, job.id, 'done', 100);
    return {
      apply_run_id: runId,
      diff_hash: hash,
      base_state_hash: baseHash,
      desired_hash: plan.desiredHash,
      counts,
      total: items.length,
      section_map: mapped.sectionMap,
      warnings: [...mapped.warnings, ...plan.warnings],
    };
  }

  const plan = computePlan(mapped.payload, current, exclusions, extras);
  const items = plan.items;
  const hash = diffHash(items);
  const baseHash = stateHash(current);
  const desiredHash = plan.desiredHash;

  const runId = uuidv7();
  await ctx.pool.query(
    `insert into apply_runs
       (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, desired_hash,
        local_lists, section_map, create_sections, status, requested_by)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,'awaiting_confirmation',$12)`,
    [
      runId,
      routerId,
      templateId,
      revision,
      JSON.stringify(items),
      hash,
      baseHash,
      desiredHash,
      JSON.stringify(plan.localLists),
      JSON.stringify(mapped.sectionMap),
      JSON.stringify(plan.createSections),
      job.requested_by,
    ],
  );

  let seq = 1;
  for (const item of items) {
    await ctx.pool.query(
      `insert into apply_items (apply_run_id, seq, op, path, value_before, value_after)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        runId,
        seq++,
        item.op,
        item.path,
        item.before === null ? null : JSON.stringify(item.before),
        item.after === null ? null : JSON.stringify(item.after),
      ],
    );
  }

  const counts = {
    add: items.filter((item) => item.op === 'add').length,
    change: items.filter((item) => item.op === 'change').length,
    delete: items.filter((item) => item.op === 'delete').length,
  };

  await recomputeDrift(ctx.pool, routerId, current);
  await setJobPhase(ctx, job.id, 'done', 100);

  return {
    apply_run_id: runId,
    diff_hash: hash,
    base_state_hash: baseHash,
    desired_hash: desiredHash,
    counts,
    total: items.length,
    section_map: mapped.sectionMap,
    warnings: mapped.warnings,
  };
}

/**
 * Сравнение для ручного правила или применённого шаблона-пресета.
 * В отличие от diffTemplatepayload приходит целиком в задаче: шаблон уже
 * развёрнут в секцию, поэтому имя секции здесь есть, а в самом шаблоне его нет.
 */
export async function diffCustom(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const payload = templatePayloadSchema.parse(job.payload.payload);
  const exclusions = validateExclusions(
    Array.isArray(job.payload.exclusions) ? job.payload.exclusions.map(String) : [],
  );

  const current = await readState(ctx, job);
  await setJobPhase(ctx, job.id, 'plan', 60);
  const extras = await loadListExtras(ctx.pool, routerId);
  const productRow = await ctx.pool.query<{ product: string; product_version: string | null }>(
    'select product, product_version from routers where id = $1',
    [routerId],
  );
  const normalized = await normalizeTemplateLists(
    payload,
    productRow.rows[0]?.product ?? 'unknown',
    productRow.rows[0]?.product_version ?? null,
  );
  const plan = computePlan(normalized, current, exclusions, extras);
  const items = plan.items;
  const hash = diffHash(items);
  const baseHash = stateHash(current);
  const desiredHash = plan.desiredHash;

  const runId = uuidv7();
  await ctx.pool.query(
    `insert into apply_runs
       (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, desired_hash,
        local_lists, section_map, create_sections, status, requested_by)
     values ($1,$2,null,null,$3::jsonb,$4,$5,$6,$7::jsonb,'{}'::jsonb,$8::jsonb,'awaiting_confirmation',$9)`,
    [
      runId,
      routerId,
      JSON.stringify(items),
      hash,
      baseHash,
      desiredHash,
      JSON.stringify(plan.localLists),
      JSON.stringify(plan.createSections),
      job.requested_by,
    ],
  );

  let seq = 1;
  for (const item of items) {
    await ctx.pool.query(
      `insert into apply_items (apply_run_id, seq, op, path, value_before, value_after)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        runId,
        seq++,
        item.op,
        item.path,
        item.before === null ? null : JSON.stringify(item.before),
        item.after === null ? null : JSON.stringify(item.after),
      ],
    );
  }

  const counts = {
    add: items.filter((item) => item.op === 'add').length,
    change: items.filter((item) => item.op === 'change').length,
    delete: items.filter((item) => item.op === 'delete').length,
  };

  await recomputeDrift(ctx.pool, routerId, current);
  await setJobPhase(ctx, job.id, 'done', 100);

  return {
    apply_run_id: runId,
    diff_hash: hash,
    base_state_hash: baseHash,
    desired_hash: desiredHash,
    counts,
    total: items.length,
    section_map: {},
    warnings: [],
  };
}

/**
 * Diff одной секции Podkop. План строится только по явно переданным полям,
 * поэтому остальные секции и опции Podkop не затрагиваются.
 */
export async function diffPodkop(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const payload = podkopSectionInputSchema.parse(job.payload.payload);
  const current = await readState(ctx, job);
  await setJobPhase(ctx, job.id, 'plan', 60);
  const plan = computePodkopPlan(payload, current);
  const items = plan.items;
  const hash = diffHash(items);
  const baseHash = stateHash(current);

  const runId = uuidv7();
  await ctx.pool.query(
    `insert into apply_runs
       (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, desired_hash,
        local_lists, section_map, create_sections, status, requested_by)
     values ($1,$2,null,null,$3::jsonb,$4,$5,$6,$7::jsonb,'{}'::jsonb,$8::jsonb,'awaiting_confirmation',$9)`,
    [
      runId,
      routerId,
      JSON.stringify(items),
      hash,
      baseHash,
      plan.desiredHash,
      JSON.stringify([]),
      JSON.stringify(plan.createSections),
      job.requested_by,
    ],
  );

  let seq = 1;
  for (const item of items) {
    await ctx.pool.query(
      `insert into apply_items (apply_run_id, seq, op, path, value_before, value_after)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        runId,
        seq++,
        item.op,
        item.path,
        item.before === null ? null : JSON.stringify(item.before),
        item.after === null ? null : JSON.stringify(item.after),
      ],
    );
  }

  const counts = {
    add: items.filter((item) => item.op === 'add').length,
    change: items.filter((item) => item.op === 'change').length,
    delete: items.filter((item) => item.op === 'delete').length,
  };

  await setJobPhase(ctx, job.id, 'done', 100);
  return {
    apply_run_id: runId,
    diff_hash: hash,
    base_state_hash: baseHash,
    desired_hash: plan.desiredHash,
    counts,
    total: items.length,
    section_map: {},
    warnings: plan.warnings,
  };
}

export async function podkopOutbound(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const section = asString(job.payload.section);
  const outbound = asString(job.payload.outbound_json);
  if (!section || !outbound) {
    throw new JobFailure('invalid_payload', 'Не указана секция или outbound JSON');
  }
  await setJobPhase(ctx, job.id, 'apply', 30);
  const result = await runCommand(
    ctx,
    job,
    'set_podkop_outbound',
    { section, outbound_json: outbound },
    240_000,
  );
  await setJobPhase(ctx, job.id, 'verify', 80);
  try {
    const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    await saveState(ctx.pool, routerId, raw, 'podkop_outbound');
  } catch {
    // Конфиг уже применён; неудачное чтение не отменяет результат.
  }
  await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
    routerId,
  ]);
  await setJobPhase(ctx, job.id, 'done', 100);
  return result;
}

export async function proxySelect(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const group = asString(job.payload.group);
  const tag = asString(job.payload.tag);
  if (!group || !tag) throw new JobFailure('invalid_payload', 'Не указана группа или прокси');
  const raw = await runCommand(ctx, job, 'select_proxy', { group, tag }, 60_000);
  try {
    const rules = await runCommand(ctx, job, 'read_rules', {}, 90_000);
    await saveState(ctx.pool, routerId, rules, 'proxy_select');
  } catch {
    // Переключение уже выполнено; неудачное обновление статуса не отменяет его.
  }
  await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
    routerId,
  ]);
  return raw;
}

function expectedState(items: DiffItem[]): Map<string, UciValue> {
  const expected = new Map<string, UciValue>();
  for (const item of items) {
    if (item.after !== null) expected.set(item.path, item.after);
  }
  return expected;
}

function verifyApplied(expected: Map<string, UciValue>, current: Record<string, UciValue>): string[] {
  const mismatched: string[] = [];
  for (const [path, value] of expected) {
    const actual = current[path];
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(value)) {
      mismatched.push(path);
    }
  }
  return mismatched;
}

export async function applyRun(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const applyRunId = asString(job.payload.apply_run_id);
  if (!applyRunId) throw new JobFailure('invalid_payload', 'Не указан идентификатор применения');

  const runResult = await ctx.pool.query<{
    id: string;
    router_id: string;
    template_id: string | null;
    revision: number | null;
    diff: unknown;
    diff_hash: string;
    base_state_hash: string | null;
    desired_hash: string | null;
    local_lists: unknown;
    section_map: unknown;
    create_sections: unknown;
    status: string;
    backup_ok: boolean;
  }>('select * from apply_runs where id = $1', [applyRunId]);
  const run = runResult.rows[0];
  if (!run) throw new JobFailure('apply_run_missing', 'Применение не найдено');
  if (run.router_id !== routerId) throw new JobFailure('apply_run_mismatch', 'Применение относится к другому роутеру');
  if (run.status !== 'awaiting_confirmation' && run.status !== 'queued') {
    throw new JobFailure('apply_run_state', `Применение уже в состоянии «${run.status}»`);
  }

  const items = Array.isArray(run.diff) ? (run.diff as DiffItem[]) : [];
  await ctx.pool.query(
    `update apply_runs set status = 'running', started_at = now(), confirmed_at = coalesce(confirmed_at, now())
      where id = $1`,
    [applyRunId],
  );
  await setJobPhase(ctx, job.id, 'snapshot', 5);

  // 1. Обязательный снимок перед любыми изменениями.
  let snapshotRef: string | null = null;
  try {
    const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'apply' }, 90_000);
    snapshotRef =
      asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
    await ctx.pool.query(
      `insert into router_snapshots
         (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
       values ($1,$2,$3,$4,'apply',$5,$6,$7, now() + ($8 || ' days')::interval)`,
      [
        uuidv7(),
        routerId,
        asString(snapshot.kind) === 'native' ? 'native' : 'local',
        snapshotRef,
        asString(snapshot.sha256),
        asNumber(snapshot.size_bytes),
        asString(snapshot.product_version),
        ctx.settings.retention.days,
      ],
    );
    await ctx.pool.query(
      'update apply_runs set snapshot_ref = $2, backup_ok = true where id = $1',
      [applyRunId, snapshotRef],
    );
    await setJobPhase(ctx, job.id, 'apply', 30);
  } catch (error) {
    await ctx.pool.query(
      `update apply_runs set status = 'failed', finished_at = now(),
              error_code = 'backup_failed', error_detail = $2
        where id = $1`,
      [applyRunId, (error as Error).message.slice(0, 500)],
    );
    throw new JobFailure(
      'backup_failed',
      `Не удалось создать резервный снимок, изменения не применены: ${(error as Error).message}`,
    );
  }

  // 2. Запись UCI с проверкой базового состояния на агенте.
  try {
    let createSections: string[] = Array.isArray(run.create_sections)
      ? run.create_sections.map(String)
      : [];
    if (createSections.length === 0 && run.template_id && run.revision !== null) {
      const revision = await loadRevision(ctx.pool, run.template_id, run.revision);
      createSections = creatableSections(revision.payload);
    }
    await runCommand(
      ctx,
      job,
      'apply_uci',
      {
        items,
        base_state_hash: run.base_state_hash,
        create_sections: createSections,
        local_lists: Array.isArray(run.local_lists) ? run.local_lists : [],
      },
      Math.max(60_000, job.timeout_seconds * 1000 - 10_000),
    );
    await setJobPhase(ctx, job.id, 'reload', 60);

    // 3. Перезагрузка и проверка результата чтением состояния.
    await runCommand(ctx, job, 'reload', {}, 300_000);
    await setJobPhase(ctx, job.id, 'verify', 85);
    const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    const current = await saveState(ctx.pool, routerId, raw, 'verify');
    const mismatched = verifyApplied(expectedState(items), current);

    if (mismatched.length > 0) {
      throw new JobFailure(
        'verify_mismatch',
        `После применения не совпадают параметры: ${mismatched.slice(0, 5).join(', ')}`,
      );
    }

    await ctx.pool.query(
      `update apply_runs set status = 'success', finished_at = now(), error_code = null, error_detail = null
        where id = $1`,
      [applyRunId],
    );
    await ctx.pool.query(
      `update apply_items set result = 'ok' where apply_run_id = $1`,
      [applyRunId],
    );
    if (run.template_id && run.revision !== null && run.desired_hash) {
      await ctx.pool.query(
        `update template_assignments
            set applied_hash = $3, applied_at = now(), drift = 'in_sync', last_checked_at = now()
          where router_id = $1 and template_id = $2`,
        [routerId, run.template_id, run.desired_hash],
      );
    }

    await notifyRouterOwner(ctx.pool, routerId, {
      kind: 'apply.success',
      severity: 'info',
      message: `Конфигурация применена: ${items.length} изменений`,
      dedupeKey: `apply:${applyRunId}`,
    });
    await setJobPhase(ctx, job.id, 'done', 100);

    return {
      apply_run_id: applyRunId,
      applied: items.length,
      snapshot: snapshotRef,
      verified: true,
    };
  } catch (error) {
    const failure =
      error instanceof JobFailure
        ? error
        : new JobFailure('apply_failed', (error as Error).message.slice(0, 500));
    await ctx.pool.query(
      `update apply_items set result = 'failed', error_code = $2 where apply_run_id = $1`,
      [applyRunId, failure.code],
    );

    let rollback: 'ok' | 'failed' | 'skipped' = 'skipped';
    let rollbackError: string | null = null;
    if (snapshotRef) {
      await setJobPhase(ctx, job.id, 'rollback', 90);
      try {
        await runCommand(ctx, job, 'snapshot_restore', { snapshot: snapshotRef, kind: 'local' }, 180_000);
        await runCommand(ctx, job, 'reload', {}, 300_000);
        const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
        await saveState(ctx.pool, routerId, raw, 'rollback');
        rollback = 'ok';
      } catch (restoreError) {
        rollback = 'failed';
        rollbackError = (restoreError as Error).message.slice(0, 500);
      }
    }

    await setJobPhase(
      ctx,
      job.id,
      rollback === 'ok' ? 'rolled_back' : 'failed',
      100,
    );

    const status = rollback === 'ok' ? 'rolled_back' : rollback === 'failed' ? 'rollback_failed' : 'needs_attention';
    await ctx.pool.query(
      `update apply_runs set status = $2, finished_at = now(), error_code = $3, error_detail = $4
        where id = $1`,
      [applyRunId, status, failure.code, prokopReloadHint(failure.message).slice(0, 500)],
    );

    await notifyRouterOwner(ctx.pool, routerId, {
      kind: rollback === 'ok' ? 'apply.rolled_back' : 'apply.failed',
      severity: 'critical',
      message:
        rollback === 'ok'
          ? `Применение не удалось и было откачено: ${prokopReloadHint(failure.message)}`
          : `Применение не удалось (${prokopReloadHint(failure.message)}). Требуется ручная проверка.`,
      dedupeKey: `apply:${applyRunId}:${status}`,
    });

    // Задача должна завершиться failed, даже если откат прошёл успешно.
    throw new JobFailure(
      failure.code,
      `${prokopReloadHint(failure.message)} (${rollback === 'ok' ? 'изменения откачены' : rollback === 'failed' ? `откат не удался: ${rollbackError ?? 'ошибка'}` : 'требуется ручная проверка'})`,
      failure.terminal,
    );
  }
}

export function proxyHealthOf(sample: Json, settings: PlatformSettings): 'healthy' | 'degraded' | 'dead' | 'unknown' {
  const explicit = asString(sample.proxy_health);
  const explicitLatency = asNumber(sample.latency_ms);
  const failed = asNumber(sample.failed_tags) ?? 0;
  const total = asNumber(sample.total_tags) ?? 0;
  const slow = explicitLatency !== null && explicitLatency > settings.monitoring.latencyDegradedMs;

  if (explicit === 'healthy' || explicit === 'degraded' || explicit === 'dead') {
    if (explicit === 'dead') return 'dead';
    if (slow) return 'degraded';
    // Пока в группе есть живые соединения, она работает: переключение на
    // резервный сервер не считается деградацией. Упавшие теги видны в
    // статистике нестабильных соединений, а не в статусе группы.
    if (explicit === 'degraded' && total > 0) {
      return failed >= total ? 'dead' : 'healthy';
    }
    return explicit;
  }
  if (total > 0 && failed >= total) return 'dead';
  if (slow) return 'degraded';
  return total > 0 ? 'healthy' : 'unknown';
}

function leadingStateCount(
  rows: Array<{ proxy_health: string | null }>,
  state: string,
): number {
  let count = 0;
  for (const row of rows) {
    if (row.proxy_health !== state) break;
    count += 1;
  }
  return count;
}

/**
 * Была ли по роутеру отправлена нотификация указанного типа за последние
 * `minutes` минут. Нужна, чтобы один и тот же сбой не присылал push на каждой
 * проверке и не зависел от границ часовых интервалов.
 */
async function notifiedSince(
  pool: Pool,
  routerId: string,
  kind: string,
  minutes: number,
): Promise<boolean> {
  const result = await pool.query(
    `select 1 from notifications
      where router_id = $1 and kind = $2
        and created_at > now() - ($3::int * interval '1 minute')
      limit 1`,
    [routerId, kind, Math.max(1, Math.round(minutes))],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Есть ли уже уведомление этого типа в текущем эпизоде состояния прокси.
 * Эпизод начинается после последней проверки с другим статусом. Так одно
 * длительное ухудшение присылает одно сообщение, а не напоминание каждый час.
 */
async function notifiedInProxyEpisode(
  pool: Pool,
  routerId: string,
  kind: string,
  state: string,
): Promise<boolean> {
  const boundary = await pool.query<{ last_other: Date | null }>(
    `select max(ts) as last_other from monitoring_samples
      where router_id = $1 and proxy_health is distinct from $2`,
    [routerId, state],
  );
  const since = boundary.rows[0]?.last_other ?? null;
  const result = await pool.query(
    `select 1 from notifications
      where router_id = $1 and kind = $2
        and ($3::timestamptz is null or created_at > $3)
      limit 1`,
    [routerId, kind, since],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Структурированные детали замера: текст для человека, группа, активное
 * соединение и список не ответивших тегов. По списку строится статистика
 * нестабильных соединений за 24 часа.
 */
function probeDetailOf(sample: Json): Json {
  const out: Json = {};
  const detail = asString(sample.detail);
  if (detail) out.detail = detail;
  const group = asString(sample.group);
  if (group) out.group = group;
  const activeTag = asString(sample.active_tag);
  if (activeTag) out.active_tag = activeTag;
  const failedTagNames = Array.isArray(sample.failed_tag_names)
    ? sample.failed_tag_names
        .map((value) => asString(value))
        .filter((value): value is string => value !== null)
        .slice(0, 50)
    : null;
  if (failedTagNames !== null) out.failed_tag_names = failedTagNames;
  return out;
}

export async function monitorProbe(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const raw = await runCommand(
    ctx,
    job,
    'monitor_probe',
    { force: job.payload.force === true },
    45_000,
  );

  const reachable = raw.reachable !== false;
  const proxyHealth = proxyHealthOf(raw, ctx.settings);
  const serviceHealth = asString(raw.health) || asString(raw.service_state) || null;
  const latency = asNumber(raw.latency_ms);
  const failed = asNumber(raw.failed_tags);
  const total = asNumber(raw.total_tags);
  const directIp = asString(raw.direct_ip) || null;
  const vpnIp = asString(raw.vpn_ip) || null;

  await ctx.pool.query(
    `insert into monitoring_samples
       (router_id, ts, reachable, service_state, health, proxy_health, latency_ms,
        failed_tags, total_tags, sing_box_version, agent_version, detail, direct_ip, vpn_ip)
     values ($1, now(), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
     on conflict (router_id, ts) do nothing`,
    [
      routerId,
      reachable,
      asString(raw.service_state),
      serviceHealth,
      proxyHealth,
      latency,
      failed,
      total,
      asString(raw.sing_box_version),
      asString(raw.agent_version),
      JSON.stringify(probeDetailOf(raw)),
      directIp,
      vpnIp,
    ],
  );

  await ctx.pool.query(
    `update routers set sing_box_version = coalesce($2, sing_box_version), updated_at = now()
      where id = $1`,
    [routerId, asString(raw.sing_box_version)],
  );

  // Переходы состояния прокси: попап «VPN не работает» и «VPN снова работает».
  // Не показываем «VPN не работает» во время планового перезапуска VPN
  // и сразу после перезагрузки роутера: это ожидаемо, а не авария.
  const recentRestart = await ctx.pool.query(
    `select 1 from jobs
      where router_id = $1 and type = 'service_action' and status = 'success'
        and finished_at > now() - interval '90 seconds'
      limit 1`,
    [routerId],
  );
  const rebootPending = await ctx.pool.query(
    `select 1 from routers
      where id = $1 and reboot_requested_at is not null
        and reboot_requested_at > now() - interval '10 minutes'`,
    [routerId],
  );
  const suppressProxy =
    (recentRestart.rowCount ?? 0) > 0 || (rebootPending.rowCount ?? 0) > 0;

  if (!suppressProxy && reachable && proxyHealth && proxyHealth !== 'unknown') {
    const degradedAfter = Math.max(2, ctx.settings.monitoring.degradedAfterSamples);
    const degradedCooldown = Math.max(30, ctx.settings.monitoring.degradedCooldownMinutes);
    const history = await ctx.pool.query<{ proxy_health: string | null }>(
      `select proxy_health from monitoring_samples
        where router_id = $1 order by ts desc limit $2`,
      [routerId, Math.max(10, degradedAfter + 2)],
    );
    const streak = leadingStateCount(history.rows, proxyHealth);

    if (proxyHealth === 'dead') {
      // Полный отказ подтверждаем двумя проверками подряд.
      if (streak >= 2) {
        const alreadySent = await notifiedInProxyEpisode(
          ctx.pool,
          routerId,
          'proxy.offline',
          'dead',
        );
        const inCooldown = await notifiedSince(ctx.pool, routerId, 'proxy.offline', 60);
        if (!alreadySent && !inCooldown) {
          const bucket = new Date().toISOString().slice(0, 13);
          await notifyRouterOwner(ctx.pool, routerId, {
            kind: 'proxy.offline',
            severity: 'critical',
            message: 'VPN не работает: прокси не отвечает',
            dedupeKey: `proxy-dead:${routerId}:${bucket}`,
          });
        }
      }
    } else if (proxyHealth === 'degraded') {
      // Деградация часто мигает: ждём несколько плохих проверок подряд,
      // отправляем одно сообщение на эпизод и держим паузу между эпизодами.
      if (streak >= degradedAfter) {
        const alreadySent = await notifiedInProxyEpisode(
          ctx.pool,
          routerId,
          'proxy.degraded',
          'degraded',
        );
        const inCooldown = await notifiedSince(
          ctx.pool,
          routerId,
          'proxy.degraded',
          degradedCooldown,
        );
        if (!alreadySent && !inCooldown) {
          const bucket = Math.floor(Date.now() / (degradedCooldown * 60_000));
          await notifyRouterOwner(ctx.pool, routerId, {
            kind: 'proxy.degraded',
            severity: 'warning',
            message: 'VPN работает с перебоями: часть прокси не отвечает',
            dedupeKey: `proxy-degraded:${routerId}:${bucket}`,
          });
        }
      }
    } else if (proxyHealth === 'healthy' && streak >= 2) {
      // Восстановление отправляем один раз и только если до этого был
      // реальный тревожный эпизод, а не короткий всплеск задержки.
      if (ctx.settings.monitoring.recoveryNotify) {
        const state = await ctx.pool.query<{
          last_alert: Date | null;
          last_online: Date | null;
        }>(
          `select
             (select max(created_at) from notifications
               where router_id = $1 and kind in ('proxy.degraded','proxy.offline')) as last_alert,
             (select max(created_at) from notifications
               where router_id = $1 and kind = 'proxy.online') as last_online`,
          [routerId],
        );
        const lastAlert = state.rows[0]?.last_alert ?? null;
        const lastOnline = state.rows[0]?.last_online ?? null;
        if (lastAlert && (!lastOnline || lastAlert > lastOnline)) {
          const bucket = new Date().toISOString().slice(0, 13);
          await notifyRouterOwner(ctx.pool, routerId, {
            kind: 'proxy.online',
            severity: 'info',
            message: 'VPN снова работает',
            dedupeKey: `proxy-online:${routerId}:${bucket}`,
          });
        }
      }
    }
  }

  if (!reachable) {
    const availability = await ctx.pool.query<{ misses: number; offline_since: Date | null }>(
      `insert into router_availability (router_id, misses, last_transition)
       values ($1, 1, now())
       on conflict (router_id) do update
         set misses = router_availability.misses + 1, last_transition = now()
       returning misses, offline_since`,
      [routerId],
    );
    const misses = availability.rows[0]?.misses ?? 1;
    if (misses >= ctx.settings.monitoring.offlineAfterMisses) {
      const changed = await ctx.pool.query(
        `update router_availability
            set offline_since = coalesce(offline_since, now()), online_since = null
          where router_id = $1 and offline_since is null`,
        [routerId],
      );
      await ctx.pool.query(`update routers set status = 'offline', updated_at = now() where id = $1`, [
        routerId,
      ]);
      if ((changed.rowCount ?? 0) > 0 && (rebootPending.rowCount ?? 0) === 0) {
        await notifyRouterOwner(ctx.pool, routerId, {
          kind: 'router.offline',
          severity: 'critical',
          message: 'Роутер недоступен: пропущено подряд проверок — ' + misses,
          dedupeKey: `offline:${routerId}:${new Date().toISOString().slice(0, 13)}`,
        });
      }
    }
  } else {
    const changed = await ctx.pool.query(
      `insert into router_availability (router_id, online_since, misses, last_transition)
       values ($1, now(), 0, now())
       on conflict (router_id) do update
         set online_since = now(), offline_since = null, misses = 0, last_transition = now()
       returning (xmax = 0) as inserted`,
      [routerId],
    );
    void changed;
    await ctx.pool.query(
      `update routers set status = 'online', updated_at = now()
        where id = $1 and status in ('offline','pending')`,
      [routerId],
    );
  }

  return {
    reachable,
    service_health: serviceHealth,
    proxy_health: proxyHealth,
    latency_ms: latency,
    failed_tags: failed,
    total_tags: total,
    direct_ip: directIp,
    vpn_ip: vpnIp,
  };
}

export async function accessCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const target =
    asString(job.payload.target) || 'https://www.youtube.com/generate_204';
  const raw = await runCommand(ctx, job, 'access_check', { target }, 45_000);

  if (raw.ok === false) {
    throw new JobFailure(
      asString(raw.error) || 'access_check_failed',
      asString(raw.message) || 'Запрос через прокси не прошёл',
    );
  }

  return {
    ok: true,
    target: asString(raw.target) || target,
    proxy_tag: asString(raw.proxy_tag),
    group: asString(raw.group),
    latency_ms: asNumber(raw.latency_ms),
  };
}

export async function siteCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const targets = Array.isArray(job.payload.targets)
    ? job.payload.targets.map((value) => asString(value)).filter(Boolean)
    : [];
  if (targets.length === 0) {
    throw new JobFailure('no_targets', 'Нет адресов для проверки');
  }

  const raw = await runCommand(ctx, job, 'site_probe', { targets }, 90_000);
  if (raw.ok === false) {
    throw new JobFailure(
      asString(raw.error) || 'site_check_failed',
      asString(raw.message) || 'Не удалось проверить сайты',
    );
  }

  const results = Array.isArray(raw.results) ? raw.results : [];
  return { router_id: routerId, results };
}

export async function agentUpdate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const base = ctx.publicUrl.replace(/\/+$/, '');
  const raw = await runCommand(ctx, job, 'self_update', { base_url: base }, 120_000);
  if (raw.ok === false) {
    throw new JobFailure(
      asString(raw.error) || 'agent_update_failed',
      asString(raw.message) || 'Агент не принял обновление',
    );
  }
  return {
    router_id: routerId,
    scheduled: true,
    kind: asString(raw.kind),
    version: asString(raw.version) || null,
  };
}

export async function diagnostics(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const kind = job.payload.kind === 'full' ? 'full' : 'quick';
  const op = kind === 'full' ? 'diagnostics_full' : 'diagnostics_quick';
  const raw = await runCommand(ctx, job, op, {}, kind === 'full' ? 180_000 : 90_000);

  const router = await ctx.pool.query<{ product: string; agent_version: string | null }>(
    'select product, agent_version from routers where id = $1',
    [routerId],
  );

  const report = sanitizeReport(raw.report ?? raw) as Json;
  const text = asString(raw.text);
  const sanitizedText = text ? maskSecrets(text).slice(0, 1_000_000) : null;
  const json = JSON.stringify(report);
  const digest = sha256Hex(json + (sanitizedText ?? ''));

  const id = uuidv7();
  await ctx.pool.query(
    `insert into diagnostics_reports
       (id, router_id, job_id, kind, product, agent_version, report, report_text, sha256, size_bytes, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10, now() + ($11 || ' days')::interval)`,
    [
      id,
      routerId,
      job.id,
      kind,
      router.rows[0]?.product ?? 'unknown',
      router.rows[0]?.agent_version,
      JSON.stringify(report),
      sanitizedText,
      digest,
      Buffer.byteLength(json + (sanitizedText ?? ''), 'utf8'),
      ctx.settings.retention.days,
    ],
  );

  return { report_id: id, kind, sha256: digest };
}

export async function snapshot(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const reason = asString(job.payload.reason) ?? 'manual';
  const raw = await runCommand(ctx, job, 'snapshot_create', { reason }, 120_000);

  const externalId = asString(raw.external_id) ?? asString(raw.id);
  const id = uuidv7();
  await ctx.pool.query(
    `insert into router_snapshots
       (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' days')::interval)`,
    [
      id,
      routerId,
      asString(raw.kind) === 'native' ? 'native' : 'local',
      externalId,
      reason,
      asString(raw.sha256),
      asNumber(raw.size_bytes),
      asString(raw.product_version),
      ctx.settings.retention.days,
    ],
  );

  return { snapshot_id: id, external_id: externalId };
}

export async function restoreSnapshot(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const snapshotId = asString(job.payload.snapshot_id);
  if (!snapshotId) throw new JobFailure('invalid_payload', 'Не указан снимок');

  const found = await ctx.pool.query<{
    external_id: string | null;
    kind: string;
  }>('select external_id, kind from router_snapshots where id = $1 and router_id = $2', [
    snapshotId,
    routerId,
  ]);
  const snap = found.rows[0];
  if (!snap) throw new JobFailure('snapshot_missing', 'Снимок не найден');

  await runCommand(
    ctx,
    job,
    'snapshot_restore',
    { snapshot: snap.external_id ?? snapshotId, kind: snap.kind },
    180_000,
  );
  await runCommand(ctx, job, 'reload', {}, 300_000);
  const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
  await saveState(ctx.pool, routerId, raw, 'restore');

  return { restored: snapshotId };
}

export async function singBoxCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const raw = await runCommand(ctx, job, 'sb_check_update', {}, 120_000);
  const routerId = requireRouter(job);
  const version = asString(raw.version) ?? asString(raw.current_version);
  const variant = asString(raw.variant);
  if (version || variant) {
    await ctx.pool.query(
      `update routers set
          sing_box_version = coalesce($2, sing_box_version),
          sing_box_variant = coalesce($3, sing_box_variant),
          updated_at = now()
        where id = $1`,
      [routerId, version, variant],
    );
  }

  return {
    current_version: asString(raw.current_version) ?? version,
    latest_version: asString(raw.latest_version),
    status: asString(raw.status),
    release_url: asString(raw.release_url),
    message: asString(raw.message),
    variant,
  };
}

export async function singBoxInstall(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const variant = asString(job.payload.variant);
  const versionTag = asString(job.payload.version_tag);
  if (!variant && !versionTag) {
    throw new JobFailure('invalid_payload', 'Не указан вариант или версия sing-box');
  }

  const normalizeVersion = (value: string | null | undefined): string =>
    (value ?? '').trim().replace(/-r\d+$/, '');
  const normalizeVariant = (value: string | null | undefined): string =>
    (value ?? '').trim().replace(/-/g, '_');

  const before = await ctx.pool.query<{
    sing_box_version: string | null;
    sing_box_variant: string | null;
  }>('select sing_box_version, sing_box_variant from routers where id = $1', [routerId]);
  let previous = before.rows[0]?.sing_box_version ?? null;
  let previousVariant = before.rows[0]?.sing_box_variant ?? null;

  // Сверяемся с фактическим бинарником перед удалением: БД может быть
  // устаревшей, а без точной предыдущей версии откат будет неполным.
  try {
    const current = await runCommand(ctx, job, 'verify', {}, 20_000);
    const actualVersion = asString(current.version);
    const actualVariant = asString(current.variant);
    if (actualVersion) previous = actualVersion;
    if (actualVariant) previousVariant = actualVariant;
  } catch (error) {
    ctx.log.warn({ err: error, routerId }, 'не удалось прочитать текущую версию sing-box перед установкой');
  }
  const timeout = 300_000;

  try {
    const installed = await runCommand(
      ctx,
      job,
      'sb_install',
      { variant, version_tag: versionTag },
      timeout,
    );

    await runCommand(ctx, job, 'reload', {}, 300_000);
    const verify = await runCommand(ctx, job, 'verify', {}, 60_000);
    if (verify.ok === false) {
      throw new JobFailure('post_install_verify_failed', 'Проверка после установки не пройдена');
    }

    const newVersion =
      asString(verify.version) ?? asString(installed.version) ?? versionTag ?? 'unknown';
    const newVariant =
      asString(verify.variant) ?? asString(installed.variant) ?? variant ?? null;

    await ctx.pool.query(
      `update routers set
          sing_box_previous_version = sing_box_version,
          sing_box_previous_variant = sing_box_variant,
          sing_box_version = $2,
          sing_box_variant = $3,
          sing_box_installed_at = now(),
          updated_at = now()
        where id = $1`,
      [routerId, newVersion, newVariant],
    );

    if (asString(job.payload.rollout_id)) {
      await ctx.pool.query(
        `update rollout_targets set status = 'success', finished_at = now(), previous_version = $3
          where rollout_id = $1 and router_id = $2`,
        [job.payload.rollout_id, routerId, previous],
      );
    }

    return {
      version: newVersion,
      variant: newVariant,
      previous,
      previous_variant: previousVariant,
      action: asString(installed.action),
    };
  } catch (error) {
    const failure =
      error instanceof JobFailure
        ? error
        : new JobFailure('sb_install_failed', (error as Error).message.slice(0, 500));

    // Проверяем, изменился ли реальный вариант/версия. Если upstream отказал
    // до удаления текущего пакета (например, не хватило места), откат не нужен
    // и только тратит место/время.
    let currentVersion = previous;
    let currentVariant = previousVariant;
    let verifyOk = false;
    try {
      const current = await runCommand(ctx, job, 'verify', {}, 20_000);
      const actualVersion = asString(current.version);
      const actualVariant = asString(current.variant);
      if (actualVersion) {
        currentVersion = actualVersion;
        verifyOk = true;
      }
      if (actualVariant) currentVariant = actualVariant;
    } catch (verifyError) {
      ctx.log.warn({ err: verifyError, routerId }, 'не удалось проверить sing-box после ошибки установки');
    }
    const unchanged =
      verifyOk &&
      Boolean(previousVariant || previous) &&
      normalizeVariant(currentVariant) === normalizeVariant(previousVariant) &&
      normalizeVersion(currentVersion) === normalizeVersion(previous);

    // Возвращаем предыдущий вариант/версию. Prokop при смене варианта сначала
    // удаляет текущий пакет, поэтому без этого шага роутер может остаться без sing-box.
    let rollback: 'ok' | 'failed' | 'skipped' = 'skipped';
    let rollbackError: string | null = null;
    if (!unchanged && (previousVariant || previous)) {
      const rollbackVariant = previousVariant ?? 'stable';
      const rollbackVersion = previous ? previous.replace(/-r\d+$/, '') : null;
      try {
        await runCommand(
          ctx,
          job,
          'sb_install',
          { variant: rollbackVariant, version_tag: rollbackVersion },
          timeout,
        );
        await runCommand(ctx, job, 'reload', {}, 300_000);
        const verify = await runCommand(ctx, job, 'verify', {}, 60_000);
        if (verify.ok === false) {
          rollback = 'failed';
          rollbackError = 'предыдущий вариант установлен, но проверка не пройдена';
        } else {
          rollback = 'ok';
          await ctx.pool.query(
            `update routers set
                sing_box_version = coalesce($2, sing_box_version),
                sing_box_variant = coalesce($3, sing_box_variant),
                updated_at = now()
              where id = $1`,
            [
              routerId,
              asString(verify.version) ?? previous,
              asString(verify.variant) ?? previousVariant,
            ],
          );
        }
      } catch (rollbackFailure) {
        rollback = 'failed';
        rollbackError = (rollbackFailure as Error).message.slice(0, 500);
      }
    }

    // После неудачной установки Prokop мог остаться остановленным. Запускаем
    // его, если бинарник на месте; повторный start идемпотентен.
    let serviceRestarted = false;
    try {
      await runCommand(ctx, job, 'service_action', { action: 'start' }, 90_000);
      serviceRestarted = true;
    } catch (startError) {
      ctx.log.warn({ err: startError, routerId }, 'не удалось запустить службу после ошибки sing-box');
    }

    const outcome = unchanged
      ? 'текущий вариант не изменён'
      : rollback === 'ok'
        ? `восстановлен предыдущий вариант ${previousVariant ?? 'stable'} ${previous ?? ''}`.trim()
        : rollback === 'failed'
          ? `откат не удался: ${rollbackError ?? 'неизвестная ошибка'}`
          : 'откат недоступен: не известен предыдущий вариант';

    if (asString(job.payload.rollout_id)) {
      await ctx.pool.query(
        `update rollout_targets set status = 'failed', finished_at = now(), error_code = $3,
                previous_version = $4
          where rollout_id = $1 and router_id = $2`,
        [job.payload.rollout_id, routerId, failure.code, previous],
      );
    }

    await notifyRouterOwner(ctx.pool, routerId, {
      kind: rollback === 'ok' ? 'singbox.install_rolled_back' : 'singbox.install_failed',
      severity: 'critical',
      message:
        rollback === 'ok'
          ? `Не удалось установить sing-box (${variant || versionTag}), предыдущий вариант восстановлен`
          : `Не удалось установить sing-box (${variant || versionTag}): ${failure.message} (${outcome})`,
      dedupeKey: `sb:${routerId}:${variant || versionTag}:${failure.code}`,
    });

    throw new JobFailure(
      failure.code,
      `${failure.message} (${outcome}${serviceRestarted ? '' : '; служба не запущена'})`,
      failure.terminal,
    );
  }
}

export async function serviceAction(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const action = asString(job.payload.action) ?? '';
  if (!['restart', 'start', 'stop', 'enable', 'disable'].includes(action)) {
    throw new JobFailure(
      'invalid_payload',
      'Допустимые действия: restart, start, stop, enable, disable',
    );
  }
  const routerId = requireRouter(job);
  const raw = await runCommand(ctx, job, 'service_action', { action }, 90_000);

  // После действия обновляем состояние, чтобы UI сразу показал новый статус
  // и автозапуск, не требуя отдельной кнопки «Прочитать состояние».
  try {
    const managed = await readState(ctx, job, 20_000);
    await recomputeDrift(ctx.pool, routerId, managed);
  } catch (error) {
    ctx.log.warn(
      { err: error, routerId, action },
      'не удалось обновить состояние после действия со службой',
    );
  }

  return { action, result: raw };
}

export async function rebootRouter(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const raw = await runCommand(ctx, job, 'reboot', {}, 30_000);
  // Метка нужна, чтобы отличить «роутер вернулся после ребута» от обычного
  // восстановления связи и показать соответствующий попап.
  await ctx.pool.query('update routers set reboot_requested_at = now() where id = $1', [routerId]);
  return { scheduled: true, result: raw };
}

export async function reconcile(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  if (!ctx.settings.features.autoReconcile) {
    return { skipped: true, reason: 'auto_reconcile_disabled' };
  }
  const current = await readState(ctx, job);
  const drift = await recomputeDrift(ctx.pool, routerId, current);
  return { drift };
}

export async function applyRouterConnections(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const routerResult = await ctx.pool.query<{ managed_section: string | null; product: string }>(
    'select managed_section, product from routers where id = $1',
    [routerId],
  );
  const router = routerResult.rows[0];
  if (!router) throw new JobFailure('router_missing', 'Роутер не найден');
  const requestedSection = asString(job.payload.section);
  const defaultSection =
    (await resolveRouterSection(ctx.pool, routerId, requestedSection)) ?? '';

  const result = await ctx.pool.query<{
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

  const bySection = new Map<
    string,
    { links: string[]; subscriptions: Array<{ name: string; url: string; label?: string }> }
  >();
  for (const row of result.rows) {
    if (requestedSection && row.section !== requestedSection) continue;
    if (!row.enabled) continue;
    const section = row.section || defaultSection;
    if (!section) continue;
    const group = bySection.get(section) ?? { links: [], subscriptions: [] };
    const value = decryptSecret(row.secret_enc, ctx.masterKey);
    if (row.kind === 'vless') {
      group.links.push(value);
    } else if (router.product !== 'podkop') {
      group.subscriptions.push({
        name: `rc_sub_${row.id.replace(/-/g, '').slice(0, 12)}`,
        url: value,
        label: row.label,
      });
    }
    bySection.set(section, group);
  }
  if (router.product !== 'podkop') {
    for (const group of bySection.values()) {
      if (group.subscriptions.length > 0) group.links = [];
    }
  }
  if (requestedSection && !bySection.has(requestedSection)) {
    bySection.set(requestedSection, { links: [], subscriptions: [] });
  }

  const stateResult = await ctx.pool.query<{ managed: Record<string, unknown> | null }>(
    'select managed from router_state where router_id = $1',
    [routerId],
  );
  const managed = stateResult.rows[0]?.managed ?? {};
  if (router.product === 'podkop' && requestedSection) {
    if (managed[`section.${requestedSection}.connection_type`] === undefined) {
      throw new JobFailure(
        'section_missing',
        `Секция «${requestedSection}» не найдена в Podkop. Укажите существующую секцию (например main).`,
      );
    }
  }
  if (router.product === 'podkop') {
    for (const section of [...bySection.keys()]) {
      if (managed[`section.${section}.connection_type`] === undefined) {
        bySection.delete(section);
      }
    }
  }
  const sectionOption = (section: string, option: string): string => {
    const value = managed[`section.${section}.${option}`];
    return typeof value === 'string' ? value : '';
  };

  let snapshotRef: string | null = null;
  await setJobPhase(ctx, job.id, 'snapshot', 5);
  try {
    const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'connections' }, 90_000);
    snapshotRef = asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
    await ctx.pool.query(
      `insert into router_snapshots
         (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
       values ($1,$2,$3,$4,'connections',$5,$6,$7, now() + ($8 || ' days')::interval)`,
      [
        uuidv7(),
        routerId,
        asString(snapshot.kind) === 'native' ? 'native' : 'local',
        snapshotRef,
        asString(snapshot.sha256),
        asNumber(snapshot.size_bytes),
        asString(snapshot.product_version),
        ctx.settings.retention.days,
      ],
    );
    await setJobPhase(ctx, job.id, 'connections', 30);
  } catch (error) {
    throw new JobFailure(
      'backup_failed',
      `Не удалось создать снимок перед изменением подключений: ${(error as Error).message}`,
    );
  }

  const appliedSections: Array<{ section: string; links: number; subscriptions: number }> = [];
  try {
    let appliedIndex = 0;
    for (const [section, group] of bySection) {
      const expectedEnabled = group.links.length + group.subscriptions.length > 0;
      const currentAction = sectionOption(section, 'action');
      await runCommand(
        ctx,
        job,
        'apply_connections',
        {
          section,
          action: currentAction || 'connection',
          label: sectionOption(section, 'label') || section,
          enabled: expectedEnabled,
          links: group.links,
          subscriptions: group.subscriptions,
        },
        120_000,
      );
      appliedSections.push({
        section,
        links: group.links.length,
        subscriptions: group.subscriptions.length,
      });
      appliedIndex += 1;
      await setJobPhase(
        ctx,
        job.id,
        'connections',
        30 + Math.round((appliedIndex / Math.max(1, bySection.size)) * 35),
      );
    }

    await setJobPhase(ctx, job.id, 'reload', 70);
    await runCommand(ctx, job, 'reload', {}, 300_000);
    await runCommand(ctx, job, 'service_action', { action: 'start' }, 180_000);
    // Повторный reload после старта: Prokop/Forkop записывают неудачный
    // reload в health, если первая попытка была до готовности службы.
    await runCommand(ctx, job, 'reload', {}, 300_000);
    await setJobPhase(ctx, job.id, 'verify', 85);
    const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    const current = await saveState(ctx.pool, routerId, raw, 'connections');

    for (const applied of appliedSections) {
      const expectedEnabled = applied.links + applied.subscriptions > 0;
      if (!expectedEnabled) continue;
      const actual = current[`section.${applied.section}.enabled`];
      if (String(actual) !== '1') {
        throw new JobFailure(
          'verify_mismatch',
          `Секция «${applied.section}» не включилась после применения`,
        );
      }
    }
    await setJobPhase(ctx, job.id, 'done', 100);
  } catch (error) {
    let rollback: 'ok' | 'failed' = 'failed';
    if (snapshotRef) {
      await setJobPhase(ctx, job.id, 'rollback', 90);
      try {
        await runCommand(ctx, job, 'snapshot_restore', { snapshot: snapshotRef, kind: 'local' }, 180_000);
        await runCommand(ctx, job, 'reload', {}, 300_000);
        const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
        await saveState(ctx.pool, routerId, raw, 'connections_rollback');
        rollback = 'ok';
      } catch {
        rollback = 'failed';
      }
    }
    const failure = error as JobFailure;
    await setJobPhase(ctx, job.id, rollback === 'ok' ? 'rolled_back' : 'failed', 100);
    await ctx.pool.query(
      `update routers set last_error = $2, updated_at = now() where id = $1`,
      [routerId, prokopReloadHint(failure.message ?? '').slice(0, 500) || 'Ошибка применения подключений'],
    );
    throw new JobFailure(
      failure.code ?? 'connections_failed',
      `${prokopReloadHint(failure.message ?? '')} (${rollback === 'ok' ? 'изменения откачены' : 'требуется ручная проверка'})`,
    );
  }

  await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
    routerId,
  ]);

  return {
    sections: appliedSections,
    links: appliedSections.reduce((sum, item) => sum + item.links, 0),
    subscriptions: appliedSections.reduce((sum, item) => sum + item.subscriptions, 0),
    snapshot: snapshotRef,
  };
}

export async function sectionDelete(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const section = asString(job.payload.section) ?? '';
  if (section === '' || !/^[A-Za-z0-9_.-]{1,64}$/.test(section)) {
    throw new JobFailure('invalid_payload', 'Некорректное имя секции');
  }
  const routerResult = await ctx.pool.query<{ managed_section: string | null }>(
    'select managed_section from routers where id = $1',
    [routerId],
  );
  if ((routerResult.rows[0]?.managed_section ?? '') === section) {
    throw new JobFailure('section_managed', 'Нельзя удалить основную секцию роутера');
  }

  await setJobPhase(ctx, job.id, 'snapshot', 10);
  const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'section_delete' }, 90_000);
  const snapshotRef =
    asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
  const snapshotId = uuidv7();
  await ctx.pool.query(
    `insert into router_snapshots
       (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
     values ($1,$2,$3,$4,'section_delete',$5,$6,$7, now() + ($8 || ' days')::interval)`,
    [
      snapshotId,
      routerId,
      asString(snapshot.kind) === 'native' ? 'native' : 'local',
      snapshotRef,
      asString(snapshot.sha256),
      asNumber(snapshot.size_bytes),
      asString(snapshot.product_version),
      ctx.settings.retention.days,
    ],
  );

  try {
    await setJobPhase(ctx, job.id, 'delete', 40);
    await runCommand(ctx, job, 'delete_section', { section }, 120_000);
    await setJobPhase(ctx, job.id, 'verify', 80);
    const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    await saveState(ctx.pool, routerId, raw, 'section_delete');
    // read_state не отдаёт список секций с подписками; старый кэш sections
    // иначе продолжит показывать удалённую секцию.
    await ctx.pool.query('update router_state set sections = null where router_id = $1', [routerId]);
    await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
      routerId,
    ]);
    return { section, deleted: true, snapshot: snapshotRef, snapshot_id: snapshotId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'не удалось удалить секцию';
    let rollback = 'failed';
    try {
      await runCommand(
        ctx,
        job,
        'snapshot_restore',
        { snapshot: snapshotRef, kind: 'local' },
        180_000,
      );
      rollback = 'ok';
    } catch {
      // Снимок остаётся в истории; сообщим пользователю, что откат не удался.
    }
    throw new JobFailure(
      'section_delete_failed',
      `${message} (${rollback === 'ok' ? 'изменения откачены из снимка' : 'требуется ручная проверка'})`,
    );
  }
}

export async function listConnections(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const section = await resolveRouterSection(ctx.pool, routerId, asString(job.payload.section));
  if (!section) throw new JobFailure('section_unknown', 'Не удалось определить секцию роутера');
  return runCommand(ctx, job, 'list_connections', { section }, 30_000);
}

/**
 * Живое чтение правил: секции, их настройки, подписки, прямые ссылки
 * и содержимое локальных списков доменов/IP. Один запрос к агенту вместо
 * серии list_connections на каждую секцию.
 */
export async function readRules(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const productRow = await ctx.pool.query<{ product: string; product_version: string | null }>(
    'select product, product_version from routers where id = $1',
    [routerId],
  );
  const product = productRow.rows[0]?.product ?? 'unknown';
  const productVersion = productRow.rows[0]?.product_version ?? null;
  const raw = await runCommand(ctx, job, 'read_rules', {}, 90_000);

  // read_rules отдаёт секции, подписки и локальные списки, но не health/service.
  // Дополнительное read_state обновляет карточку «Служба» и capabilities.
  let managed: Record<string, string | string[]> = asRecord(raw.managed) as Record<
    string,
    string | string[]
  >;
  try {
    const stateRaw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    const merged = {
      ...stateRaw,
      sections: Array.isArray(raw.sections) ? raw.sections : stateRaw.sections,
    };
    managed = (await saveState(ctx.pool, routerId, merged, 'read_rules')) as Record<
      string,
      string | string[]
    >;
  } catch {
    if (Object.keys(managed).length > 0 || raw.state_hash != null) {
      await saveState(ctx.pool, routerId, raw, 'read_rules');
    }
  }

  const stored = await ctx.pool.query<{
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
  const connections: StoredConnection[] = stored.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    section: row.section,
    value: decryptSecret(row.secret_enc, ctx.masterKey),
    enabled: row.enabled,
  }));

  const extras = await loadListExtras(ctx.pool, routerId);
  const agentSections = Array.isArray(raw.sections)
    ? (raw.sections as unknown as AgentSection[])
    : [];
  const rules = buildRuleViews({
    managed: managed as Record<string, string | string[]>,
    agentSections,
    connections,
    extras,
    source: 'live',
    product,
    productVersion,
  });

  // GET /rules собирает ручные записи из list_extras, без обращения к агенту.
  // Сохраняем их после живого чтения, иначе кэш показывает пустые списки.
  const extrasNext: RouterListExtras = { ...extras };
  for (const rule of rules) {
    const previous = extrasNext[rule.section] ?? {};
    const hasEntries = rule.manual_domains.length > 0 || rule.manual_ips.length > 0;
    if (!hasEntries && Object.keys(previous).length === 0) continue;
    extrasNext[rule.section] = {
      ...previous,
      manual_domains: rule.manual_domains,
      manual_ips: rule.manual_ips,
    };
  }
  if (JSON.stringify(extrasNext) !== JSON.stringify(extras)) {
    await ctx.pool.query(
      'update routers set list_extras = $2::jsonb, updated_at = now() where id = $1',
      [routerId, JSON.stringify(extrasNext)],
    );
  }

  return {
    rules,
    state_hash: asString(raw.state_hash),
    source: 'live',
  };
}

export async function manageConnection(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const action = asString(job.payload.action);
  const kind = asString(job.payload.kind);
  if (action !== 'delete' && action !== 'replace') {
    throw new JobFailure('invalid_payload', 'Не указано действие с подключением');
  }
  if (kind !== 'subscription' && kind !== 'link') {
    throw new JobFailure('invalid_payload', 'Не указан тип подключения');
  }

  const section = await resolveRouterSection(ctx.pool, routerId, asString(job.payload.section));
  if (!section) throw new JobFailure('section_unknown', 'Не удалось определить секцию роутера');
  const name = asString(job.payload.name);
  const hash = asString(job.payload.hash);
  const editId = asString(job.payload.edit_id);

  let value: string | null = null;
  try {
    if (editId) {
      const edit = await ctx.pool.query<{ secret_enc: string }>(
        'select secret_enc from connection_edits where id = $1 and router_id = $2',
        [editId, routerId],
      );
      if (!edit.rows[0]) {
        throw new JobFailure('edit_missing', 'Новое значение подключения не найдено');
      }
      value = decryptSecret(edit.rows[0].secret_enc, ctx.masterKey);
    }

    let snapshotRef: string | null = null;
    await setJobPhase(ctx, job.id, 'snapshot', 5);
    try {
      const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'connection_manage' }, 90_000);
      snapshotRef =
        asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
      await ctx.pool.query(
        `insert into router_snapshots
           (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
         values ($1,$2,$3,$4,'connection_manage',$5,$6,$7, now() + ($8 || ' days')::interval)`,
        [
          uuidv7(),
          routerId,
          asString(snapshot.kind) === 'native' ? 'native' : 'local',
          snapshotRef,
          asString(snapshot.sha256),
          asNumber(snapshot.size_bytes),
          asString(snapshot.product_version),
          ctx.settings.retention.days,
        ],
      );
      await setJobPhase(ctx, job.id, 'apply', 30);
    } catch (error) {
      throw new JobFailure(
        'backup_failed',
        `Не удалось создать снимок перед изменением подключения: ${(error as Error).message}`,
      );
    }

    try {
      const applied = await runCommand(
        ctx,
        job,
        'manage_connection',
        { section, action, kind, name, hash, value },
        60_000,
      );
      await setJobPhase(ctx, job.id, 'reload', 60);
      await runCommand(ctx, job, 'reload', {}, 300_000);
      await setJobPhase(ctx, job.id, 'verify', 85);
      const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
      await saveState(ctx.pool, routerId, raw, 'connection_manage');

      // Для удаления проверяем, что элемент действительно исчез.
      if (action === 'delete') {
        const listed = await runCommand(ctx, job, 'list_connections', { section }, 30_000);
        const subscriptions = Array.isArray(listed.subscriptions) ? listed.subscriptions : [];
        const links = Array.isArray(listed.links) ? listed.links : [];
        if (kind === 'subscription' && subscriptions.some((item) => asString((item as Json).name) === name)) {
          throw new JobFailure('verify_mismatch', 'Подписка осталась на роутере после удаления');
        }
        if (kind === 'link' && links.some((item) => asString((item as Json).hash) === hash)) {
          throw new JobFailure('verify_mismatch', 'Ссылка осталась на роутере после удаления');
        }
      }

      await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
        routerId,
      ]);
      await setJobPhase(ctx, job.id, 'done', 100);
      return {
        action,
        kind,
        section,
        snapshot: snapshotRef,
        disabled: applied.disabled === true,
      };
    } catch (error) {
      let rollback: 'ok' | 'failed' = 'failed';
      if (snapshotRef) {
        await setJobPhase(ctx, job.id, 'rollback', 90);
        try {
          await runCommand(ctx, job, 'snapshot_restore', { snapshot: snapshotRef, kind: 'local' }, 180_000);
          await runCommand(ctx, job, 'reload', {}, 300_000);
          const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
          await saveState(ctx.pool, routerId, raw, 'connection_manage_rollback');
          rollback = 'ok';
        } catch {
          rollback = 'failed';
        }
      }
      const failure = error as JobFailure;
      await setJobPhase(ctx, job.id, rollback === 'ok' ? 'rolled_back' : 'failed', 100);
      await ctx.pool.query(
        `update routers set last_error = $2, updated_at = now() where id = $1`,
        [routerId, prokopReloadHint(failure.message ?? '').slice(0, 500) || 'Ошибка изменения подключения'],
      );
      throw new JobFailure(
        failure.code ?? 'connection_manage_failed',
        `${prokopReloadHint(failure.message ?? '')} (${rollback === 'ok' ? 'изменения откачены' : 'требуется ручная проверка'})`,
      );
    }
  } finally {
    if (editId) {
      await ctx.pool.query('delete from connection_edits where id = $1', [editId]).catch(() => undefined);
    }
  }
}

export async function dnsBenchmark(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  let state: Json = {};
  try {
    const started = await runCommand(ctx, job, 'dns_benchmark', { mode: 'start' }, 30_000);
    state = asRecord(started.state);
    const deadline = Date.now() + Math.max(60_000, Math.min(job.timeout_seconds * 1000 - 10_000, 840_000));

    while (state.running === true) {
      if (await isCancelRequested(ctx.pool, job.id)) {
        await runCommand(ctx, job, 'dns_benchmark', { mode: 'stop' }, 30_000).catch(() => undefined);
        throw new JobFailure('cancelled', 'Задача отменена', 'cancelled');
      }
      if (Date.now() > deadline) {
        await runCommand(ctx, job, 'dns_benchmark', { mode: 'stop' }, 30_000).catch(() => undefined);
        throw new JobFailure(
          'dns_benchmark_timeout',
          'Тест DNS не завершился за отведённое время',
          'timeout',
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const status = await runCommand(ctx, job, 'dns_benchmark', { mode: 'status' }, 30_000);
      state = asRecord(status.state);
      await ctx.pool.query('update jobs set result = $2::jsonb where id = $1', [
        job.id,
        JSON.stringify({
          progress: asNumber(state.progress) ?? 0,
          phase: asString(state.phase),
          current: asString(state.current),
          results_count: Array.isArray(state.results) ? state.results.length : 0,
        }),
      ]);
    }

    const error = asString(state.error);
    if (error) throw new JobFailure('dns_benchmark_failed', error);
    return state;
  } finally {
    if (state.running === true) {
      await runCommand(ctx, job, 'dns_benchmark', { mode: 'stop' }, 30_000).catch(() => undefined);
    }
  }
}

export async function productSwitch(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const requested = asString(job.payload.product) ?? '';
  const version = asString(job.payload.version) || null;
  if (!['tachyon', 'forkop', 'podkop', 'prokop'].includes(requested)) {
    throw new JobFailure(
      'unsupported_product_switch',
      `Переключение на ${requested || 'неизвестный продукт'} пока не поддерживается`,
    );
  }
  const routerRow = await ctx.pool.query<{ managed_section: string | null }>(
    'select managed_section from routers where id = $1',
    [routerId],
  );
  const stateRow = await ctx.pool.query<{ managed: Record<string, unknown> | null }>(
    'select managed from router_state where router_id = $1',
    [routerId],
  );
  const managed = stateRow.rows[0]?.managed ?? {};
  const currentSection = routerRow.rows[0]?.managed_section ?? null;
  const section =
    resolveManagedSection(managed as Record<string, UciValue>, currentSection) ?? currentSection ?? '';
  if (section && section !== currentSection) {
    await ctx.pool.query('update routers set managed_section = $2, updated_at = now() where id = $1', [
      routerId,
      section,
    ]);
  }
  const allowedOptions = [
    'community_lists',
    'rule_set',
    'rule_set_with_subnets',
    'domain',
    'domain_suffix',
    'domain_keyword',
    'domain_regex',
    'domain_ip_lists',
    'user_domains',
    'user_domains_text',
    'user_subnets',
    'user_subnets_text',
    'local_domain_lists',
    'local_subnet_lists',
    'fully_routed_ips',
    'enable_udp_over_tcp',
    'mixed_proxy_enabled',
    'resolve_real_ip_for_routing',
    'user_domain_list_type',
    'user_subnet_list_type',
  ];
  const sectionOptions = new Map<string, Record<string, unknown>>();
  const sectionMeta = new Map<
    string,
    {
      enabled?: string;
      label?: string;
      action?: string;
      connection_type?: string;
      proxy_config_type?: string;
    }
  >();
  for (const [key, value] of Object.entries(managed)) {
    const match = /^section\.([A-Za-z0-9_.-]{1,64})\.(.+)$/.exec(key);
    if (!match) continue;
    const name = match[1]!;
    const option = match[2]!;
    if (
      option === 'enabled' ||
      option === 'label' ||
      option === 'action' ||
      option === 'connection_type' ||
      option === 'proxy_config_type'
    ) {
      const meta = sectionMeta.get(name) ?? {};
      meta[option] = String(value ?? '');
      sectionMeta.set(name, meta);
      continue;
    }
    if (!allowedOptions.includes(option)) continue;
    const options = sectionOptions.get(name) ?? {};
    options[option] = value;
    sectionOptions.set(name, options);
  }
  await setJobPhase(ctx, job.id, 'product_switch', 10);
  const raw = await runCommand(
    ctx,
    job,
    'product_switch',
    { product: requested, version },
    1_800_000,
  );
  const product = asString(raw.product) || requested;
  const productVersion = asString(raw.version) || null;
  await ctx.pool.query(
    `update routers
        set product = $2, product_version = $3, last_error = null,
            status = case when $2 = 'conflict' then 'conflict' else 'online' end,
            updated_at = now()
      where id = $1`,
    [routerId, product, productVersion],
  );

  const restoreWarnings: string[] = [];
  for (const [name, options] of sectionOptions) {
    const meta = sectionMeta.get(name) ?? {};
    if (
      Object.keys(options).length === 0 &&
      !meta.enabled &&
      !meta.label &&
      !meta.action &&
      !meta.connection_type
    ) {
      continue;
    }
    try {
      await runCommand(
        ctx,
        job,
        'restore_section_options',
        {
          section: name,
          options,
          enabled: meta.enabled ?? null,
          label: meta.label ?? null,
          action: meta.action ?? null,
          connection_type: meta.connection_type ?? null,
          proxy_config_type: meta.proxy_config_type ?? null,
        },
        180_000,
      );
    } catch (error) {
      restoreWarnings.push(
        `${name}: ${error instanceof Error ? error.message : 'не удалось перенести настройки секции'}`,
      );
    }
  }
  const restoreWarning = restoreWarnings.length > 0 ? restoreWarnings.join('; ') : null;

  // После смены продукта возвращаем подключения RoutX уже в формате нового
  // продукта: подписку для Forkop/Tachyon, импортированные ссылки для Podkop.
  const restoreJob = await enqueueJob(ctx.pool, {
    type: 'connections_apply',
    routerId,
    requestedBy: job.requested_by,
    timeoutSeconds: 600,
    payload: { reason: 'product_switch_restore', section },
  });

  return {
    product,
    version: productVersion,
    requested,
    requested_version: version,
    install_output: asString(raw.install_output) || null,
    removed_products: Array.isArray(raw.removed_products) ? raw.removed_products : [],
    installed_products: Array.isArray(raw.installed_products) ? raw.installed_products : [],
    migration: raw.migration ?? null,
    restore_job_id: restoreJob.id,
    restore_warning: restoreWarning,
  };
}

export async function removePackages(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const packages = Array.isArray(job.payload.packages)
    ? job.payload.packages.map((value) => asString(value)).filter((value): value is string => Boolean(value))
    : [];
  if (packages.length === 0) {
    throw new JobFailure('no_packages', 'Не выбрано ни одного пакета');
  }
  const raw = await runCommand(ctx, job, 'remove_packages', { packages }, 330_000);
  return {
    router_id: routerId,
    packages: Array.isArray(raw.packages) ? raw.packages : packages,
    installed_products: Array.isArray(raw.installed_products) ? raw.installed_products : [],
    output: asString(raw.output) || null,
  };
}

export type JobHandler = (ctx: HandlerContext, job: JobRow) => Promise<Json>;

export const HANDLERS: Record<string, JobHandler> = {
  refresh_state: refreshState,
  diff: diffTemplate,
  diff_custom: diffCustom,
  diff_podkop: diffPodkop,
  podkop_outbound: podkopOutbound,
  proxy_select: proxySelect,
  apply: applyRun,
  read_rules: readRules,
  monitor: monitorProbe,
  access_check: accessCheck,
  site_check: siteCheck,
  agent_update: agentUpdate,
  product_switch: productSwitch,
  remove_packages: removePackages,
  diagnostics,
  snapshot,
  restore: restoreSnapshot,
  sb_check: singBoxCheck,
  sb_install: singBoxInstall,
  service_action: serviceAction,
  reboot: rebootRouter,
  dns_benchmark: dnsBenchmark,
  connections_apply: applyRouterConnections,
  list_connections: listConnections,
  manage_connection: manageConnection,
  section_delete: sectionDelete,
  reconcile,
};
