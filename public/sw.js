/* Service worker: caches the app shell only (FR-8.11). It never caches or answers /api, /tg or /health. */
const CACHE = "mm-shell-v2";
const SHELL = ["./", "index.html", "app.css", "app.js", "lib.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];

const SHELL_PATHS = new Set(SHELL.map((s) => new URL(s, self.registration.scope).pathname));

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (!SHELL_PATHS.has(p) && req.mode !== "navigate") return; // not part of the shell: leave to the network
  if (p.startsWith("/api") || p.startsWith("/tg/") || p === "/health") return; // network only, never cached
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic" && SHELL_PATHS.has(p)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined) || Response.error())),
  );
});
