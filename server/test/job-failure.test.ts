import { describe, expect, it } from 'vitest';
import { badRequest, unavailable } from '../src/lib/errors.js';
import { JobFailure } from '../src/jobs/handlers.js';
import { isRetryableJobFailure, toJobFailure } from '../src/jobs/failure.js';

describe('классификация ошибок задач', () => {
  it('сохраняет код и сообщение JobFailure', () => {
    const failure = toJobFailure(new JobFailure('section_missing', 'нет секции'));

    expect(failure.code).toBe('section_missing');
    expect(failure.message).toBe('нет секции');
    expect(isRetryableJobFailure(failure)).toBe(false);
  });

  it('не превращает ошибку валидации в internal_error', () => {
    const failure = toJobFailure(
      badRequest('section_without_connection', 'Секция не существует на роутере'),
    );

    expect(failure.code).toBe('section_without_connection');
    expect(failure.message).toContain('не существует');
    expect(isRetryableJobFailure(failure)).toBe(false);
  });

  it('ретраит только временные ошибки агента и БД', () => {
    expect(isRetryableJobFailure(toJobFailure(unavailable('agent_unavailable', 'агент offline')))).toBe(
      true,
    );
    expect(isRetryableJobFailure(toJobFailure(new JobFailure('db_error', 'connection lost')))).toBe(
      true,
    );
  });

  it('неизвестную ошибку оставляет internal_error без ретраев', () => {
    const failure = toJobFailure(new Error('boom'));

    expect(failure.code).toBe('internal_error');
    expect(failure.message).toBe('boom');
    expect(isRetryableJobFailure(failure)).toBe(false);
  });

  it('приводит не-Error к internal_error', () => {
    expect(toJobFailure('boom').code).toBe('internal_error');
  });
});
