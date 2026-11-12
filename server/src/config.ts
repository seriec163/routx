import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// npm workspace scripts запускаются с cwd=server, поэтому ищем .env и в корне
// репозитория. Уже заданные переменные окружения не перезаписываются.
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  fileURLToPath(new URL('../../.env', import.meta.url)),
];

for (const file of envCandidates) {
  if (!existsSync(file)) continue;
  loadEnvFile(file);
  break;
}

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://router_control:router_control@127.0.0.1:5432/router_control'),
  RC_MASTER_KEY: z.string().optional(),
  RC_MASTER_KEY_FILE: z.string().optional(),
  WEB_DIST: z.string().optional(),
  MIGRATIONS_DIR: z.string().optional(),
  MIGRATE_ON_START: booleanFromEnv.default(false),
  TRUST_PROXY: booleanFromEnv.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RC_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  RC_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  RC_AGENT_REQUIRE_SIGNATURE: booleanFromEnv.default(true),
  RC_AGENT_POLL_HOLD_SECONDS: z.coerce.number().int().min(1).max(25).default(25),
  RC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RC_MONITORING_SECONDS: z.coerce.number().int().min(30).max(600).default(60),
  RC_BOOTSTRAP_EMAIL: z.string().email().optional(),
  RC_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  RC_AGENT_DIST: z.string().optional(),
  RC_VAPID_PUBLIC_KEY: z.string().optional(),
  RC_VAPID_PRIVATE_KEY: z.string().optional(),
  RC_VAPID_SUBJECT: z.string().optional(),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  masterKeyFile: string;
  masterKeySource: 'file' | 'env';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Некорректная конфигурация: ${details}`);
  }

  const config = parsed.data;
  const isProduction = config.NODE_ENV === 'production';

  // Ключ шифрования можно хранить в файле: так перенос на другой сервер
  // переносит и его, не требуя правки .env. Файл приоритетнее переменной.
  const masterKeyFile = config.RC_MASTER_KEY_FILE || '/app/data/master.key';
  let fileMasterKey: string | null = null;
  if (existsSync(masterKeyFile)) {
    try {
      const raw = readFileSync(masterKeyFile, 'utf8').trim();
      if (raw.length >= 32) fileMasterKey = raw;
    } catch {
      // Нечитаемый файл не должен ронять старт: останется ключ из env.
    }
  }

  const masterKey = fileMasterKey ?? config.RC_MASTER_KEY ?? null;

  if (isProduction && (!masterKey || masterKey.length < 32)) {
    throw new Error(
      'RC_MASTER_KEY обязателен в production и должен содержать не менее 32 символов',
    );
  }

  return {
    ...config,
    RC_MASTER_KEY: masterKey ?? undefined,
    masterKeyFile,
    masterKeySource: fileMasterKey ? ('file' as const) : ('env' as const),
    isProduction,
  };
}
