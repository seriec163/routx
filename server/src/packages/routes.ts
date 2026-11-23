import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireSuperadmin } from '../auth/service.js';
import { notFound } from '../lib/errors.js';
import {
  getAssetById,
  getAssetByPath,
  getPackageStatus,
  getRawFile,
  getReleaseJson,
  loadPackageRow,
  readPackageContent,
  startPackageSync,
} from './service.js';

interface RouteContext {
  pool: Pool;
  dataDir: string;
  publicUrl: string;
}

const PRODUCTS = new Set(['tachyon', 'forkop', 'podkop']);
const INSTALLER_FILES = new Set(['install.sh', 'uninstall.sh']);

function sendBuffer(
  reply: FastifyReply,
  content: Buffer,
  contentType: string,
  filename?: string,
): FastifyReply {
  reply.type(contentType);
  if (filename) {
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
    );
  }
  return reply.send(content);
}

export async function registerPackageRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool, dataDir, publicUrl } = ctx;

  app.get('/api/v1/packages', async (request) => {
    requireSuperadmin(request);
    return getPackageStatus(pool);
  });

  app.post(
    '/api/v1/packages/sync',
    { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } },
    async (request) => {
      const auth = requireSuperadmin(request);
      void startPackageSync(pool, dataDir, publicUrl, app.log).catch(() => undefined);
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'packages.sync',
        targetType: 'packages',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { source: 'manual' },
      });
      return { started: true };
    },
  );

  app.get('/downloads/packages/:product/:file', async (request, reply) => {
    const params = z
      .object({
        product: z.string().max(32),
        file: z.string().max(64),
      })
      .parse(request.params);
    if (!PRODUCTS.has(params.product) || !INSTALLER_FILES.has(params.file)) {
      throw notFound('Установщик не найден');
    }
    const row = await loadPackageRow(pool, 'installer', {
      product: params.product,
      name: params.file,
    });
    if (!row) throw notFound('Установщик ещё не синхронизирован');
    const content = await readPackageContent(dataDir, row);
    return sendBuffer(reply, content, 'text/x-shellscript; charset=utf-8');
  });

  app.get('/downloads/github/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'] ?? '';
    const parts = wildcard.split('/').filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    const releasesIndex = parts.indexOf('releases');
    if (!owner || !repo || releasesIndex < 0) throw notFound('Файл не найден');

    const after = parts.slice(releasesIndex + 1);
    let tag: string;
    let file: string;
    if (after[0] === 'latest' && after[1] === 'download') {
      tag = 'latest';
      file = after.slice(2).join('/');
    } else if (after[0] === 'download') {
      tag = after[1] ?? '';
      file = after.slice(2).join('/');
    } else {
      throw notFound('Файл не найден');
    }
    if (!tag || !file) throw notFound('Файл не найден');

    const asset = await getAssetByPath(
      pool,
      dataDir,
      owner,
      repo,
      tag,
      decodeURIComponent(file),
    );
    if (!asset) throw notFound('Файл не найден в зеркале и на GitHub');
    return sendBuffer(
      reply,
      asset.content,
      'application/octet-stream',
      decodeURIComponent(file),
    );
  });

  app.get('/downloads/github-api/repos/:owner/:repo/releases/latest', async (request, reply) => {
    const params = z
      .object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) })
      .parse(request.params);
    const query = z.object({ rewrite: z.enum(['0', '1']).optional() }).parse(request.query);
    const release = await getReleaseJson(
      pool,
      dataDir,
      params.owner,
      params.repo,
      query.rewrite === '1',
      publicUrl,
    );
    if (!release) throw notFound('Релиз не найден в зеркале');
    return sendBuffer(reply, Buffer.from(release.body), 'application/json; charset=utf-8');
  });

  app.get(
    '/downloads/github-api/repos/:owner/:repo/releases/assets/:id',
    async (request, reply) => {
      const params = z
        .object({
          owner: z.string().min(1).max(100),
          repo: z.string().min(1).max(100),
          id: z.string().regex(/^\d+$/),
        })
        .parse(request.params);
      const asset = await getAssetById(pool, dataDir, params.owner, params.repo, params.id);
      if (!asset) throw notFound('Пакет не найден в зеркале');
      return sendBuffer(reply, asset.content, 'application/octet-stream', asset.row.name);
    },
  );

  app.get('/downloads/raw/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'] ?? '';
    const parts = wildcard.split('/').filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    const ref = parts[2];
    const filePath = parts.slice(3).join('/');
    if (!owner || !repo || !ref || !filePath) throw notFound('Файл не найден');
    const raw = await getRawFile(pool, dataDir, owner, repo, ref, filePath);
    if (!raw) throw notFound('Файл не найден');
    return sendBuffer(reply, raw.content, 'text/plain; charset=utf-8');
  });
}
