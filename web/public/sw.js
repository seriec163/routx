// RoutX: service worker для установки PWA и Web Push.
// API и запросы агента не кэшируются; навигация — network-first, чтобы
// после обновления панели не залипала старая оболочка.
const CACHE = 'routx-shell-v9';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim())
      .then(async () => {
        // После обновления service worker перезагружаем открытые окна PWA,
        // чтобы они сразу получили новый index.html и новые ассеты.
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
          try {
            await client.navigate(client.url);
          } catch {
            // Safari может запретить navigate — тогда обновится при следующем запуске.
          }
        }
      }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/agent/') ||
    url.pathname.startsWith('/healthz') ||
    url.pathname.startsWith('/readyz')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            return response;
          }),
      ),
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = typeof data.title === 'string' && data.title ? data.title : 'RoutX';
  const body = typeof data.body === 'string' ? data.body : '';
  const url = typeof data.url === 'string' && data.url ? data.url : '/#/app';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'routx';
  const critical = data.severity === 'critical';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // Каждое уведомление должно привлекать внимание: звук и вибрация.
      renotify: true,
      silent: false,
      requireInteraction: critical,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url, tag },
      vibrate: critical ? [240, 120, 240, 120, 240] : [120, 60, 120],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/#/app', self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            if ('navigate' in client) {
              client.navigate(target).catch(() => undefined);
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
      .catch(() => self.clients.openWindow(target)),
  );
});
