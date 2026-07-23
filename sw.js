// ── نسخه رو هر بار که هر کدوم از فایل‌های js/*.js یا index.html تغییر می‌کنه، یه عدد بالاتر بذار ──
const CACHE_NAME = 'loan-crm-cache-v38';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/jalali.js',
  './js/formula-engine.js',
  './js/db.js',
  './js/firebase-config.js',
  './js/firebase-sync.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];
// External Firebase SDK files: cached opportunistically (best-effort) so the app can
// still boot offline after the first successful online load. If any single one fails
// to fetch during install (e.g. very first install while offline), that's fine - the
// rest of the app must still install and work; Firebase sync simply activates once
// the SDK becomes reachable and the fetch handler below fills the cache in the background.
const EXTERNAL_ASSETS = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js'
];

// Paths that hold app LOGIC (not just static assets). These must always be fetched from
// the network first when a connection is available - a stale cached copy of any of these
// means every bug fix silently fails to reach the device even after re-deploying, exactly
// like what just happened. Cache is used ONLY as an offline fallback for these.
const NETWORK_FIRST_PATHS = [
  './',
  './index.html',
  './js/jalali.js',
  './js/formula-engine.js',
  './js/db.js',
  './js/firebase-config.js',
  './js/firebase-sync.js',
  './js/app.js'
];
function isNetworkFirst(url) {
  return NETWORK_FIRST_PATHS.some((p) => url.endsWith(p.replace('./', '/')) || url.endsWith(p));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(ASSETS); // core app shell must succeed
      await Promise.all(EXTERNAL_ASSETS.map((url) => cache.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // CRITICAL: never let this service worker touch live Firebase/Firestore API calls
  // (Firestore's Listen/Write channels, Auth's identitytoolkit calls, etc). Those are
  // long-lived streaming/real-time connections, not cacheable static resources. The
  // catch-all cache-first branch below used to call response.clone() + cache.put() on
  // EVERY GET request that didn't match NETWORK_FIRST_PATHS - including these streaming
  // channel requests, since their URL never matches any app path. Trying to buffer an
  // open-ended streaming response into Cache Storage corrupted the underlying WebChannel
  // session (visible as "Cache.put() encountered a network error" / "Failed to convert
  // value to 'Response'" in the console), which is what caused the server to then reject
  // follow-up requests on that broken session with 403 - which the browser then reports
  // as a confusing, misleading "CORS policy" error. None of that was ever a real
  // VPN/CORS/Firebase-config problem; it was this service worker breaking its own app's
  // sync connection. Bypassing entirely (no event.respondWith at all) means these
  // requests go straight to the network exactly as if no service worker existed.
  if (/(^|\.)googleapis\.com$/.test(new URL(url).hostname)) return;

  if (isNetworkFirst(url)) {
    // Logic files (HTML/JS): always try the network first so a fresh deploy/bug-fix is
    // picked up on the very next load, not "eventually, on some future reload". `cache:
    // 'no-store'` is important here too, not just the Cache Storage bypass above - without
    // it, the browser's own regular HTTP cache (separate from the Cache Storage API) can
    // still hand back a stale response to this very fetch() call if the host (e.g. GitHub
    // Pages/its CDN) sent any cacheable response headers, silently defeating this whole
    // "network-first" strategy. Cache Storage is only used as an offline fallback below.
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (icons, css, manifest, external SDK files): cache-first, refreshed
  // in the background. These rarely change and benefit from instant offline loading.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
