// Service worker: cache the app shell so it opens offline. Data calls to GitHub are never cached.
const CACHE = 'mtb-shell-v2.5.0';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons/rider-icon-192.png', 'icons/rider-icon-512.png', 'icons/rider-apple-touch-180.png', 'icons/favicon-32.png', 'icons/rider.svg'];
// cache:'reload' / 'no-cache' bypass the browser's 10-minute HTTP cache, so a new release shows up on the next open
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // GitHub API etc. go straight to network
  // network first, always revalidated with the server (cheap 304 when unchanged); fall back to cache when offline
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
