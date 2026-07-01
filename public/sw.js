// Service worker — offline app shell + runtime caching.
//
// Strategy:
//   • Core shell (studio page + client + vendored simple-peer + fonts) is
//     precached so the app loads offline.
//   • Same-origin GETs are cache-first (static assets rarely change per deploy).
//   • Navigations are network-first, falling back to the cached shell offline.
//   • /api/* and the /ws signaling upgrade always go to the network (never cached).
//   • Cross-origin requests (transformers.js CDN, HuggingFace weights) pass through.
//
// Bump CACHE on each deploy that changes a precached asset.
const CACHE = 'podcast-studio-v1';
const CORE = [
  '/',
  '/index.html',
  '/client.js',
  '/vendor/simplepeer.min.js',
  '/fonts/fonts.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle our own origin; let the browser fetch cross-origin (CDN/HF) directly.
  if (url.origin !== self.location.origin) return;

  // Never cache signaling or API traffic.
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;

  // Navigations: network-first so a new deploy is picked up, offline → cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Static assets: stale-while-revalidate — serve cache instantly for offline/speed,
  // but always refetch in the background so an updated deploy propagates next load
  // (avoids a stale client.js getting stuck).
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
