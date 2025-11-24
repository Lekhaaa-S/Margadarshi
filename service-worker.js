// Combined Service Worker
// - Merges features from both SW versions found in the project
// - Tolerant precache (won't block install if some resources fail)
const CACHE_NAME = 'app-cache-v4';

// ASSETS: union of important root-level pages and static files. We include both
const ASSETS = [
  '/',
  '/index.html', '/home.html', '/chat.html', '/bookmarks.html', '/studyroom1.html', '/summarizer.html', '/quiz.html', '/progress.html', '/profile.html', '/contact.html', '/privacy.html', '/about.html', '/login.html',
  '/index.js', '/home.js', '/chat.js', '/quiz.js', '/studyroom1.js', '/summarizer.js', '/progress.js', '/profile.js',  '/login.js', '/firebase.js', '/manifest.json', '/index.css', '/home.css', '/chat.css', '/quiz.css', '/studyroom1.css', '/progress.css', '/profile.css', '/common.css', '/style.css',
  '/favicon.ico', '/logo.png', '/send.png', '/imageupload.png', '/loading.gif', '/correct.mp3', '/wrong.mp3', '/google.svg', '/ai.png', '/google.jpg', '/insta.jpg', '/linkdin.jpg', '/submit.svg', '/img.svg', '/user.png',
'/pdf.min.js',
  '/pdf.worker.min.js'];
// Utility: try to fetch and cache an asset, tolerant to failures
async function tryCacheAsset(cache, url) {
  try {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res || !res.ok) throw new Error(`Bad response ${res && res.status}`);
  await cache.put(url, res.clone());
    return { url, ok: true };
  } catch (e) {
    return { url, ok: false, reason: e && e.message };
  }
}

self.addEventListener('install', (event) => {
  console.log('SW installing — tolerant precache');
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Try caching all assets but do not make install fail if some fail.
      const results = await Promise.allSettled(ASSETS.map(u => tryCacheAsset(cache, u)));
  const failed = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok === false).map(r => r.value);
  if (failed.length) console.warn('Some assets failed to cache during install:', failed);
  return true;
    })
  );
});
self.addEventListener('activate', (event) => {
  console.log('SW activated');
  self.clients.claim();
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
});
self.addEventListener('message', (event) => {
  try {
    const data = event.data || {};
    if (data && data.type === 'PRECACHE') {
      console.log('PRECACHE message received — caching assets now');
      caches.open(CACHE_NAME).then(async (cache) => {
  const results = await Promise.allSettled(ASSETS.map(u => tryCacheAsset(cache, u)));
  const failed = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok === false).map(r => r.value);
  if (failed.length) console.warn('Some assets failed to cache on PRECACHE:', failed);
        else console.log('PRECACHE complete: all assets cached');
      }).catch(err => console.error('PRECACHE error', err));
    }
    if (data && data.type === 'CACHE_CURRENT' && data.url) {
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const res = await fetch(data.url, { cache: 'no-store' });
          if (res && res.ok) await cache.put(data.url, res.clone());
        } catch (e) {
          console.warn('CACHE_CURRENT error for', data.url, e);
        }
      }).catch(err => console.error('CACHE_CURRENT open cache failed', err));
    }
    if (data && data.type === 'SKIP_WAITING') {
      try { self.skipWaiting(); } catch (e) { console.warn('skipWaiting failed', e); }
    }
  } catch (e) {
    console.error('message handler error', e);
  }
});
// Helper: try caches.match for the request, and also try matching by pathname to
// increase hit rate when registration scope differs.
async function matchInCaches(request) {
  const cacheResp = await caches.match(request);
  if (cacheResp) return cacheResp;
  try {
  const url = new URL(request.url);
  const pathReq = new Request(url.pathname);
  return await caches.match(pathReq);
  } catch (e) {
    return null;
  }
}
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Bypass cache for dynamic API endpoints and uploads to avoid serving stale data
  try {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const isApiWrite = (req.method !== 'GET');
    const apiPatterns = [
      '/chat', '/chat/', '/getChats', '/uploads', '/uploadImage', '/uploadPDF', '/saveChat', '/deleteChat', '/clearAllChats', '/summarizer'
    ];
    const matchesApi = apiPatterns.some(p => pathname === p || pathname.startsWith(p + '/') || (p === '/chat' && pathname === '/chat'));
    if (isApiWrite || matchesApi) {
      // Network-first for API and upload requests; do not serve cached API responses.
      event.respondWith(fetch(req));
      return;
    }
  } catch (e) {
    // If URL parsing fails, continue with default behavior
    console.warn('SW: URL parse failed in fetch handler', e);
  }
  // Navigation requests: network-first, fallback to cached app shell pages
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
  const net = await fetch(req);
  // Optionally cache the navigation response
  if (net && net.ok) {
          const clone = net.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
        }
        return net;
      } catch (e) {
        // Try cache (including pathname matches), then fallback to common shells
        return (await matchInCaches(req)) || (await caches.match('/index.html')) || (await caches.match('/home.html')) || (await caches.match('/summarizer.html')) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }
  // Other GET requests: cache-first, then network, then 503
  if (req.method === 'GET') {
    event.respondWith((async () => {
  const cached = await matchInCaches(req);
  if (cached) return cached;
  try {
        const net = await fetch(req);
        if (net && net.status === 200) {
          const clone = net.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
        }
        return net;
      } catch (e) {
        return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
      }
    })());
  }
});

