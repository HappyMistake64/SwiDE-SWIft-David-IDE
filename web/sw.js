// Online requests use current resources. Keep the complete shell available offline.
const CACHE_PREFIX = "pocket-editor-";
const CACHE = CACHE_PREFIX + "v0.5.1-1";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.mjs", "./core.mjs", "./ide.mjs", "./string-catalog.mjs", "./assets.mjs", "./device-files.mjs", "./folder-import.mjs", "./project-session.mjs", "./issues.mjs", "./debug-report.mjs", "./source-control.mjs", "./editor-tools.mjs", "./language.mjs", "./original-run.mjs",
  "./syntax.mjs", "./zip-workspace.mjs", "./manifest.webmanifest", "./icon.svg"
];
const assetURLs = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const navigation = request.mode === "navigate";
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin ||
      (!assetURLs.has(request.url) && !navigation)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request, {cache: "no-store"});
      if (response.ok && response.type === "basic" && assetURLs.has(request.url)) {
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return (await cache.match(navigation ? "./index.html" : request)) || Response.error();
    }
  })());
});
