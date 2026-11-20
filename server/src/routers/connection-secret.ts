import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { badRequest } from '../lib/errors.js';
import { deriveMasterKey } from '../lib/crypto.js';

export type ConnectionKind = 'subscription' | 'vless';
export type VlessTransport = 'tcp' | 'ws' | 'grpc' | 'http';
export type VlessSecurity = 'none' | 'tls';

export interface ConnectionProfile {
  kind: ConnectionKind;
  host: string;
  port: number;
  credential: string;
  path: string;
  sni: string;
  flow: string;
  transport: VlessTransport;
  security: VlessSecurity;
}

export interface ConnectionProfileInput {
  kind: ConnectionKind;
  host: string;
  port?: number | string;
  credential?: string;
  path?: string;
  sni?: string;
  flow?: string;
  transport?: VlessTransport;
  security?: VlessSecurity;
}

const SECRET_PREFIX = 'rc1.';
const SECRET_AAD = Buffer.from('rc1');
const KEY_SALT = Buffer.from('router-control');
const KEY_INFO = Buffer.from('connection-secret:v1');

const VERSION = 1;
const KIND_CODES: Record<ConnectionKind, number> = { subscription: 0, vless: 1 };
const TRANSPORT_CODES: Record<VlessTransport, number> = { tcp: 0, ws: 1, grpc: 2, http: 3 };
const SECURITY_CODES: Record<VlessSecurity, number> = { none: 0, tls: 1 };

const FLAG_PATH = 1;
const FLAG_SNI = 2;
const FLAG_FLOW = 4;
const FLAG_TRANSPORT = 8;
const FLAG_SECURITY = 16;

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function secretKey(masterKey: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', deriveMasterKey(masterKey), KEY_SALT, KEY_INFO, 32),
  );
}

function normalizeHost(raw: string): string {
  const value = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  if (!value) throw badRequest('invalid_host', 'Укажите домен или IP');
  if (isIP(value)) return value;
  if (!DOMAIN_RE.test(value)) {
    throw badRequest('invalid_host', 'Некорректный домен или IP-адрес');
  }
  return value.toLowerCase();
}

function normalizePort(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw ?? 443);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw badRequest('invalid_port', 'Порт должен быть целым числом от 1 до 65535');
  }
  return value;
}

function normalizeText(raw: unknown, max: number, label: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > max) {
    throw badRequest('invalid_secret_field', `${label}: не более ${max} символов`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw badRequest('invalid_secret_field', `${label}: недопустимые символы`);
  }
  return value;
}

function normalizeKind(raw: unknown): ConnectionKind {
  if (raw === 'subscription' || raw === 'vless') return raw;
  throw badRequest('invalid_kind', 'Тип подключения должен быть subscription или vless');
}

function normalizeTransport(raw: unknown): VlessTransport {
  if (raw == null || raw === '') return 'ws';
  if (raw === 'tcp' || raw === 'ws' || raw === 'grpc' || raw === 'http') return raw;
  throw badRequest('invalid_transport', 'Транспорт: tcp, ws, grpc или http');
}

function normalizeSecurity(raw: unknown): VlessSecurity {
  if (raw == null || raw === '') return 'tls';
  if (raw === 'none' || raw === 'tls') return raw;
  throw badRequest('invalid_security', 'Безопасность: tls или none');
}

export function normalizeConnectionProfile(input: ConnectionProfileInput): ConnectionProfile {
  const kind = normalizeKind(input.kind);
  const host = normalizeHost(input.host);
  const port = normalizePort(input.port);
  const credential = normalizeText(input.credential, 512, 'Учётные данные');
  const path = normalizeText(input.path, 1024, 'Путь');
  const sni = normalizeText(input.sni, 253, 'SNI');
  const flow = normalizeText(input.flow, 64, 'Flow');
  const transport = normalizeTransport(input.transport);
  const security = normalizeSecurity(input.security);

  if (kind === 'vless' && !credential) {
    throw badRequest('credential_required', 'Для VLESS укажите UUID или пароль');
  }

  return { kind, host, port, credential, path, sni, flow, transport, security };
}

