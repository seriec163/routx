import type { Pool } from 'pg';
import { resolveManagedSection, type UciValue } from './uci.js';

/**
 * Возвращает основную секцию роутера, не полагаясь на захардкоженное имя.
 *
 * Порядок:
 * 1. явно запрошенная секция из запроса;
 * 2. сохранённая `routers.managed_section`, если она всё ещё активна;
 * 3. единственная включённая секция с подключением из состояния агента;
 * 4. секция последнего подключения RoutX;
 * 5. `null`, если определить нечего.
 *
 * Найденное значение сохраняется в `routers.managed_section`, чтобы следующие
 * запросы не повторяли эвристику.
 */
export async function resolveRouterSection(
  pool: Pool,
  routerId: string,
  requested?: string | null,
): Promise<string | null> {
  const wanted = requested?.trim();
  if (wanted) return wanted;

  const [router, state, connection] = await Promise.all([
    pool.query<{ managed_section: string | null }>(
      'select managed_section from routers where id = $1',
      [routerId],
    ),
    pool.query<{ managed: Record<string, UciValue> | null }>(
      'select managed from router_state where router_id = $1',
      [routerId],
    ),
    pool.query<{ section: string | null }>(
      `select section from router_connections
        where router_id = $1 and section is not null and section <> ''
        order by created_at desc limit 1`,
      [routerId],
    ),
  ]);

  const current = router.rows[0]?.managed_section ?? null;
  const managed = state.rows[0]?.managed ?? {};
  let resolved = resolveManagedSection(managed, current);
  if (!resolved && connection.rows[0]?.section) resolved = connection.rows[0].section;

  if (resolved && resolved !== current) {
    await pool.query('update routers set managed_section = $2, updated_at = now() where id = $1', [
      routerId,
      resolved,
    ]);
  }
  return resolved;
}
