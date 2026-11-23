import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of normalized) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Некорректный base32-секрет');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_PERIOD);
}

export interface TotpVerifyResult {
  ok: boolean;
  step?: number;
}

/**
 * Проверка TOTP с окном ±1 шаг. Возвращает использованный шаг, чтобы
 * вызывающий код мог отклонить повторное использование (replay).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { step?: number; window?: number } = {},
): TotpVerifyResult {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return { ok: false };

  const secret = base32Decode(secretBase32);
  const current = options.step ?? totpStep();
  const window = options.window ?? 1;
  const provided = Buffer.from(normalized, 'utf8');

  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { ok: true, step };
    }
  }
  return { ok: false };
}

export function provisioningUri(options: {
  secret: string;
  email: string;
  issuer?: string;
}): string {
  const issuer = options.issuer ?? 'RoutX';
  const label = encodeURIComponent(`${issuer}:${options.email}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
