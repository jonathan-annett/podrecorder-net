// Service worker — offline app shell + runtime caching.
//
// Strategy:
//   • App CODE (navigations, client.js, /transcribe) is NETWORK-FIRST — a new
//     deploy is picked up on the next plain reload, with NO cache-clearing (so
//     sessionStorage, e.g. the reconnect nonce, is preserved). Falls back to cache
//     when offline.
//   • Immutable assets (fonts, vendored simple-peer, icons, manifest) are
//     cache-first (stale-while-revalidate).
//   • /api/* and the /ws signaling upgrade always hit the network (never cached).
//   • Cross-origin (transformers.js CDN, HuggingFace) pass through untouched.
//
// Bump CACHE whenever the precached shell changes (also forces clients to update).
const CACHE = 'podcast-studio-v2';
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

// Network-first: fresh from the network (cache the copy), fall back to cache offline.
function networkFirst(request) {
  return fetch(request)
    .then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    })
    .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html')));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;                        // cross-origin: pass through
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return; // never cache

  // App code must be fresh on reload → network-first (offline → cache fallback).
  if (
    request.mode === 'navigate' ||
    url.pathname === '/client.js' ||
    url.pathname === '/transcribe' ||
    url.pathname === '/transcribe.html'
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Immutable assets: cache-first / stale-while-revalidate.
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
