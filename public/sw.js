// CACHE_VERSION: bump to force a full cache refresh (all precached files refetched).
// APP_JS_VERSION: must always exactly match the ?v= query in index.html's <script src>.
const CACHE_VERSION = 'v17';
const APP_JS_VERSION = '15';
const CACHE_NAME = 'voice-billing-' + CACHE_VERSION;
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js?v=' + APP_JS_VERSION,
  '/manifest.json',
  '/icon.svg?v=2'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch :8081 relay or cross-origin calls
  if (url.pathname === '/inference') return; // always hit whisper-server live

  const isPrecached = PRECACHE.some(p => url.pathname + url.search === p || (p === '/' && url.pathname === '/'));
  if (!isPrecached) return;

  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
