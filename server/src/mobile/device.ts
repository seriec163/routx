/**
 * Человекочитаемое имя устройства по User-Agent.
 * Нужно, чтобы владелец роутера в списке авторизованных телефонов видел
 * «iPhone · Safari», а не строку браузера целиком.
 */
export interface DeviceLabel {
  name: string;
  platform: string | null;
}

export function deviceLabel(userAgent: string | null | undefined): DeviceLabel {
  const ua = userAgent ?? '';

  const platform = /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : null;

  const model = /iPhone/i.test(ua)
    ? 'iPhone'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /Android/i.test(ua)
        ? 'Android'
        : platform ?? 'Устройство';

  const browser = /EdgA?|Edg\//i.test(ua)
    ? 'Edge'
    : /OPR|Opera/i.test(ua)
      ? 'Opera'
      : /Firefox|FxiOS/i.test(ua)
        ? 'Firefox'
        : /CriOS|Chrome/i.test(ua)
          ? 'Chrome'
          : /Safari/i.test(ua)
            ? 'Safari'
            : null;

  return {
    name: browser ? `${model} · ${browser}` : model,
    platform,
  };
}
