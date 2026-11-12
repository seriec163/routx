import { describe, expect, it } from 'vitest';
import { parseSubscriptionBody } from '../src/domain/subscription.js';

describe('Podkop subscription parser', () => {
  it('parses plain links and skips unsupported schemes', () => {
    const result = parseSubscriptionBody(
      [
        '# comment',
        'vless://11111111-1111-1111-1111-111111111111@example.com:443#One',
        'ss://YWVzLTI1Ni1nY206cGFzcw==@example.net:8388#Two',
        'vmess://eyJ2IjoiMiJ9',
        'vless://11111111-1111-1111-1111-111111111111@example.com:443#One',
      ].join('\n'),
    );
    expect(result.links).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it('decodes base64 subscription bodies', () => {
    const body = Buffer.from(
      'vless://11111111-1111-1111-1111-111111111111@example.com:443#One\n' +
        'trojan://secret@example.net:443#Two\n',
    ).toString('base64');
    const result = parseSubscriptionBody(body);
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toContain('vless://');
  });

  it('rejects a subscription without supported links', () => {
    expect(() => parseSubscriptionBody('vmess://a\nhttp://example.com')).toThrow(
      /не найдено поддерживаемых/,
    );
  });
});
