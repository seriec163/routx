import { decryptSecret, encryptSecret } from '../lib/crypto.js';

const MARKER = '__rc_sealed';

/**
 * Операции, аргументы которых содержат секреты (Wi-Fi-пароль, ссылки VLESS,
 * URL подписки). Только они шифруются в `agent_commands.args`: для остальных
 * команд лишний scrypt на каждый вызов не нужен.
 */
export const SECRET_COMMAND_OPS = new Set([
  'wifi_create',
  'wifi_update',
  'apply_connections',
  'manage_connection',
]);

type Args = Record<string, unknown>;

export function sealCommandArgs(args: Args | undefined, masterKey: string): Args {
  const value = args ?? {};
  if (Object.keys(value).length === 0) return value;
  return { [MARKER]: encryptSecret(JSON.stringify(value), masterKey) };
}

export function openCommandArgs(
  args: Args | null | undefined,
  masterKey?: string,
): Args {
  if (!args) return {};
  const sealed = args[MARKER];
  if (typeof sealed !== 'string') return args;
  if (!masterKey) return {};
  try {
    const parsed = JSON.parse(decryptSecret(sealed, masterKey)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Args)
      : {};
  } catch {
    // Мастер-ключ сменили или команда повреждена: агент получит пустые args
    // и вернёт понятную ошибку, вместо 500 на poll.
    return {};
  }
}

export function isSealedCommandArgs(args: Args | null | undefined): boolean {
  return Boolean(args && typeof args[MARKER] === 'string');
}