function writeString1(parts: Buffer[], value: string, label: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 255) {
    throw badRequest('invalid_secret_field', `${label}: слишком длинное значение`);
  }
  parts.push(Buffer.from([bytes.length]), bytes);
}

function writeString2(parts: Buffer[], value: string, label: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 65535) {
    throw badRequest('invalid_secret_field', `${label}: слишком длинное значение`);
  }
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  parts.push(length, bytes);
}

function packProfile(profile: ConnectionProfile): Buffer {
  const flags =
    (profile.path && profile.path !== '/' ? FLAG_PATH : 0) |
    (profile.kind === 'vless' && profile.sni && profile.sni !== profile.host ? FLAG_SNI : 0) |
    (profile.kind === 'vless' && profile.flow ? FLAG_FLOW : 0) |
    (profile.kind === 'vless' && profile.transport !== 'ws' ? FLAG_TRANSPORT : 0) |
    (profile.kind === 'vless' && profile.security !== 'tls' ? FLAG_SECURITY : 0);

  const parts: Buffer[] = [
    Buffer.from([VERSION, KIND_CODES[profile.kind], flags]),
  ];
  const port = Buffer.alloc(2);
  port.writeUInt16BE(profile.port);
  parts.push(port);
  writeString1(parts, profile.host, 'Домен');
  writeString2(parts, profile.credential, 'Учётные данные');
  if (flags & FLAG_PATH) writeString2(parts, profile.path, 'Путь');
  if (flags & FLAG_SNI) writeString1(parts, profile.sni, 'SNI');
  if (flags & FLAG_FLOW) writeString1(parts, profile.flow, 'Flow');
  if (flags & FLAG_TRANSPORT) parts.push(Buffer.from([TRANSPORT_CODES[profile.transport]]));
  if (flags & FLAG_SECURITY) parts.push(Buffer.from([SECURITY_CODES[profile.security]]));
  return Buffer.concat(parts);
}

function readString1(buffer: Buffer, offset: number, label: string): [string, number] {
  if (offset >= buffer.length) throw badRequest('invalid_connection_secret', `Секрет повреждён: ${label}`);
  const length = buffer[offset]!;
  const end = offset + 1 + length;
  if (end > buffer.length) throw badRequest('invalid_connection_secret', `Секрет повреждён: ${label}`);
  return [buffer.subarray(offset + 1, end).toString('utf8'), end];
}

function readString2(buffer: Buffer, offset: number, label: string): [string, number] {
  if (offset + 2 > buffer.length) throw badRequest('invalid_connection_secret', `Секрет повреждён: ${label}`);
  const length = buffer.readUInt16BE(offset);
  const end = offset + 2 + length;
  if (end > buffer.length) throw badRequest('invalid_connection_secret', `Секрет повреждён: ${label}`);
  return [buffer.subarray(offset + 2, end).toString('utf8'), end];
}

function unpackProfile(payload: Buffer): ConnectionProfile {
  if (payload.length < 5) throw badRequest('invalid_connection_secret', 'Секрет слишком короткий');
  if (payload[0] !== VERSION) {
    throw badRequest('unsupported_connection_secret', 'Неподдерживаемая версия секрета');
  }
  const kind = payload[1] === KIND_CODES.subscription ? 'subscription' : payload[1] === KIND_CODES.vless ? 'vless' : null;
  if (!kind) throw badRequest('invalid_connection_secret', 'Секрет повреждён: тип подключения');
  const flags = payload[2]!;
  const port = payload.readUInt16BE(3);

  let offset = 5;
  let host: string;
  let credential: string;
  [host, offset] = readString1(payload, offset, 'домен');
  [credential, offset] = readString2(payload, offset, 'учётные данные');

  let path = '';
  let sni = '';
  let flow = '';
  let transport: VlessTransport = 'ws';
  let security: VlessSecurity = 'tls';

  if (flags & FLAG_PATH) [path, offset] = readString2(payload, offset, 'путь');
  if (flags & FLAG_SNI) [sni, offset] = readString1(payload, offset, 'SNI');
  if (flags & FLAG_FLOW) [flow, offset] = readString1(payload, offset, 'Flow');
  if (flags & FLAG_TRANSPORT) {
    if (offset >= payload.length) throw badRequest('invalid_connection_secret', 'Секрет повреждён: транспорт');
    transport = (Object.entries(TRANSPORT_CODES).find(([, code]) => code === payload[offset])?.[0] as VlessTransport | undefined) ?? 'ws';
    offset += 1;
  }
  if (flags & FLAG_SECURITY) {
    if (offset >= payload.length) throw badRequest('invalid_connection_secret', 'Секрет повреждён: безопасность');
    security = (Object.entries(SECURITY_CODES).find(([, code]) => code === payload[offset])?.[0] as VlessSecurity | undefined) ?? 'tls';
    offset += 1;
  }
  if (offset !== payload.length) {
    throw badRequest('invalid_connection_secret', 'Секрет повреждён: лишние данные');
  }

  return normalizeConnectionProfile({
    kind,
    host,
    port,
    credential,
    path,
    sni,
    flow,
    transport,
    security,
  });
}

