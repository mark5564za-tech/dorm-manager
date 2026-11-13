const CACHE_NAME = "dorm-manager-shell-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/firebase-auth.js",
  "/api-config.js",
  "/manifest.webmanifest",
  "/icons/dorm-manager-192.png",
  "/icons/dorm-manager-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("dorm-manager-") && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation always prefers the live site; cached HTML is only a fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(async () => (await caches.match("/index.html")) || Response.error())
    );
    return;
  }

  // Cache only the app shell; never cache API/data requests.
  const isAppAsset = /\.(?:js|css|png|webmanifest)$/.test(url.pathname) || url.pathname === "/";
  if (!isAppAsset) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: true })) || Response.error())
  );
});
