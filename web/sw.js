/*
 * Vigie — service worker.
 * L'app s'ouvre même sans réseau (la carte et les signalements, eux, demandent une connexion).
 * VERSION et SHELL sont injectés au build : chaque déploiement remplace l'ancien cache.
 */
const VERSION = "__VERSION__";
const CACHE = "vigie-" + VERSION;
const SHELL = __SHELL__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("vigie-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // tuiles de carte et Supabase : toujours le réseau

  if (req.mode === "navigate") {                      // pages : réseau d'abord, copie locale si hors ligne
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./")))
    );
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));   // fichiers de l'app : cache d'abord
});
