import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const KEY_SALT = 'router-control:master-key:v1';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Ключ шифрования секретов. В production RC_MASTER_KEY обязателен (см. config.ts). */
export function deriveMasterKey(masterKey: string): Buffer {
  return scryptSync(masterKey.normalize('NFKC'), KEY_SALT, 32);
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256Hex(data: string | Buffer): string {
  return sha256(data).toString('hex');
}

export function hmacSha256Hex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Opaque-токен: 32 байта CSPRNG → 43 символа base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 20 байт CSPRNG → ровно 32 символа base32 (без padding). */
export function randomBase32(bytes = 20): string {
  const buffer = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function hashToken(token: string): Buffer {
  return sha256(token);
}

export function equalBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function equalStrings(a: string, b: string): boolean {
  return equalBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** AES-256-GCM. Формат: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plaintext: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveMasterKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, masterKey: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = payload.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error('Неподдерживаемый формат зашифрованного секрета');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveMasterKey(masterKey),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Канонический JSON: стабильная сортировка ключей объекта.
 * Массивы сохраняют порядок (для UCI-списков порядок значим).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Грубая маскировка секретов в произвольных строках/логах. */
export function maskSecrets(input: string): string {
  return input
    .replace(/(vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\/[^\s"'<>]+/gi, '$1://***')
    .replace(/\b[a-f0-9]{32,}\b/gi, '***')
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=***');
}
