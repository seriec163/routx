const DEVICE_KEY = 'rc.mobile.device_id';

function randomId(): string {
  const cryptoApi = window.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Идентификатор этой установки приложения. Хранится в localStorage и
 * переживает обновления PWA; удаляется вместе с данными приложения.
 * Сервер по нему переиспользует строку mobile_devices при повторном QR.
 */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (
      existing &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)
    ) {
      return existing;
    }
    const id = randomId();
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return '';
  }
}

export const MOBILE_BOUND_KEY = 'rc.mobile.bound';

export function markMobileBound(): void {
  try {
    window.localStorage.setItem(MOBILE_BOUND_KEY, '1');
  } catch {
    // Приватный режим может запрещать localStorage — не критично.
  }
}

export function clearMobileBound(): void {
  try {
    window.localStorage.removeItem(MOBILE_BOUND_KEY);
  } catch {
    // Игнорируем.
  }
}

export function isMobileBound(): boolean {
  try {
    return window.localStorage.getItem(MOBILE_BOUND_KEY) === '1';
  } catch {
    return false;
  }
}

export function isStandalonePwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isMobileClient(): boolean {
  return isStandalonePwa() || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
