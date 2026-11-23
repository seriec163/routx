import type { Pool } from 'pg';
import type { PlatformSettings } from '../../settings.js';
import { notifyRouterOwner } from '../../notifications.js';
import { enqueueJob, type JobRow } from '../queue.js';
import {
  asNumber,
  asString,
  requireRouter,
  runCommand,
  type HandlerContext,
  type Json,
} from '../helpers.js';

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

  // Служба упала или остановлена — автоматически снимаем быструю
  // диагностику с логами Tachyon/sing-box. Один запуск в час на роутер,
  // чтобы не заваливать очередь при долгой аварии.
  const rawServiceState = asString(raw.service_state) ?? '';
  const rawHealth = asString(raw.health) ?? '';
  if (rawHealth === 'failed' || rawServiceState.includes('stopped')) {
    const bucket = new Date().toISOString().slice(0, 13);
    await enqueueJob(ctx.pool, {
      type: 'diagnostics',
      routerId,
      requestedBy: null,
      timeoutSeconds: 240,
      maxAttempts: 1,
      idempotencyKey: `auto_diag:${routerId}:${bucket}`,
      payload: { kind: 'full', auto: true },
    });
  }

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

