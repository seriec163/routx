import type { Pool } from 'pg';
import { maskSecrets } from './lib/crypto.js';

export type AuditResult = 'ok' | 'denied' | 'error';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  routerId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  result?: AuditResult;
  code?: string | null;
  metadata?: Record<string, unknown>;
}

const SECRET_KEY = /(password|passwd|secret|token|hash|key|cookie|authorization|credential|private)/i;
const SAFE_URL_KEYS = new Set(['rule_set', 'rule_set_with_subnets', 'testing_url']);

/** Метаданные аудита: только allowlist-подобная очистка, без секретов и VLESS/Sub-ссылок. */
export function sanitizeMetadata(
  value: unknown,
  key = '',
  depth = 0,
): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) && !SAFE_URL_KEYS.has(key)) return '[redacted]';
    const masked = maskSecrets(value);
    return masked.length > 500 ? `${masked.slice(0, 500)}…` : masked;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetadata(item, key, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(childKey) && !SAFE_URL_KEYS.has(childKey)) {
        output[childKey] = '[redacted]';
        continue;
      }
      output[childKey] = sanitizeMetadata(childValue, childKey, depth + 1);
    }
    return output;
  }
  return null;
}

/** Санитайзер отчётов диагностики: маскирует секреты, но не режет текст до 500 символов. */
export function sanitizeReport(value: unknown, key = '', depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) && !SAFE_URL_KEYS.has(key)) return '[redacted]';
    return maskSecrets(value).slice(0, 200_000);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 2000).map((item) => sanitizeReport(item, key, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(childKey) && !SAFE_URL_KEYS.has(childKey)) {
        output[childKey] = '[redacted]';
        continue;
      }
      output[childKey] = sanitizeReport(childValue, childKey, depth + 1);
    }
    return output;
  }
  return null;
}

export async function audit(pool: Pool, input: AuditInput): Promise<void> {
  try {
    await pool.query(
      `insert into audit_log
         (actor_id, actor_role, action, target_type, target_id, router_id, ip, user_agent, result, code, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        input.actorId ?? null,
        input.actorRole ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.routerId ?? null,
        input.ip ?? null,
        input.userAgent?.slice(0, 300) ?? null,
        input.result ?? 'ok',
        input.code ?? null,
        JSON.stringify(sanitizeMetadata(input.metadata ?? {})),
      ],
    );
  } catch (error) {
    // Аудит не должен ломать основной сценарий, но ошибка обязана попасть в лог.
    console.error('audit_log write failed', error);
  }
}
