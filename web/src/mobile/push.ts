import { api } from '../lib/api';

export interface PushConfig {
  enabled: boolean;
  public_key: string | null;
  subscriptions: number;
}

export interface PushStatus extends PushConfig {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

const SW_URL = '/sw.js';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** base64url из VAPID-ключа → ArrayBuffer для PushManager.subscribe. */
function urlBase64ToBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output.buffer as ArrayBuffer;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register(SW_URL);
  return navigator.serviceWorker.ready;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) {
    return {
      enabled: false,
      public_key: null,
      subscriptions: 0,
      supported: false,
      permission: 'unsupported',
      subscribed: false,
    };
  }

  const config = await api<PushConfig>('/api/v1/push/config');
  let subscribed = false;
  try {
    const sw = await navigator.serviceWorker.getRegistration('/');
    const subscription = sw ? await sw.pushManager.getSubscription() : null;
    subscribed = Boolean(subscription);
  } catch {
    subscribed = false;
  }

  return {
    ...config,
    supported: true,
    permission: Notification.permission,
    subscribed,
  };
}

/**
 * Включает push. Должно вызываться из жеста пользователя: iOS и Chrome
 * показывают запрос разрешения только в ответ на нажатие.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) {
    throw new Error('Этот браузер не поддерживает push-уведомления');
  }
  const config = await api<PushConfig>('/api/v1/push/config');
  if (!config.enabled || !config.public_key) {
    throw new Error('Push-уведомления на сервере не настроены');
  }

  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      'Разрешение не выдано. Откройте настройки сайта в браузере и разрешите уведомления.',
    );
  }

  const sw = await registration();
  let subscription = await sw.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await sw.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(config.public_key),
      });
    } catch {
      throw new Error(
        'Браузер не смог подписаться на push. На iPhone установите приложение на экран «Домой» и попробуйте снова.',
      );
    }
  }

  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) {
    throw new Error('Браузер вернул неполную push-подписку');
  }

  await api('/api/v1/push/subscribe', {
    method: 'POST',
    body: {
      endpoint: subscription.endpoint,
      keys: { p256dh, auth },
    },
  });
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const sw = await navigator.serviceWorker.getRegistration('/');
  const subscription = sw ? await sw.pushManager.getSubscription() : null;
  if (!subscription) return;

  await api('/api/v1/push/unsubscribe', {
    method: 'POST',
    body: { endpoint: subscription.endpoint },
  }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

export async function sendTestPush(): Promise<void> {
  await api('/api/v1/push/test', { method: 'POST' });
}
