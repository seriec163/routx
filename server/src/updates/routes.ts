import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { audit } from '../audit.js';
import { requireSuperadmin } from '../auth/service.js';
import { HttpError } from '../lib/errors.js';
import { APP_BUILD_SHA, APP_VERSION } from '../version.js';

interface RouteContext {
  pool: Pool;
}

interface LatestCommit {
  sha: string;
  message: string;
  date: string;
  url: string;
}

interface UpdaterStatus {
  state?: string;
  message?: string;
  updated_at?: string;
  from_build?: string;
  to_build?: string;
}

const REPO = 'seriec163/routx';
const UPDATE_DIR = process.env.RC_UPDATE_DIR ?? '/app/update';
const CACHE_MS = 5 * 60_000;
const BUSY_STATES = new Set(['pulling', 'restarting', 'rolling_back']);

let cache: { at: number; latest: LatestCommit } | null = null;

async function fetchLatest(force: boolean): Promise<LatestCommit> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.latest;
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/publish-image.yml/runs?status=success&per_page=1`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'routx-panel',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) {
    throw new HttpError(502, 'github_unavailable', `GitHub ответил ${response.status}`);
  }
  const body = (await response.json()) as {
    workflow_runs?: Array<{
      head_sha?: string;
      html_url?: string;
      created_at?: string;
      head_commit?: { message?: string; timestamp?: string };
    }>;
  };
  const run = body.workflow_runs?.[0];
  const sha = run?.head_sha;
  if (!sha) throw new HttpError(502, 'github_unavailable', 'GitHub не вернул опубликованный образ');
  const latest: LatestCommit = {
    sha,
    message: (run?.head_commit?.message ?? '').split('\n')[0]?.slice(0, 200) ?? '',
    date: run?.head_commit?.timestamp ?? run?.created_at ?? new Date().toISOString(),
    url: run?.html_url ?? `https://github.com/${REPO}/commit/${sha}`,
  };
  cache = { at: Date.now(), latest };
  return latest;
}

async function readStatus(): Promise<UpdaterStatus | null> {
  try {
    const raw = await readFile(join(UPDATE_DIR, 'status.json'), 'utf8');
    const parsed = JSON.parse(raw) as UpdaterStatus;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function updaterInstalled(): boolean {
  return existsSync(join(UPDATE_DIR, '.updater-installed'));
}

async function requestUpdate(
  action: 'update' | 'rollback',
  userId: string,
  targetSha?: string,
): Promise<void> {
  const status = await readStatus();
  if (status?.state && BUSY_STATES.has(status.state)) {
    throw new HttpError(409, 'update_in_progress', 'Обновление уже выполняется');
  }
  try {
    await mkdir(UPDATE_DIR, { recursive: true });
    if (existsSync(join(UPDATE_DIR, 'request'))) {
      throw new HttpError(409, 'update_in_progress', 'Запрос на обновление уже отправлен');
    }
    const temp = join(UPDATE_DIR, 'request.tmp');
    await writeFile(
      temp,
      [
        action,
        `requested_by=${userId}`,
        `requested_at=${new Date().toISOString()}`,
        ...(targetSha ? [`target_sha=${targetSha}`] : []),
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await rename(temp, join(UPDATE_DIR, 'request'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'updater_unavailable',
      'Updater не установлен или каталог обновлений недоступен. Установите его командой sudo routx updater install.',
    );
  }
}

export async function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  async function payload() {
    let latest: LatestCommit | null = null;
    let error: string | null = null;
    try {
      latest = await fetchLatest(false);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Не удалось проверить GitHub';
    }
    return {
      current: { version: APP_VERSION, build: APP_BUILD_SHA },
      latest,
      update_available:
        Boolean(latest) && APP_BUILD_SHA !== 'dev' && latest!.sha !== APP_BUILD_SHA,
      checked_at: cache ? new Date(cache.at).toISOString() : null,
      updater_installed: updaterInstalled(),
      status: await readStatus(),
      error,
    };
  }

  app.get('/api/v1/updates', async (request) => {
    requireSuperadmin(request);
    return payload();
  });

  app.post('/api/v1/updates/check', async (request) => {
    requireSuperadmin(request);
    cache = null;
    return payload();
  });

  app.post('/api/v1/updates/apply', async (request) => {
    const auth = requireSuperadmin(request);
    let targetSha = '';
    try {
      targetSha = (await fetchLatest(false)).sha;
    } catch {
      // Если GitHub недоступен, updater просто скачает latest.
    }
    await requestUpdate('update', auth.userId, targetSha);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'panel.update_request',
      targetType: 'panel',
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        current_build: APP_BUILD_SHA,
        current_version: APP_VERSION,
        target_sha: targetSha || null,
      },
    });
    return { ok: true, target_sha: targetSha || null };
  });

  app.post('/api/v1/updates/rollback', async (request) => {
    const auth = requireSuperadmin(request);
    await requestUpdate('rollback', auth.userId);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'panel.rollback_request',
      targetType: 'panel',
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { current_build: APP_BUILD_SHA, current_version: APP_VERSION },
    });
    return { ok: true };
  });
}
