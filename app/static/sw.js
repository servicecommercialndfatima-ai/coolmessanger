// Met en cache l'habillage de l'application pour un démarrage rapide.
// Les données privées (/api, /media) ne sont jamais mises en cache.
const CACHE = 'cool-shell-v8';
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

/* ---------- Notifications ---------- */
// Apple exige qu'une notification soit affichée pour chaque message reçu, même application ouverte.
const APPLE = /iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent) && !/Chrome|CriOS|Android/.test(self.navigator.userAgent);

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'COOL MESSENGER', body: e.data ? e.data.text() : '' }; }
  const target = (data.url || '').replace(/^\/\?open=/, '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const focused = list.some(c => c.focused || c.visibilityState === 'visible');
    // Application ouverte et visible : elle joue son propre son, pas besoin d'une notification système.
    list.forEach(c => c.postMessage({ type: 'push', target: target }));
    if (focused && !APPLE) return undefined;
    return self.registration.showNotification(data.title || 'COOL MESSENGER', {
      body: data.body || '',
      icon: '/static/icon-192.png',
      badge: '/static/favicon-64.png',
      tag: data.tag || 'cool',
      renotify: true,
      vibrate: [120, 60, 120],
      data: { target: target, url: data.url || '/' },
    });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const info = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const client = list.find(c => new URL(c.url).origin === location.origin);
    if (client) {
      client.postMessage({ type: 'open', target: info.target });
      return client.focus();
    }
    return self.clients.openWindow(info.url || '/');
  }));
});
