import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireSuperadmin, requireUser } from '../auth/service.js';
import { badRequest, conflict, notFound, unavailable } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { assertOnline, getRouter } from '../routers/service.js';
import { loadSettings } from '../settings.js';

interface RouteContext {
  pool: Pool;
}

const SING_BOX_VARIANTS = [
  {
    id: 'tiny',
    label: 'Tiny',
    description: 'Минимальный sing-box из пакетного репозитория Prokop/Forkop. Меньше всего места.',
  },
  {
    id: 'extended',
    label: 'Extended',
    description: 'Расширенная сборка sing-box-extended с дополнительными протоколами и XHTTP.',
  },
  {
    id: 'extended_compressed',
    label: 'Extended compressed',
    description: 'Extended со сжатым бинарником и библиотекой Cronet: экономит место.',
  },
  {
    id: 'stable',
    label: 'Stable',
    description: 'Обычная стабильная сборка из пакетного репозитория.',
  },
] as const;

const OFFICIAL_SOURCES = [
  { repo: 'SagerNet/sing-box', product: 'sing-box' },
  { repo: 'shtorm-7/sing-box-extended', product: 'sing-box-extended' },
] as const;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>;
}

/** Каталог версий из официальных источников; никаких сторонних зеркал. */
export async function refreshSingBoxCatalog(pool: Pool): Promise<number> {
  let count = 0;
  let failures = 0;

  for (const source of OFFICIAL_SOURCES) {
    let releases: GitHubRelease[];
    try {
      const response = await fetch(
        `https://api.github.com/repos/${source.repo}/releases?per_page=20`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'routx/0.1 (+https://github.com/)',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub API ответил ${response.status}`);
      }
      releases = (await response.json()) as GitHubRelease[];
    } catch {
      failures += 1;
      continue;
    }

    for (const release of releases) {
      const tag = release.tag_name;
      if (!tag || release.draft) continue;
      const linuxAsset = release.assets?.find((asset) => asset.name?.includes('linux-arm64'));
      const sha = linuxAsset?.digest?.replace(/^sha256:/i, '') ?? null;

      await pool.query(
        `insert into sing_box_versions (id, product, tag, release_url, published_at, asset_sha256, is_stable)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (product, tag) do update
           set release_url = excluded.release_url,
               published_at = excluded.published_at,
               asset_sha256 = excluded.asset_sha256,
               is_stable = excluded.is_stable`,
        [
          uuidv7(),
          source.product,
          tag,
          release.html_url ?? null,
          release.published_at ? new Date(release.published_at) : null,
          sha,
          release.prerelease !== true,
        ],
      );
      count += 1;
    }
  }

  if (count === 0 && failures > 0) {
    throw unavailable('catalog_unavailable', 'Не удалось получить список версий sing-box');
  }
  return count;
}

export async function registerSingBoxRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/singbox/versions', async (request) => {
    requireUser(request);
    const query = z
      .object({
        product: z.string().max(40).default('sing-box'),
        stable_only: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);

    const result = await pool.query(
      `select tag, release_url, published_at, asset_sha256, is_stable, discovered_at
         from sing_box_versions
        where product = $1 and (not $2::boolean or is_stable)
        order by published_at desc nulls last limit 100`,
      [query.product, query.stable_only === 'true'],
    );
    return { items: result.rows };
  });

  app.post('/api/v1/singbox/refresh', async (request) => {
    const auth = requireSuperadmin(request);
    const count = await refreshSingBoxCatalog(pool);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'singbox.catalog_refresh',
      targetType: 'catalog',
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { versions: count },
    });
    return { ok: true, versions: count };
  });

  app.get('/api/v1/singbox/variants', async (request) => {
    requireUser(request);
    return {
      items: SING_BOX_VARIANTS,
    };
  });

  app.post('/api/v1/routers/:id/singbox/install', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        variant: z.enum(['tiny', 'extended', 'extended_compressed', 'stable']).optional(),
        version_tag: z.string().min(1).max(60).optional(),
        acknowledge_risk: z.literal(true),
      })
      .strict()
      .refine((value) => Boolean(value.variant || value.version_tag), {
        message: 'Укажите variant или version_tag',
      })
      .parse(request.body);

    if (body.version_tag && body.variant && body.variant !== 'extended') {
      throw badRequest(
        'version_not_supported',
        'Конкретную версию можно выбрать только для варианта Extended; Tiny/Stable/Compressed ставятся последней версией',
      );
    }

    const router = await getRouter(pool, auth, params.id);
    assertOnline(router);
    const settings = await loadSettings(pool);

    if (auth.role === 'user') {
      if (!settings.singbox.userInstall) {
        throw conflict('singbox_install_disabled', 'Установка sing-box пользователем отключена');
      }
      const last = await pool.query<{ created_at: Date }>(
        `select created_at from jobs
          where router_id = $1 and type = 'sb_install'
            and status in ('queued','running','success')
          order by created_at desc limit 1`,
        [router.id],
      );
      if (last.rows[0]) {
        const cooldown = settings.singbox.userCooldownHours * 60 * 60_000;
        if (Date.now() - last.rows[0].created_at.getTime() < cooldown) {
          throw conflict(
            'cooldown',
            `Следующая установка будет доступна позже (не чаще раза в ${settings.singbox.userCooldownHours} ч)`,
          );
        }
      }
    }

    if (body.version_tag) {
      const version = await pool.query<{ tag: string }>(
        `select tag from sing_box_versions
          where product in ('sing-box', 'sing-box-extended') and tag = $1`,
        [body.version_tag],
      );
      if (!version.rows[0]) {
        throw notFound('Версия отсутствует в каталоге. Обновите каталог.');
      }
    }

    const job = await enqueueJob(pool, {
      type: 'sb_install',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 900,
      maxAttempts: 1,
      idempotencyKey: `sb_install:${router.id}:${body.variant ?? 'version'}:${body.version_tag ?? 'latest'}:${Date.now()}`,
      payload: {
        variant: body.variant ?? (body.version_tag ? 'extended' : null),
        version_tag: body.version_tag ?? null,
      },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'singbox.install',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        variant: body.variant ?? (body.version_tag ? 'extended' : null),
        version: body.version_tag ?? null,
        previous_variant: router.sing_box_variant,
        previous_version: router.sing_box_version,
        job_id: job.id,
      },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.post('/api/v1/routers/:id/singbox/rollback', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    assertOnline(router);

    if (!router.sing_box_previous_variant && !router.sing_box_previous_version) {
      throw conflict('no_previous_version', 'Нет сохранённой предыдущей версии sing-box');
    }

    const job = await enqueueJob(pool, {
      type: 'sb_install',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 900,
      maxAttempts: 1,
      idempotencyKey: `sb_rollback:${router.id}:${Date.now()}`,
      payload: {
        variant: router.sing_box_previous_variant ?? 'stable',
        version_tag: router.sing_box_previous_version ?? null,
      },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'singbox.rollback',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        variant: router.sing_box_previous_variant,
        version: router.sing_box_previous_version,
        job_id: job.id,
      },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  app.post('/api/v1/routers/:id/singbox/check', async (request, reply) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouter(pool, auth, params.id);
    assertOnline(router);

    const job = await enqueueJob(pool, {
      type: 'sb_check',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 120,
      idempotencyKey: `sb_check:${router.id}:${Date.now()}`,
      payload: {},
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'singbox.check',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  // -------------------------------------------------------------------------
  // Staged rollout (только суперадминистратор)
  // -------------------------------------------------------------------------

  app.get('/api/v1/rollouts', async (request) => {
    requireUser(request);
    const result = await pool.query(
      `select ro.*, u.email as created_by_email,
              (select count(*)::int from rollout_targets t where t.rollout_id = ro.id) as targets,
              (select count(*)::int from rollout_targets t where t.rollout_id = ro.id and t.status = 'success') as succeeded
         from rollouts ro left join users u on u.id = ro.created_by
        order by ro.created_at desc limit 50`,
    );
    return { items: result.rows };
  });

  app.get('/api/v1/rollouts/:id', async (request) => {
    requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rollout = await pool.query('select * from rollouts where id = $1', [params.id]);
    if (!rollout.rows[0]) throw notFound('Rollout не найден');
    const targets = await pool.query(
      `select t.*, r.name as router_name, r.status as router_status, r.sing_box_version
         from rollout_targets t join routers r on r.id = t.router_id
        where t.rollout_id = $1 order by t.stage, r.name`,
      [params.id],
    );
    return { rollout: rollout.rows[0], targets: targets.rows };
  });

  app.post('/api/v1/rollouts', async (request, reply) => {
    const auth = requireSuperadmin(request);
    const body = z
      .object({
        variant: z.enum(['tiny', 'extended', 'extended_compressed', 'stable']),
        version_tag: z.string().min(1).max(60).optional(),
        router_ids: z.array(z.string().uuid()).max(100).optional(),
      })
      .strict()
      .refine((value) => value.variant === 'extended' || !value.version_tag, {
        message: 'Конкретную версию можно выбрать только для варианта Extended',
      })
      .parse(request.body);

    const settings = await loadSettings(pool);
    if (settings.singbox.stagedRollout === 'off') {
      throw conflict('rollout_disabled', 'Поэтапное обновление отключено в настройках сервера');
    }

    if (body.version_tag) {
      const version = await pool.query(
        'select 1 from sing_box_versions where product = $1 and tag = $2',
        ['sing-box-extended', body.version_tag],
      );
      if (!version.rows[0]) throw notFound('Версия отсутствует в каталоге Extended');
    }

    const routers = await pool.query<{ id: string }>(
      `select id from routers
        where archived_at is null
          and status in ('online','offline')
          and ($1::uuid[] is null or id = any($1::uuid[]))
        order by name`,
      [body.router_ids && body.router_ids.length > 0 ? body.router_ids : null],
    );
    if (routers.rows.length === 0) throw badRequest('no_routers', 'Нет подходящих роутеров');

    const rolloutId = uuidv7();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into rollouts (id, variant, version_tag, status, stage, created_by)
         values ($1,$2,$3,'draft',0,$4)`,
        [rolloutId, body.variant, body.version_tag ?? '', auth.userId],
      );

      const total = routers.rows.length;
      const canary = 1;
      const second = Math.max(canary + 1, Math.ceil(total * 0.25));

      let index = 0;
      for (const router of routers.rows) {
        const stage = index < canary ? 1 : index < second ? 2 : 3;
        await client.query(
          `insert into rollout_targets (rollout_id, router_id, stage, status)
           values ($1,$2,$3,'pending')`,
          [rolloutId, router.id, stage],
        );
        index += 1;
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'rollout.create',
      targetType: 'rollout',
      targetId: rolloutId,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { variant: body.variant, version: body.version_tag ?? null, routers: routers.rows.length },
    });

    reply.code(201);
    return { rollout_id: rolloutId, targets: routers.rows.length };
  });

  app.post('/api/v1/rollouts/:id/start', async (request, reply) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rollout = await getRollout(pool, params.id);
    if (rollout.status !== 'draft') throw conflict('rollout_state', 'Rollout уже запущен');

    await pool.query(
      `update rollouts set status = 'running', stage = 1, stage_started_at = now(),
              approved_by = $2 where id = $1`,
      [rollout.id, auth.userId],
    );
    const jobs = await enqueueStage(
      pool,
      rollout.id,
      rollout.variant ?? 'extended',
      rollout.version_tag,
      1,
      auth.userId,
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'rollout.start',
      targetType: 'rollout',
      targetId: rollout.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { version: rollout.version_tag, stage: 1, jobs: jobs.length },
    });

    reply.code(202);
    return { rollout_id: rollout.id, stage: 1, jobs };
  });

  app.post('/api/v1/rollouts/:id/advance', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rollout = await getRollout(pool, params.id);
    if (rollout.status !== 'running' && rollout.status !== 'paused') {
      throw conflict('rollout_state', 'Продвижение возможно только для активного rollout');
    }

    const targets = await pool.query<{ status: string }>(
      'select status from rollout_targets where rollout_id = $1 and stage = $2',
      [rollout.id, rollout.stage],
    );
    const failed = targets.rows.filter((row) => row.status === 'failed').length;
    if (failed > 0) {
      await pool.query(`update rollouts set status = 'failed', finished_at = now() where id = $1`, [
        rollout.id,
      ]);
      throw conflict('rollout_failed', 'На текущем этапе есть неудачные установки');
    }
    const pending = targets.rows.filter(
      (row) => row.status !== 'success' && row.status !== 'skipped',
    ).length;
    if (pending > 0) {
      throw conflict('stage_not_finished', 'Текущий этап ещё не завершён');
    }

    const nextStage = rollout.stage + 1;
    const exists = await pool.query('select 1 from rollout_targets where rollout_id = $1 and stage = $2', [
      rollout.id,
      nextStage,
    ]);
    if (!exists.rows[0]) {
      await pool.query(
        `update rollouts set status = 'completed', finished_at = now() where id = $1`,
        [rollout.id],
      );
      return { rollout_id: rollout.id, status: 'completed' };
    }

    await pool.query('update rollouts set stage = $2, stage_started_at = now() where id = $1', [
      rollout.id,
      nextStage,
    ]);
    const jobs = await enqueueStage(
      pool,
      rollout.id,
      rollout.variant ?? 'extended',
      rollout.version_tag,
      nextStage,
      auth.userId,
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'rollout.advance',
      targetType: 'rollout',
      targetId: rollout.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { stage: nextStage, jobs: jobs.length },
    });

    return { rollout_id: rollout.id, stage: nextStage, jobs };
  });

  app.post('/api/v1/rollouts/:id/pause', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rollout = await getRollout(pool, params.id);
    if (rollout.status !== 'running') throw conflict('rollout_state', 'Rollout не запущен');
    await pool.query(`update rollouts set status = 'paused' where id = $1`, [rollout.id]);
    return { ok: true, status: 'paused' };
  });

  app.post('/api/v1/rollouts/:id/resume', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rollout = await getRollout(pool, params.id);
    if (rollout.status !== 'paused') throw conflict('rollout_state', 'Rollout не на паузе');
    await pool.query(`update rollouts set status = 'running' where id = $1`, [rollout.id]);
    return { ok: true, status: 'running' };
  });

  app.post('/api/v1/rollouts/:id/cancel', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rollout = await getRollout(pool, params.id);
    if (rollout.status === 'completed' || rollout.status === 'cancelled') {
      throw conflict('rollout_state', 'Rollout уже завершён');
    }
    await pool.query(`update rollouts set status = 'cancelled', finished_at = now() where id = $1`, [
      rollout.id,
    ]);
    await pool.query(
      `update jobs set status = 'cancelled', finished_at = now(), error_code = 'rollout_cancelled'
        where idempotency_key like $1 and status = 'queued'`,
      [`rollout:${rollout.id}:%`],
    );
    return { ok: true, status: 'cancelled' };
  });
}

