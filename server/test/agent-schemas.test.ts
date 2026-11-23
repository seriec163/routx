import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bindSchema, probeSchema, resultSchema } from '../src/agent/schemas.js';

describe('схемы агентского API', () => {
  it('принимает probe с managed и capabilities', () => {
    const parsed = probeSchema.parse({
      agent_version: '1.5.53',
      product: 'tachyon',
      platform_state: 'ok',
      managed: { 'section.rc_main.action': 'connection' },
      capabilities: { readonly: false },
    });
    expect(parsed.product).toBe('tachyon');
  });

  it('не пропускает лишние поля в bind', () => {
    expect(() =>
      bindSchema.parse({ token: 'x'.repeat(24), unexpected: true }),
    ).toThrow();
  });

  it('проверяет статус результата команды', () => {
    expect(resultSchema.parse({ status: 'success' }).status).toBe('success');
    expect(() => resultSchema.parse({ status: 'ok' })).toThrow();
  });

  it('превращается в JSON Schema для контракта', () => {
    const json = z.toJSONSchema(probeSchema) as { type?: string; properties?: object };
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(5);
  });
});
