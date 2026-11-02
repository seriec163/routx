import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { badRequest } from '../lib/errors.js';

const MAGIC = 'RCDEPLOY1\n';
const KDF = { name: 'scrypt' as const, N: 1 << 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

export interface DeployManifest {
  format: 1;
  created_at: string;
  app_version: string;
  schema_version: string | null;
  public_url: string;
  master_key_fingerprint: string;
  counts: Record<string, number>;
  database: { size_bytes: number; server_version: string };
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  payload_size: number;
  payload_sha256: string;
}

export interface DeploySecrets {
  master_key: string;
  public_url: string;
  cookie_secure?: string;
}

export interface BundleInput {
  appVersion: string;
  schemaVersion: string | null;
  publicUrl: string;
  masterKey: string;
  cookieSecure?: string;
  counts: Record<string, number>;
  database: { size_bytes: number; server_version: string };
  dump: Buffer;
  passphrase: string;
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Формат файла переноса:
 *   "RCDEPLOY1\n" | 4 байта длины заголовка | JSON-заголовок | salt | iv | ciphertext+tag
 * Заголовок открыт (его показываем до импорта), данные и мастер-ключ зашифрованы
 * парольной фразой администратора.
 */
export function createBundle(input: BundleInput): Buffer {
  const secrets: DeploySecrets = {
    master_key: input.masterKey,
    public_url: input.publicUrl,
    cookie_secure: input.cookieSecure,
  };
  const secretsJson = Buffer.from(JSON.stringify(secrets), 'utf8');
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(secretsJson.length, 0);
  const plain = Buffer.concat([frame, secretsJson, input.dump]);
  const payload = gzipSync(plain, { level: 6 });

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(input.passphrase, salt, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  const manifest: DeployManifest = {
    format: 1,
    created_at: new Date().toISOString(),
    app_version: input.appVersion,
    schema_version: input.schemaVersion,
    public_url: input.publicUrl,
    master_key_fingerprint: fingerprint(input.masterKey),
    counts: input.counts,
    database: input.database,
    kdf: { ...KDF, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    payload_size: payload.length,
    payload_sha256: createHash('sha256').update(payload).digest('hex'),
  };

  const header = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length, 0);

  return Buffer.concat([Buffer.from(MAGIC, 'ascii'), length, header, encrypted, tag]);
}

export function readBundle(
  buffer: Buffer,
  passphrase: string,
): { manifest: DeployManifest; secrets: DeploySecrets; dump: Buffer } {
  if (buffer.length < MAGIC.length + 4 + 16) {
    throw badRequest('bundle_invalid', 'Файл переноса повреждён или это не файл RoutX');
  }
  if (buffer.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) {
    throw badRequest('bundle_invalid', 'Неизвестный формат файла переноса');
  }

  let offset = MAGIC.length;
  const headerLength = buffer.readUInt32BE(offset);
  offset += 4;
  if (headerLength <= 0 || headerLength > 64 * 1024 || offset + headerLength + 28 > buffer.length) {
    throw badRequest('bundle_invalid', 'Заголовок файла переноса повреждён');
  }

  let manifest: DeployManifest;
  try {
    manifest = JSON.parse(buffer.subarray(offset, offset + headerLength).toString('utf8'));
  } catch {
    throw badRequest('bundle_invalid', 'Заголовок файла переноса не читается');
  }
  offset += headerLength;

  if (manifest.format !== 1) {
    throw badRequest('bundle_version', 'Файл переноса создан другой версией RoutX');
  }
  if (manifest.cipher !== 'aes-256-gcm' || manifest.kdf?.name !== 'scrypt') {
    throw badRequest('bundle_invalid', 'Неподдерживаемый способ шифрования файла переноса');
  }

  const salt = Buffer.from(manifest.kdf.salt, 'base64');
  const iv = Buffer.from(manifest.iv, 'base64');
  const tag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(offset, buffer.length - 16);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length === 0) {
    throw badRequest('bundle_invalid', 'Файл переноса повреждён');
  }

  let payload: Buffer;
  try {
    const key = deriveKey(passphrase, salt, manifest.kdf);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw badRequest('bundle_passphrase', 'Неверная парольная фраза или файл повреждён');
  }

  if (
    typeof manifest.payload_sha256 === 'string' &&
    createHash('sha256').update(payload).digest('hex') !== manifest.payload_sha256
  ) {
    throw badRequest('bundle_invalid', 'Контрольная сумма файла переноса не совпадает');
  }

  let plain: Buffer;
  try {
    plain = gunzipSync(payload);
  } catch {
    throw badRequest('bundle_invalid', 'Данные переноса повреждены');
  }

  if (plain.length < 4) throw badRequest('bundle_invalid', 'Данные переноса пусты');
  const secretsLength = plain.readUInt32BE(0);
  if (secretsLength <= 0 || secretsLength > 64 * 1024 || 4 + secretsLength > plain.length) {
    throw badRequest('bundle_invalid', 'Служебный блок файла переноса повреждён');
  }

  let secrets: DeploySecrets;
  try {
    secrets = JSON.parse(plain.subarray(4, 4 + secretsLength).toString('utf8'));
  } catch {
    throw badRequest('bundle_invalid', 'Служебный блок файла переноса не читается');
  }

  const dump = plain.subarray(4 + secretsLength);
  if (dump.length === 0) throw badRequest('bundle_invalid', 'В файле нет дампа базы данных');
  if (dump.subarray(0, 5).toString('latin1') !== 'PGDMP') {
    throw badRequest('bundle_invalid', 'Дамп базы данных повреждён');
  }

  return { manifest, secrets, dump };
}