export function createConnectionSecret(input: ConnectionProfileInput, masterKey: string): string {
  const profile = normalizeConnectionProfile(input);
  const payload = packProfile(profile);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(masterKey), nonce);
  cipher.setAAD(SECRET_AAD);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${Buffer.concat([nonce, tag, ciphertext]).toString('base64url')}`;
}

export function decodeConnectionSecret(secret: string, masterKey: string): ConnectionProfile {
  const value = String(secret ?? '').trim();
  if (!value.startsWith(SECRET_PREFIX)) {
    throw badRequest('invalid_connection_secret', 'Секрет должен начинаться с rc1.');
  }
  const body = value.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw badRequest('invalid_connection_secret', 'Секрет содержит недопустимые символы');
  }
  const raw = Buffer.from(body, 'base64url');
  if (raw.length < 12 + 16 + 5) {
    throw badRequest('invalid_connection_secret', 'Секрет слишком короткий');
  }
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(masterKey), nonce);
    decipher.setAAD(SECRET_AAD);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return unpackProfile(payload);
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    throw badRequest('invalid_connection_secret', 'Секрет повреждён или создан другим ключом');
  }
}

export function connectionValueFromSecret(
  secret: string,
  kind: ConnectionKind,
  label: string,
  masterKey: string,
): string {
  const profile = decodeConnectionSecret(secret, masterKey);
  if (profile.kind !== kind) {
    throw badRequest(
      'connection_kind_mismatch',
      'Тип в компактном секрете не совпадает с выбранным типом',
    );
  }
  return buildConnectionValue(profile, label);
}

function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function buildConnectionValue(profile: ConnectionProfile, label?: string): string {
  if (profile.kind === 'subscription') {
    const scheme = profile.port === 80 ? 'http' : 'https';
    const rawPath = profile.path || '/';
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    let value = `${scheme}://${formatHost(profile.host)}:${profile.port}${path}`;
    if (profile.credential) {
      value += `${value.includes('?') ? '&' : '?'}token=${encodeURIComponent(profile.credential)}`;
    }
    return value;
  }

  const params = new URLSearchParams();
  params.set('encryption', 'none');
  params.set('security', profile.security);
  const sni = profile.sni || (isIP(profile.host) ? '' : profile.host);
  if (sni) params.set('sni', sni);
  params.set('type', profile.transport);
  if (profile.path) {
    if (profile.transport === 'grpc') params.set('serviceName', profile.path);
    else params.set('path', profile.path);
  }
  if (profile.flow) params.set('flow', profile.flow);
  const suffix = label ? `#${encodeURIComponent(label)}` : '';
  return `vless://${encodeURIComponent(profile.credential)}@${formatHost(profile.host)}:${profile.port}?${params.toString()}${suffix}`;
}

function maskCredential(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

export function connectionSecretPreview(profile: ConnectionProfile) {
  return {
    kind: profile.kind,
    host: profile.host,
    port: profile.port,
    path: profile.path || null,
    sni:
      profile.kind === 'vless'
        ? profile.sni || (isIP(profile.host) ? null : profile.host)
        : null,
    transport: profile.kind === 'vless' ? profile.transport : null,
    security: profile.kind === 'vless' ? profile.security : null,
    flow: profile.flow || null,
    credential_masked: maskCredential(profile.credential),
  };
}