async function getRollout(
  pool: Pool,
  id: string,
): Promise<{ id: string; version_tag: string; variant: string | null; status: string; stage: number }> {
  const result = await pool.query<{
    id: string;
    version_tag: string;
    variant: string | null;
    status: string;
    stage: number;
  }>('select id, version_tag, variant, status, stage from rollouts where id = $1', [id]);
  const rollout = result.rows[0];
  if (!rollout) throw notFound('Rollout не найден');
  return rollout;
}

async function enqueueStage(
  pool: Pool,
  rolloutId: string,
  variant: string,
  versionTag: string,
  stage: number,
  userId: string,
): Promise<unknown[]> {
  const targets = await pool.query<{ router_id: string }>(
    `select router_id from rollout_targets where rollout_id = $1 and stage = $2 and status = 'pending'`,
    [rolloutId, stage],
  );

  const jobs = [];
  for (const target of targets.rows) {
    await pool.query(
      `update rollout_targets set status = 'installing', started_at = now()
        where rollout_id = $1 and router_id = $2`,
      [rolloutId, target.router_id],
    );
    const job = await enqueueJob(pool, {
      type: 'sb_install',
      routerId: target.router_id,
      requestedBy: userId,
      timeoutSeconds: 900,
      maxAttempts: 1,
      idempotencyKey: `rollout:${rolloutId}:${target.router_id}`,
      payload: {
        variant,
        version_tag: versionTag === '' ? null : versionTag,
        rollout_id: rolloutId,
      },
    });
    jobs.push(jobJson(job));
  }
  return jobs;
}
