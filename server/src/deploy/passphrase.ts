import { badRequest } from '../lib/errors.js';

/**
 * Парольная фраза файла переноса передаётся в заголовке `x-rc-passphrase`
 * в base64: так она переживает любые символы и не ломает HTTP-заголовки.
 * Открытый текст отклоняется с отдельным кодом, чтобы не путать его с
 * «неверной фразой или повреждённым файлом».
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodePassphraseHeader(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw badRequest('passphrase_required', 'Укажите парольную фразу для файла переноса');

  const encoded = value.trim();
  if (encoded.length === 0 || encoded.length > 400 || !BASE64_RE.test(encoded)) {
    throw badRequest(
      'passphrase_encoding',
      'Передайте парольную фразу в base64 в заголовке x-rc-passphrase',
    );
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  if (decoded.includes('\uFFFD')) {
    throw badRequest(
      'passphrase_encoding',
      'Парольная фраза в x-rc-passphrase повреждена: ожидается base64 от UTF-8',
    );
  }

  const passphrase = decoded.trim();
  if (passphrase.length < 12 || passphrase.length > 200) {
    throw badRequest('passphrase_weak', 'Парольная фраза должна быть от 12 до 200 символов');
  }
  return passphrase;
}
