// Met en cache l'habillage de l'application pour un démarrage rapide.
// Les données privées (/api, /media) ne sont jamais mises en cache.
const CACHE = 'cool-shell-v7';
const SHELL = ['/', '/static/app.css', '/static/compat.js', '/static/app.js', '/static/theme.js', '/static/illus-crepuscule.svg', '/static/illus-foret.svg', '/static/illus-corail.svg', '/static/manifest.json', '/static/logo-512.png', '/static/logo-160.png', '/static/favicon-64.png', '/static/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname !== '/' && !url.pathname.startsWith('/static/')) return;
  if (url.pathname.endsWith('.apk')) return; // gros fichier téléchargé une seule fois : jamais en cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
