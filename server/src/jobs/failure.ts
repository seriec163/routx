import { isHttpError } from '../lib/errors.js';
import { JobFailure } from './handlers.js';

/**
 * Повторяем только те ошибки, которые действительно могут исчезнуть сами:
 * агент не ответил вовремя/недоступен или временно упала БД. Ошибки валидации
 * (HttpError 4xx) и внутренние ошибки не ретраятся — иначе одна и та же
 * команда уходит на роутер несколько раз, а в UI вместо понятного кода
 * показывается `internal_error`.
 */
export const RETRYABLE_JOB_CODES = new Set([
  'agent_timeout',
  'agent_unavailable',
  'db_error',
]);

export function toJobFailure(error: unknown): JobFailure {
  if (error instanceof JobFailure) return error;
  if (isHttpError(error)) {
    return new JobFailure(
      error.code || 'request_failed',
      (error.message || 'Запрос отклонён').slice(0, 500),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new JobFailure('internal_error', message.slice(0, 500));
}

export function isRetryableJobFailure(failure: JobFailure): boolean {
  return failure.terminal === 'failed' && RETRYABLE_JOB_CODES.has(failure.code);
}
