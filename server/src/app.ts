import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import type { AppDb } from './db/index.js';
import { APP_VERSION } from './version.js';
import { HttpError } from './lib/errors.js';
import { registerGuards } from './auth/service.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerRouterRoutes } from './routers/routes.js';
import { registerRouterExtrasRoutes } from './routers/extras.js';
import { registerRouterConnectionRoutes } from './routers/connections.js';
import { registerRouterRuleRoutes } from './routers/rules.js';
import { registerMobileRoutes } from './mobile/routes.js';
import { registerDnsRoutes } from './routers/dns.js';
import { registerSubscriptionRoutes } from './subscriptions/routes.js';
import { registerTemplateRoutes } from './templates/routes.js';
import { registerJobRoutes } from './jobs/routes.js';
import { registerApplyRoutes } from './apply/routes.js';
import { registerMonitoringRoutes } from './monitoring/routes.js';
import { registerDiagnosticsRoutes } from './diagnostics/routes.js';
import { registerSingBoxRoutes } from './singbox/routes.js';
import { registerUserRoutes } from './users/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerAuditRoutes } from './audit/routes.js';
import { registerAgentRoutes } from './agent/routes.js';

export interface AppRuntimeConfig {
  masterKey: string;
  publicUrl: string;
  secureCookie: boolean;
  agentRequireSignature: boolean;
  agentPollHoldSeconds: number;
}

export interface AppDeps {
  db: AppDb & { pool?: Pool };
  config?: AppRuntimeConfig;
  logger?: FastifyServerOptions['logger'];
  webDist?: string | null;
  trustProxy?: boolean;
  agentDist?: string | null;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
}

function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return { error: { code, message, request_id: requestId, details } };
}

function zodMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? true,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (
      request.url.startsWith('/api/') ||
      request.url.startsWith('/agent/') ||
      request.url.startsWith('/healthz') ||
      request.url.startsWith('/readyz')
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    request.rawBody = raw;
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw.toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply
        .code(400)
        .send(errorEnvelope('validation_error', zodMessage(error), request.id, error.issues));
      return;
    }
    if (error instanceof HttpError) {
      reply
        .code(error.status)
        .send(errorEnvelope(error.code, error.message, request.id, error.details));
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      reply.code(429).send(errorEnvelope('rate_limited', 'Слишком много запросов', request.id));
      return;
    }
    if (statusCode === 413) {
      reply.code(413).send(errorEnvelope('payload_too_large', 'Слишком большой запрос', request.id));
      return;
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      reply
        .code(statusCode)
        .send(errorEnvelope('bad_request', (error as Error).message, request.id));
      return;
    }

    request.log.error({ err: error }, 'необработанная ошибка');
    reply
      .code(500)
      .send(errorEnvelope('internal_error', 'Внутренняя ошибка сервера', request.id));
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'router-control',
    version: APP_VERSION,
    uptime_s: Math.round(process.uptime()),
    now: new Date().toISOString(),
  }));

  app.get('/readyz', async (request, reply) => {
    try {
      await deps.db.ping();
      const schemaVersion = await deps.db.getSchemaVersion();

      if (!schemaVersion) {
        reply.code(503);
        return {
          status: 'not_ready',
          version: APP_VERSION,
          checks: { db: 'ok', schema: 'missing' },
          now: new Date().toISOString(),
        };
      }

      return {
        status: 'ready',
        version: APP_VERSION,
        schema_version: schemaVersion,
        checks: { db: 'ok', schema: 'ok' },
        now: new Date().toISOString(),
      };
    } catch (error) {
      request.log.warn({ err: error }, 'проверка готовности не пройдена');
      reply.code(503);
      return {
        status: 'not_ready',
        version: APP_VERSION,
        checks: { db: 'error' },
        now: new Date().toISOString(),
      };
    }
  });

  app.get('/api/v1/meta', async (request, reply) => {
    try {
      const schemaVersion = await deps.db.getSchemaVersion();
      return {
        name: 'router-control',
        version: APP_VERSION,
        api_version: 'v1',
        schema_version: schemaVersion,
        capabilities: {
          agents: 'v1',
          monitoring: true,
          diagnostics: true,
          singbox: true,
        },
      };
    } catch (error) {
      request.log.warn({ err: error }, 'не удалось прочитать schema_version');
      reply.code(503);
      return errorEnvelope('service_unavailable', 'База данных недоступна', request.id);
    }
  });

  const pool = deps.db.pool;
  const config = deps.config;

  if (pool && config) {
    registerGuards(app, pool, { secureCookie: config.secureCookie });

    await registerAuthRoutes(app, {
      pool,
      masterKey: config.masterKey,
      publicUrl: config.publicUrl,
      secureCookie: config.secureCookie,
      inviteTtlSeconds: 7 * 24 * 60 * 60,
    });
    await registerRouterRoutes(app, { pool, publicUrl: config.publicUrl });
    await registerRouterExtrasRoutes(app, { pool });
    await registerRouterConnectionRoutes(app, { pool, masterKey: config.masterKey });
    await registerRouterRuleRoutes(app, { pool, masterKey: config.masterKey });
    await registerMobileRoutes(app, {
      pool,
      secureCookie: config.secureCookie,
    });
    await registerDnsRoutes(app, { pool });
    await registerSubscriptionRoutes(app, { pool, masterKey: config.masterKey });
    await registerTemplateRoutes(app, { pool });
    await registerJobRoutes(app, { pool });
    await registerApplyRoutes(app, { pool });
    await registerMonitoringRoutes(app, { pool });
    await registerDiagnosticsRoutes(app, { pool });
    await registerSingBoxRoutes(app, { pool });
    await registerUserRoutes(app, { pool, publicUrl: config.publicUrl });
    await registerSettingsRoutes(app, { pool });
    await registerAuditRoutes(app, { pool });
    (global as any).__RC_AGENT_DIST = (deps as any).agentDist || process.env.RC_AGENT_DIST || null;
    await registerAgentRoutes(app, {
      pool,
      publicUrl: config.publicUrl,
      requireSignature: config.agentRequireSignature,
      pollHoldSeconds: config.agentPollHoldSeconds,
    });
  }

  const webDist = deps.webDist ? path.resolve(deps.webDist) : null;
  const hasWeb = Boolean(webDist && existsSync(path.join(webDist, 'index.html')));

  if (webDist && hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: ['index.html'],
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
          res.header('Cache-Control', 'no-cache');
          return;
        }
        if (filePath.endsWith('index.html')) {
          res.header('Cache-Control', 'no-store');
        } else {
          res.header('Cache-Control', 'public, max-age=3600');
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isService =
      request.url.startsWith('/api/') ||
      request.url.startsWith('/agent/') ||
      request.url.startsWith('/healthz') ||
      request.url.startsWith('/readyz');

    if (!isService && request.method === 'GET' && hasWeb) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }

    reply.code(404);
    return errorEnvelope('not_found', 'Объект не найден', request.id);
  });

  return app;
}
