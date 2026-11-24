// Offline cache for the browser build. The build fills in VERSION (a hash of every file) and FILES.
// Install: fetch the whole set into a cache named after VERSION. Activate: drop the caches of older versions.
// Fetch: cache first, matching the exact URL (scripts and Python files carry ?v=<build>, so each build only ever finds its own files).
// A new version is installed in the background and takes over at once (skipWaiting), so the next reload shows it. The caches of the two latest builds
// are kept, so a tab that is still open on the previous build keeps getting that build's files.
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = 'nerikone-' + VERSION;
const VERSIONED = f => /^[^/]+\.js$/.test(f) || /^py\//.test(f);  // requested as <file>?v=<build>
const KEYS = FILES.map(f => VERSIONED(f) ? f + '?v=' + VERSION : f).concat(FILES.filter(VERSIONED));  // the plain URL too (module workers fetch by it first)

self.addEventListener('install', e => {
  self.skipWaiting(); // safe: every build only finds its own files (exact URLs), and the previous build's cache is kept
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(KEYS.map(async f => { const r = await fetch(f, {cache: 'reload'}); if (!r.ok) throw new Error(f + ' ' + r.status); await c.put(f, r); }));
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // keep this build and the one before it; older ones go (caches.keys() lists them in the order they were made)
    const mine = (await caches.keys()).filter(k => k.startsWith('nerikone-'));
    for (const k of mine.slice(0, Math.max(0, mine.length - 2))) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    // the exact URL first (it names a build); pages (no ?v) come from this build's cache
    const hit = await caches.match(req, {cacheName: CACHE}) || await caches.match(req);
    return hit || fetch(req);
  })());
});
