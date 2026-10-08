const CACHE = 'kookboek-v4';
const SHELL = ['./', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network-first for the page so updates arrive straight away; the cached copy
// keeps the app working offline. Recipe data lives in IndexedDB, not here.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(req, { cache: 'no-cache' })).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put('./', copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match('./'))
    );
    return;
  }
  if (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com')) {
    e.respondWith(caches.match(req).then(cached => cached || fetch(req).then(resp => {
      if (resp.ok && url.origin !== location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return resp;
    })));
  }
});
