// Install the complete editor shell together. API responses and project downloads bypass this cache.
const CACHE_PREFIX = "pocket-editor-";
const CACHE = CACHE_PREFIX + "v0.6.0-1";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.mjs", "./core.mjs", "./ide.mjs", "./string-catalog.mjs", "./assets.mjs", "./device-files.mjs", "./folder-import.mjs", "./project-session.mjs", "./issues.mjs", "./debug-report.mjs", "./source-control.mjs", "./editor-tools.mjs", "./language.mjs", "./original-run.mjs",
  "./build-target.mjs", "./build-pins.mjs", "./build-result.mjs", "./result-download.mjs", "./build-session.mjs",
  "./syntax.mjs", "./zip-workspace.mjs", "./manifest.webmanifest", "./icon.svg"
];
const assetURLs = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path => new Request(new URL(path, self.registration.scope), {cache:"reload"})))).then(() => self.skipWaiting()));
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
  if (request.method !== "GET" || request.headers.has("Authorization") ||
      !assetURLs.has(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(request)) || fetch(request);
  })());
});
