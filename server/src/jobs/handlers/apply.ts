import type { Pool } from 'pg';
import { uuidv7 } from '../../lib/ids.js';
import { notifyRouterOwner } from '../../notifications.js';
import {
  applySectionMap,
  computePlan,
  creatableSections,
  diffHash,
  mapTemplateSections,
  materializePresetForSection,
  presetFromPayload,
  stateHash,
  templatePayloadSchema,
  validateExclusions,
  type DiffItem,
  type TemplatePayload,
  type UciValue,
} from '../../domain/uci.js';
import { normalizeTemplateLists } from '../../domain/community-lists.js';
import { computePodkopPlan, podkopSectionInputSchema, podkopTemplateInput } from '../../domain/podkop.js';
import { JobFailure } from '../errors.js';
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
} from '../helpers.js';
import type { JobRow } from '../queue.js';
import { loadListExtras, readState, recomputeDrift, saveState } from '../state.js';

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

  // Шаблон-пресет (например, ForFriends) не содержит имён секций: это
  // действие, ресурсы и настройки. Материализуем его в основную секцию
  // роутера, иначе на чистой установке не создаётся ни одной включённой
  // секции и Tachyon/Prokop не могут собрать конфигурацию.
  const routerSectionRow = await ctx.pool.query<{ managed_section: string | null }>(
    'select managed_section from routers where id = $1',
    [routerId],
  );
  const configuredSection = routerSectionRow.rows[0]?.managed_section?.trim() || 'rc_main';
  const hasPreset =
    Object.keys(payload.sections).length === 0 &&
    (Boolean(payload.action) ||
      Object.keys(payload.resources ?? {}).length > 0 ||
      (payload.manual_domains?.length ?? 0) > 0 ||
      (payload.manual_ips?.length ?? 0) > 0 ||
      Object.keys(payload.settings ?? {}).length > 0);
  let effectivePayload = payload;
  let materializedSection: string | null = null;
  if (hasPreset) {
    effectivePayload = materializePresetForSection(
      presetFromPayload(payload),
      configuredSection,
      true,
    );
    materializedSection = configuredSection;
  }

  let mapped;
  if (materializedSection) {
    mapped = { payload: effectivePayload, sectionMap: {}, warnings: [] };
  } else if (Object.keys(providedMap).length > 0) {
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
        payload: applySectionMap(effectivePayload, providedMap),
        sectionMap: providedMap,
        warnings: [],
      };
    } catch (error) {
      throw new JobFailure('section_map_invalid', (error as Error).message.slice(0, 500));
    }
  } else {
    mapped = mapTemplateSections(effectivePayload, current);
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
      default_section: materializedSection,
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
    default_section: materializedSection,
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

