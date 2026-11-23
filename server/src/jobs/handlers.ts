import { decryptSecret } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';
import {
  resolveManagedSection,
  type RouterListExtras,
  type UciValue,
} from '../domain/uci.js';
import { resolveRouterSection } from '../domain/managed-section.js';
import { enqueueJob, isCancelRequested } from './queue.js';
import type { JobRow } from './queue.js';
import { notifyRouterOwner } from '../notifications.js';
import {
  buildRuleViews,
  type AgentSection,
  type StoredConnection,
} from '../domain/rules.js';
import { computePodkopPlan, podkopSectionInputSchema, podkopTemplateInput } from '../domain/podkop.js';
import { JobFailure } from './errors.js';
import {
  asNumber,
  asRecord,
  asString,
  prokopReloadHint,
  requireRouter,
  runCommand,
  setJobPhase,
  type HandlerContext,
  type Json,
} from './helpers.js';
import { wifiCreate, wifiDelete, wifiRead, wifiUpdate } from './handlers/wifi.js';
import { loadListExtras, readState, recomputeDrift, saveState } from './state.js';
import {
  agentUpdate,
  componentCheck,
  componentUpdate,
  runComponentUpdate,
} from './handlers/agent.js';
import {
  diagnostics,
  rebootRouter,
  restoreSnapshot,
  serviceAction,
  snapshot,
} from './handlers/operations.js';
import { monitorProbe } from './handlers/monitor.js';
import {
  applyRun,
  diffCustom,
  diffPodkop,
  diffTemplate,
  podkopOutbound,
  proxySelect,
  refreshState,
} from './handlers/apply.js';
export { proxyHealthOf } from './handlers/monitor.js';
export { JobFailure } from './errors.js';
export type { HandlerContext } from './helpers.js';

export async function accessCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
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
  component_check: componentCheck,
  component_update: componentUpdate,
  bulk_update: bulkUpdate,
  wifi_read: wifiRead,
  wifi_update: wifiUpdate,
  wifi_create: wifiCreate,
  wifi_delete: wifiDelete,
  dns_benchmark: dnsBenchmark,
  connections_apply: applyRouterConnections,
  list_connections: listConnections,
  manage_connection: manageConnection,
  section_delete: sectionDelete,
  reconcile,
};
