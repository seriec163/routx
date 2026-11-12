import { describe, expect, it } from 'vitest';
import { proxyHealthOf } from '../src/jobs/handlers.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const settings = DEFAULT_SETTINGS;

describe('proxy health при переключении на резервные соединения', () => {
  it('не считает деградацией упавшие резервные теги', () => {
    expect(
      proxyHealthOf(
        { proxy_health: 'degraded', failed_tags: 2, total_tags: 8, latency_ms: 120 },
        settings,
      ),
    ).toBe('healthy');
  });

  it('оставляет деградацию при высокой задержке активного соединения', () => {
    expect(
      proxyHealthOf(
        { proxy_health: 'degraded', failed_tags: 2, total_tags: 8, latency_ms: 2200 },
        settings,
      ),
    ).toBe('degraded');
  });

  it('считает группу здоровой, если жив хотя бы один тег', () => {
    expect(
      proxyHealthOf(
        { proxy_health: 'healthy', failed_tags: 3, total_tags: 10, latency_ms: 90 },
        settings,
      ),
    ).toBe('healthy');
  });

  it('оставляет dead, когда не ответил ни один тег', () => {
    expect(
      proxyHealthOf(
        { proxy_health: 'dead', failed_tags: 8, total_tags: 8 },
        settings,
      ),
    ).toBe('dead');
  });

  it('работает со старым агентом без явного proxy_health', () => {
    expect(
      proxyHealthOf({ failed_tags: 2, total_tags: 8, latency_ms: 120 }, settings),
    ).toBe('healthy');
    expect(proxyHealthOf({ failed_tags: 8, total_tags: 8 }, settings)).toBe('dead');
    expect(proxyHealthOf({}, settings)).toBe('unknown');
  });

  it('сохраняет деградацию уровня службы без данных о тегах', () => {
    expect(proxyHealthOf({ proxy_health: 'degraded' }, settings)).toBe('degraded');
  });
});
