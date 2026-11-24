import { decryptSecret } from '../../lib/crypto.js';
import { uuidv7 } from '../../lib/ids.js';
import { resolveRouterSection } from '../../domain/managed-section.js';
import { buildRuleViews, type AgentSection, type StoredConnection } from '../../domain/rules.js';
import type { RouterListExtras } from '../../domain/uci.js';
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
import { type JobRow } from '../queue.js';
import { loadListExtras, saveState } from '../state.js';

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
    const removedConnections = await ctx.pool.query(
      'delete from router_connections where router_id = $1 and section = $2',
      [routerId, section],
    );
    await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
      routerId,
    ]);
    return {
      section,
      deleted: true,
      snapshot: snapshotRef,
      snapshot_id: snapshotId,
      connections_removed: removedConnections.rowCount ?? 0,
    };
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

