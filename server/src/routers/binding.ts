import type { Pool } from 'pg';
import { randomBase32, randomToken, sha256Hex } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';

export const BINDING_TOKEN_TTL_SECONDS = 300;
export const CREDENTIAL_OVERLAP_SECONDS = 600;

export interface BindingTokenResult {
  token: string;
  expires_at: Date;
}

export async function createBindingToken(
  pool: Pool,
  input: {
    routerId: string;
    createdBy: string;
    productHint?: 'any' | 'forkop' | 'prokop' | 'podkop' | 'tachyon';
    ttlSeconds?: number;
  },
): Promise<BindingTokenResult> {
  const token = randomBase32(20); // ровно 32 символа
  const ttl = input.ttlSeconds ?? BINDING_TOKEN_TTL_SECONDS;
  const result = await pool.query<{ expires_at: Date }>(
    `insert into binding_tokens (id, token_hash, created_by, router_id, product_hint, expires_at)
     values ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
     returning expires_at`,
    [
      uuidv7(),
      sha256Hex(token),
      input.createdBy,
      input.routerId,
      input.productHint ?? 'any',
      ttl,
    ],
  );
  return { token, expires_at: result.rows[0]!.expires_at };
}

export interface RotatedCredential {
  token: string;
  prefix: string;
}

export async function rotateRouterCredential(
  pool: Pool,
  routerId: string,
): Promise<RotatedCredential> {
  const token = randomToken(32);
  const prefix = token.slice(0, 8);

  await pool.query(
    `insert into router_credentials
       (router_id, token_hash, token_prefix, rotated_at, previous_token_hash, previous_expires_at)
     values ($1,$2,$3, now(), null, null)
     on conflict (router_id) do update
       set previous_token_hash = router_credentials.token_hash,
           previous_expires_at = now() + ($4 || ' seconds')::interval,
           token_hash = excluded.token_hash,
           token_prefix = excluded.token_prefix,
           rotated_at = now(),
           revoked_at = null`,
    [routerId, sha256Hex(token), prefix, CREDENTIAL_OVERLAP_SECONDS],
  );

  return { token, prefix };
}
