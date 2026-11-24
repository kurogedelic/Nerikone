// Offline cache for the browser build. The build fills in VERSION (a hash of every file) and FILES.
// Install: fetch the whole set into a cache named after VERSION. Activate: drop the caches of older versions.
// Fetch: cache first. A new version is installed in the background and takes over on the next visit (no skipWaiting, so a
// page is never served half old, half new files).
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = 'nerikone-' + VERSION;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(FILES.map(async f => { const r = await fetch(f, {cache: 'reload'}); if (!r.ok) throw new Error(f + ' ' + r.status); await c.put(f, r); }));
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (k.startsWith('nerikone-') && k !== CACHE) await caches.delete(k); })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(req, {ignoreSearch: true, cacheName: CACHE}) || await caches.match(req, {ignoreSearch: true});
    return hit || fetch(req);
  })());
});
