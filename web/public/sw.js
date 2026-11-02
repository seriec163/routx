// RoutX: РјРёРЅРёРјР°Р»СЊРЅС‹Р№ service worker РґР»СЏ СѓСЃС‚Р°РЅРѕРІРєРё PWA.
// API Рё Р°РіРµРЅС‚СЃРєРёРµ Р·Р°РїСЂРѕСЃС‹ РЅРµ РєСЌС€РёСЂСѓСЋС‚СЃСЏ; РЅР°РІРёРіР°С†РёСЏ вЂ” network-first,
// С‡С‚РѕР±С‹ РїРѕСЃР»Рµ РѕР±РЅРѕРІР»РµРЅРёСЏ РїР°РЅРµР»Рё РЅРµ Р·Р°Р»РёРїР°Р»Р° СЃС‚Р°СЂР°СЏ РѕР±РѕР»РѕС‡РєР°.
const CACHE = 'routx-shell-v2';
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
      .then(() => self.clients.claim()),
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
