import type { Pool } from 'pg';
import QRCode from 'qrcode';
import { randomToken, sha256 } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';

export const MOBILE_TOKEN_TTL_SECONDS = 5 * 60;

export interface MobileLink {
  url: string;
  qr_data_url: string;
  expires_at: string;
  ttl_seconds: number;
  https: boolean;
}

/**
 * Одноразовая ссылка на мобильный вход для конкретного роутера.
 * Создаётся агентом с самого роутера: QR показывается в LuCI → Службы → RoutX,
 * чтобы его видел только тот, кто уже находится рядом с устройством.
 * Предыдущие неиспользованные ссылки этого роутера отзываются.
 */
export async function createMobileLink(
  pool: Pool,
  input: { userId: string; routerId: string; baseUrl: string },
): Promise<MobileLink> {
  const base = input.baseUrl.replace(/\/+$/, '');
  const token = randomToken(32);
  const id = uuidv7();
  const expiresAt = new Date(Date.now() + MOBILE_TOKEN_TTL_SECONDS * 1000);

  await pool.query(
    `insert into mobile_tokens (id, token_hash, user_id, router_id, expires_at)
     values ($1,$2,$3,$4,$5)`,
    [id, sha256(token), input.userId, input.routerId, expiresAt],
  );

  const url = `${base}/#/install?token=${encodeURIComponent(token)}&router=${encodeURIComponent(input.routerId)}`;
  const qr = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 380,
    color: { dark: '#07111f', light: '#ffffff' },
  });

  return {
    url,
    qr_data_url: qr,
    expires_at: expiresAt.toISOString(),
    ttl_seconds: MOBILE_TOKEN_TTL_SECONDS,
    https: base.startsWith('https://'),
  };
}
