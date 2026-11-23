import { resolveManagedSection, type UciValue } from '../../domain/uci.js';
import { JobFailure } from '../errors.js';
import {
  asNumber,
  asRecord,
  asString,
  requireRouter,
  runCommand,
  setJobPhase,
  type HandlerContext,
  type Json,
} from '../helpers.js';
import { enqueueJob, isCancelRequested, type JobRow } from '../queue.js';
import { readState, recomputeDrift } from '../state.js';
import { runComponentUpdate } from './agent.js';

export async function bulkUpdate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const targets = asRecord(job.payload.targets ?? {});
  const routx = targets.routx === true;
  const tachyon = targets.tachyon === true;
  const tachyonCore = targets.tachyon_core === true || targets['tachyon-core'] === true;
  if (!routx && !tachyon && !tachyonCore) {
    throw new JobFailure('invalid_payload', 'Не выбрано ни одного компонента обновления');
  }

  const routerRow = await ctx.pool.query<{ product: string }>(
    'select product from routers where id = $1',
    [routerId],
  );
  const tachyonApplicable = routerRow.rows[0]?.product === 'tachyon';
  const skipped: string[] = [];

  const results: Record<string, Json> = {};
  const errors: Array<{ target: string; message: string }> = [];
  const fail = (target: string, error: unknown): void => {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : 'Неизвестная ошибка обновления';
    results[target] = { ok: false, error: message };
    errors.push({ target, message });
  };

  if (routx) {
    await setJobPhase(ctx, job.id, 'Обновляем агент RoutX', 5);
    try {
      const base = ctx.publicUrl.replace(/\/+$/, '');
      const raw = await runCommand(ctx, job, 'self_update', { base_url: base }, 180_000);
      if (raw.ok === false) {
        throw new JobFailure(
          asString(raw.error) || 'agent_update_failed',
          asString(raw.message) || 'Агент не принял обновление',
        );
      }
      results.routx = {
        ok: true,
        scheduled: true,
        kind: asString(raw.kind) ?? null,
        version: asString(raw.version) ?? null,
      };
      // Агент перезапускается после self_update. Даём ему подняться, чтобы
      // следующие команды не ждали в очереди слишком долго.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    } catch (error) {
      fail('routx', error);
    }
  }

  if (tachyon) {
    if (!tachyonApplicable) {
      results.tachyon = { ok: true, skipped: 'not_tachyon' };
      skipped.push('tachyon');
    } else {
      await setJobPhase(ctx, job.id, 'Обновляем модуль Tachyon', 30);
      try {
        results.tachyon = await runComponentUpdate(ctx, job, 'tachyon');
      } catch (error) {
        fail('tachyon', error);
      }
    }
  }

  if (tachyonCore) {
    if (!tachyonApplicable) {
      results['tachyon-core'] = { ok: true, skipped: 'not_tachyon' };
      skipped.push('tachyon-core');
    } else {
      await setJobPhase(ctx, job.id, 'Обновляем ядро Tachyon Core', 65);
      try {
        results['tachyon-core'] = await runComponentUpdate(ctx, job, 'tachyon-core');
      } catch (error) {
        fail('tachyon-core', error);
      }
    }
  }

  // После обновления агента просим свежее состояние, чтобы панель сразу
  // показала новые версии. Ошибка чтения не должна портить итог обновления.
  try {
    const managed = await readState(ctx, job, 30_000);
    await recomputeDrift(ctx.pool, routerId, managed);
  } catch (error) {
    ctx.log.warn({ err: error, routerId }, 'не удалось обновить состояние после комплексного обновления');
  }

  return {
    ok: errors.length === 0,
    router_id: routerId,
    targets: { routx, tachyon, tachyon_core: tachyonCore },
    skipped,
    results,
    errors,
  };
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
    { product: requested, version, base_url: ctx.publicUrl },
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

