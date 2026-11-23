import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors.js';
import { decodePassphraseHeader } from '../src/deploy/passphrase.js';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.code : 'unexpected';
  }
}

describe('парольная фраза файла переноса', () => {
  it('декодирует base64 и обрезает пробелы', () => {
    const encoded = Buffer.from('  migration-test-pass-2026  ', 'utf8').toString('base64');

    expect(decodePassphraseHeader(encoded)).toBe('migration-test-pass-2026');
  });

  it('объясняет, что нужен base64, а не открытый текст', () => {
    expect(codeOf(() => decodePassphraseHeader('migration-test-pass-2026'))).toBe(
      'passphrase_encoding',
    );
  });

  it('отклоняет повреждённый UTF-8', () => {
    const broken = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6, 0xf5, 0xf4])
      .toString('base64');

    expect(codeOf(() => decodePassphraseHeader(broken))).toBe('passphrase_encoding');
  });

  it('сохраняет требования к длине', () => {
    expect(codeOf(() => decodePassphraseHeader(Buffer.from('short').toString('base64')))).toBe(
      'passphrase_weak',
    );
  });

  it('требует заголовок', () => {
    expect(codeOf(() => decodePassphraseHeader(undefined))).toBe('passphrase_required');
  });
});
