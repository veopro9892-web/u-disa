// Offline shell. Caches only the app itself - never /api, so one owner's books
// can never be served to the next person who opens the app.
const VERSION = 'udisa-v3';
const SHELL = [
  '/',
  '/index.html',
  '/css/brand.css',
  '/css/app.css',
  '/js/app.js',
  '/js/ui.js',
  '/js/api.js','/js/day.js',
  '/js/i18n.js',
  '/js/old-browser.js',
  '/manifest.webmanifest',
  '/brand.json',
  '/img/mark.svg',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
];

// Code must never be served stale: a cached app.js from an older build is the
// single most common way this kind of app "randomly stops opening".
const ALWAYS_NETWORK_FIRST = /\.(js|css|html|json|webmanifest)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch((err) => console.warn('precache incomplete', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('udisa-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const put = (req, res) => {
  if (!res || !res.ok) return Promise.resolve();
  return caches.open(VERSION).then((c) => c.put(req, res.clone())).catch(() => {});
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/bootstrap') return; // account data is never cached

  const isNav = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');
  if (url.pathname === '/api/bootstrap' || isNav || ALWAYS_NETWORK_FIRST.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          void put(req, res);
          if (isNav) void put(new Request('/'), res);
          return res;
        })
        .catch(() => caches.match(req).then((r) => r ?? (isNav ? caches.match('/') : null)).then((r) => r ?? Response.error()))
    );
    return;
  }

  // icons and images rarely change and are safe to serve from cache first
  event.respondWith(
    caches.match(req).then(async (hit) => {
      const fresh = fetch(req).then((res) => {
        void put(req, res);
        return res;
      }).catch(() => hit);
      return hit ?? fresh;
    })
  );
});
