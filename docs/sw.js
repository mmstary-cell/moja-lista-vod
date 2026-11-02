/* Service worker: aplikacja działa także bez internetu (pokazuje ostatnio pobraną listę). */
var CACHE = 'netflix-pl-v1';
var SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  var isData = url.pathname.slice(-9) === 'data.json';
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(isData ? 'data.json' : e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(isData ? 'data.json' : e.request, { ignoreSearch: true });
    })
  );
});
