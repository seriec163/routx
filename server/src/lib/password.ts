import { Algorithm, hash, verify } from '@node-rs/argon2';

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB, рекомендация OWASP для Argon2id
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password, { algorithm: Algorithm.Argon2id });
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  message?: string;
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 12) {
    return { ok: false, message: 'Пароль должен содержать не менее 12 символов' };
  }
  if (password.length > 256) {
    return { ok: false, message: 'Пароль слишком длинный (максимум 256 символов)' };
  }
  if (/^\s|\s$/.test(password)) {
    return { ok: false, message: 'Пароль не должен начинаться или заканчиваться пробелом' };
  }
  const classes = [/[a-zа-я]/i, /[A-ZА-Я]/, /\d/, /[^\p{L}\d]/u].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 3) {
    return {
      ok: false,
      message: 'Пароль должен содержать минимум 3 класса символов (строчные, заглавные, цифры, спецсимволы)',
    };
  }
  return { ok: true };
}
