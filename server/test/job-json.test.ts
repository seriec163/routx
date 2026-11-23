import { describe, expect, it } from 'vitest';
import { jobJson, type JobRow } from '../src/jobs/queue.js';

function row(overrides: Partial<JobRow>): JobRow {
  const now = new Date();
  return {
    id: '01a30000-0000-7000-8000-000000000001',
    type: 'wifi_read',
    router_id: '01a30000-0000-7000-8000-000000000002',
    batch_id: null,
    requested_by: null,
    status: 'queued',
    priority: 100,
    payload: {},
    result: null,
    attempt: 0,
    max_attempts: 1,
    timeout_seconds: 60,
    idempotency_key: null,
    scheduled_at: now,
    started_at: null,
    finished_at: null,
    error_code: null,
    error_detail: null,
    created_at: now,
    router_status: 'online',
    ...overrides,
  };
}

describe('представление задачи', () => {
  it('помечает queued-задачу офлайн-роутера как ожидающую', () => {
    expect(jobJson(row({ router_status: 'offline' })).waiting_for_router).toBe(true);
    expect(jobJson(row({ router_status: 'online' })).waiting_for_router).toBe(false);
    expect(jobJson(row({ status: 'running', router_status: 'offline' })).waiting_for_router).toBe(
      false,
    );
  });

  it('не помечает задачу без роутера', () => {
    expect(jobJson(row({ router_id: null, router_status: null })).waiting_for_router).toBe(false);
  });
});
