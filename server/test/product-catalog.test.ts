import { describe, expect, it } from 'vitest';
import { compareProductVersions } from '../src/domain/product-catalog.js';

describe('сравнение версий продуктов', () => {
  it('ставит стабильную версию выше release candidate', () => {
    expect(compareProductVersions('2.0.0', '2.0.0-rc.2')).toBe(1);
    expect(compareProductVersions('2.0.0-rc.2', '2.0.0')).toBe(-1);
  });

  it('сравнивает номера release candidate', () => {
    expect(compareProductVersions('2.0.0-rc.2', '2.0.0-rc.1')).toBe(1);
    expect(compareProductVersions('2.0.0-rc.10', '2.0.0-rc.2')).toBe(1);
  });

  it('сравнивает базовые версии', () => {
    expect(compareProductVersions('2.1.0-rc.1', '2.0.9')).toBe(1);
    expect(compareProductVersions('v2.0.0', '2.0.0')).toBe(0);
  });
});
