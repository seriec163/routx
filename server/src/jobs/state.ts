import type { Pool } from 'pg';
import {
  computePlan,
  mapTemplateSections,
  sanitizeAgentState,
  stateHash,
  templatePayloadSchema,
  type RouterListExtras,
  type UciValue,
} from '../domain/uci.js';
import { normalizeTemplateLists } from '../domain/community-lists.js';
import { syncManagedSection } from '../domain/managed-section.js';
import {
  requireRouter,
  runCommand,
  type HandlerContext,
  type Json,
} from './helpers.js';
import type { JobRow } from './queue.js';

export async function saveState(
  pool: Pool,
  routerId: string,
  raw: Json,
  source: string,
): Promise<Record<string, UciValue>> {
  const managed = sanitizeAgentState(raw.managed ?? raw);
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
  await syncManagedSection(pool, routerId, managed);

  return managed;
}

export async function readState(
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
