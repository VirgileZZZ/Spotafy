/* Service worker Spotafy Local — met en cache l'interface (le "shell") pour
 * qu'elle s'ouvre instantanément et même hors-ligne. La lecture audio reste
 * un flux réseau depuis ton PC : elle nécessite toujours une connexion. */
const CACHE = 'spotafy-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // On ne touche pas aux flux réseau (API, audio, pochettes, paroles) :
  // ils dépendent du PC et ne peuvent pas être mis en cache utilement ici.
  if (/^\/(api|song|cover|lyrics)\//.test(url.pathname)) return;

  // Shell : cache d'abord, réseau en repli, et mise à jour en arrière-plan.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
