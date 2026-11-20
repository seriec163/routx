import { describe, expect, it } from 'vitest';
import { deviceLabel } from '../src/mobile/device.js';

describe('имя авторизованного устройства', () => {
  it('узнаёт iPhone и Safari', () => {
    const label = deviceLabel(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    );
    expect(label.platform).toBe('iOS');
    expect(label.name).toBe('iPhone · Safari');
  });

  it('узнаёт Android и Chrome', () => {
    const label = deviceLabel(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    );
    expect(label.platform).toBe('Android');
    expect(label.name).toBe('Android · Chrome');
  });

  it('не падает без User-Agent', () => {
    const label = deviceLabel(null);
    expect(label.platform).toBeNull();
    expect(label.name).toBe('Устройство');
  });
});
