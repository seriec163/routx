import { describe, expect, it } from 'vitest';
import { createBundle, fingerprint, readBundle } from '../src/deploy/bundle.js';

const PASSPHRASE = 'migrate-routx-2026';

function bundle(dump = Buffer.from('PGDMPtest-dump-payload', 'utf8')) {
  return createBundle({
    appVersion: '0.1.0',
    schemaVersion: '16',
    publicUrl: 'https://rc.example.com',
    masterKey: 'master-key-value-with-more-than-32-characters',
    cookieSecure: 'true',
    counts: { users: 2, routers: 1 },
    database: { size_bytes: 1024, server_version: '16.4' },
    dump,
    passphrase: PASSPHRASE,
  });
}

describe('файл переноса', () => {
  it('читается тем же паролем и сохраняет дамп и ключ', () => {
    const dump = Buffer.from('PGDMP-data-to-move', 'utf8');
    const file = bundle(dump);
    const parsed = readBundle(file, PASSPHRASE);

    expect(parsed.manifest.public_url).toBe('https://rc.example.com');
    expect(parsed.manifest.counts).toEqual({ users: 2, routers: 1 });
    expect(parsed.manifest.master_key_fingerprint).toBe(
      fingerprint('master-key-value-with-more-than-32-characters'),
    );
    expect(parsed.secrets.master_key).toBe('master-key-value-with-more-than-32-characters');
    expect(parsed.dump.equals(dump)).toBe(true);
  });

  it('не открывается другим паролем', () => {
    const file = bundle();
    expect(() => readBundle(file, 'another-passphrase-123')).toThrowError(/парольная|повреждён/i);
  });

  it('ловит повреждение зашифрованных данных', () => {
    const file = bundle();
    const broken = Buffer.from(file);
    broken[broken.length - 20] = broken[broken.length - 20]! ^ 0xff;

    expect(() => readBundle(broken, PASSPHRASE)).toThrowError(/парольная|повреждён/i);
  });

  it('отпечаток ключа стабилен', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).toHaveLength(16);
  });
});
