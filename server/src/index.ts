import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { APP_BUILD_SHA, APP_VERSION } from './version.js';
import { loadSettings } from './settings.js';
import { JobWorker } from './jobs/worker.js';
import { ensureBootstrapAdmin } from './bootstrap.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

if (config.MIGRATE_ON_START) {
  await migrate(db.pool, {
    dir: config.MIGRATIONS_DIR,
    info: (message) => console.info(message),
  });
}

const bootstrap = await ensureBootstrapAdmin(db.pool, {
  email: config.RC_BOOTSTRAP_EMAIL,
  password: config.RC_BOOTSTRAP_PASSWORD,
}).catch((error: Error) => {
  console.error('Bootstrap администратора не выполнен:', error.message);
  return { created: false, reason: 'error' };
});

const webDist =
  config.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

const logger = config.isProduction
  ? { level: config.LOG_LEVEL }
  : {
      level: config.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    };

const secureCookie =
  config.RC_COOKIE_SECURE === 'true' ||
  (config.RC_COOKIE_SECURE === 'auto' && config.RC_PUBLIC_URL.startsWith('https://'));

const masterKey = config.RC_MASTER_KEY ?? 'routx-development-master-key-please-change';

import { existsSync } from 'node:fs';
import path from 'node:path';
const agentDist = config.RC_AGENT_DIST || path.resolve(process.cwd(), '..', 'agent', 'dist');
(global as any).__RC_AGENT_DIST = existsSync(agentDist) ? agentDist : null;
const app = await buildApp({
  db,
  logger,
  webDist,
  trustProxy: config.TRUST_PROXY,
  agentDist: (global as any).__RC_AGENT_DIST,
  config: {
    masterKey,
    publicUrl: config.RC_PUBLIC_URL,
    secureCookie,
    agentRequireSignature: config.RC_AGENT_REQUIRE_SIGNATURE,
    agentPollHoldSeconds: config.RC_AGENT_POLL_HOLD_SECONDS,
    masterKeySource: config.masterKeySource,
    masterKeyFile: config.masterKeyFile,
    dataDir: path.dirname(config.masterKeyFile),
    migrationsDir:
      config.MIGRATIONS_DIR ??
      fileURLToPath(new URL('../migrations', import.meta.url)),
    databaseUrl: config.DATABASE_URL,
    cookieSecureRaw: config.RC_COOKIE_SECURE,
    vapidPublicKey: config.RC_VAPID_PUBLIC_KEY,
    vapidPrivateKey: config.RC_VAPID_PRIVATE_KEY,
    vapidSubject: config.RC_VAPID_SUBJECT,
  },
});

const settings = await loadSettings(db.pool);
const worker = new JobWorker({
  pool: db.pool,
  settings,
  log: app.log,
  masterKey,
  publicUrl: config.RC_PUBLIC_URL,
});
worker.start();

let closing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;

  app.log.info({ signal }, 'остановка RoutX');
  try {
    await worker.stop();
    await app.close();
    await db.close();
    process.exit(0);
  } catch (error) {
    console.error('Ошибка при остановке:', error);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    {
      version: APP_VERSION,
      build: APP_BUILD_SHA,
      env: config.NODE_ENV,
      public_url: config.RC_PUBLIC_URL,
      web: config.WEB_DIST ?? webDist,
      agent_signature: config.RC_AGENT_REQUIRE_SIGNATURE,
      bootstrap: bootstrap.created ? 'created' : bootstrap.reason,
    },
    'RoutX запущен',
  );

  if (!bootstrap.created && bootstrap.reason === 'no_credentials') {
    app.log.warn(
      'В базе нет пользователей. Задайте RC_BOOTSTRAP_EMAIL и RC_BOOTSTRAP_PASSWORD ' +
        'или выполните: npm run bootstrap -- <email> <password>',
    );
  }
  if (!secureCookie) {
    app.log.warn(
      'Cookie без флага Secure (лабораторный HTTP-режим). Для production используйте HTTPS и RC_COOKIE_SECURE=true.',
    );
  }
  if (!config.RC_AGENT_REQUIRE_SIGNATURE) {
    app.log.warn('Подпись запросов агента отключена (RC_AGENT_REQUIRE_SIGNATURE=false). Только для лаборатории.');
  }
} catch (error) {
  app.log.error({ err: error }, 'не удалось запустить сервер');
  await worker.stop();
  await db.close();
  process.exit(1);
}
