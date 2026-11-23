import { describe, expect, it } from 'vitest';
import {
  buildConnectionValue,
  connectionSecretPreview,
  connectionValueFromSecret,
  createConnectionSecret,
  decodeConnectionSecret,
} from '../src/routers/connection-secret.js';

const MASTER_KEY = 'test-master-key-that-is-long-enough';

describe('компактный секрет подключения', () => {
  it('шифрует и расшифровывает VLESS-профиль', () => {
    const secret = createConnectionSecret(
      {
        kind: 'vless',
        host: 'vpn.example.com',
        port: 443,
        credential: '11111111-2222-3333-4444-555555555555',
        sni: 'vpn.example.com',
        path: '/ws',
        transport: 'ws',
        security: 'tls',
        flow: '',
      },
      MASTER_KEY,
    );

    const profile = decodeConnectionSecret(secret, MASTER_KEY);
    expect(profile.kind).toBe('vless');
    expect(profile.host).toBe('vpn.example.com');
    expect(profile.port).toBe(443);
    expect(profile.credential).toBe('11111111-2222-3333-4444-555555555555');
    expect(profile.path).toBe('/ws');
    expect(profile.transport).toBe('ws');
    expect(profile.security).toBe('tls');
    expect(secret.startsWith('rc1.')).toBe(true);
    expect(secret.length).toBeLessThan(200);
  });

  it('шифрует и расшифровывает подписку с доменом и токеном', () => {
    const secret = createConnectionSecret(
      {
        kind: 'subscription',
        host: 'sub.example.com',
        port: 8443,
        path: '/api/v1/client/subscribe',
        credential: '0123456789abcdef0123456789abcdef',
      },
      MASTER_KEY,
    );

    const profile = decodeConnectionSecret(secret, MASTER_KEY);
    expect(profile.kind).toBe('subscription');
    expect(profile.host).toBe('sub.example.com');
    expect(profile.port).toBe(8443);
    expect(profile.path).toBe('/api/v1/client/subscribe');
    expect(profile.credential).toBe('0123456789abcdef0123456789abcdef');
    expect(secret.length).toBeLessThan(220);
  });

  it('поддерживает IPv4 и IPv6', () => {
    for (const host of ['203.0.113.10', '2001:db8::10']) {
      const secret = createConnectionSecret(
        { kind: 'vless', host, port: 443, credential: 'uuid-value', transport: 'tcp' },
        MASTER_KEY,
      );
      const profile = decodeConnectionSecret(secret, MASTER_KEY);
      expect(profile.host).toBe(host);
    }
  });

  it('собирает рабочий VLESS-URL из профиля', () => {
    const profile = decodeConnectionSecret(
      createConnectionSecret(
        {
          kind: 'vless',
          host: 'vpn.example.com',
          port: 443,
          credential: '11111111-2222-3333-4444-555555555555',
          path: '/ws',
          transport: 'ws',
          security: 'tls',
        },
        MASTER_KEY,
      ),
      MASTER_KEY,
    );
    const value = buildConnectionValue(profile, 'Основной');
    expect(value).toContain('vless://11111111-2222-3333-4444-555555555555@vpn.example.com:443');
    expect(value).toContain('type=ws');
    expect(value).toContain('path=%2Fws');
    expect(value).toContain('sni=vpn.example.com');
    expect(value.endsWith('#%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%BE%D0%B9')).toBe(true);
  });

  it('не принимает секрет другого типа подключения', () => {
    const secret = createConnectionSecret(
      { kind: 'subscription', host: 'sub.example.com', port: 443, path: '/sub' },
      MASTER_KEY,
    );
    expect(() => connectionValueFromSecret(secret, 'vless', 'Тест', MASTER_KEY)).toThrow();
  });

  it('не принимает повреждённый секрет', () => {
    const secret = createConnectionSecret(
      { kind: 'vless', host: 'vpn.example.com', port: 443, credential: 'uuid-value' },
      MASTER_KEY,
    );
    const index = Math.floor(secret.length / 2);
    const broken = `${secret.slice(0, index)}${secret[index] === 'A' ? 'B' : 'A'}${secret.slice(index + 1)}`;
    expect(() => decodeConnectionSecret(broken, MASTER_KEY)).toThrow();
  });

  it('не принимает секрет, созданный другим ключом', () => {
    const secret = createConnectionSecret(
      { kind: 'vless', host: 'vpn.example.com', port: 443, credential: 'uuid-value' },
      MASTER_KEY,
    );
    expect(() => decodeConnectionSecret(secret, 'another-master-key')).toThrow();
  });

  it('маскирует учётные данные в предпросмотре', () => {
    const secret = createConnectionSecret(
      { kind: 'vless', host: 'vpn.example.com', port: 443, credential: 'abcdefgh-1234' },
      MASTER_KEY,
    );
    const preview = connectionSecretPreview(decodeConnectionSecret(secret, MASTER_KEY));
    expect(preview.credential_masked).toBe('••••1234');
    expect(preview.host).toBe('vpn.example.com');
  });
});
