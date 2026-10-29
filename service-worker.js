// App shell cache plus Web Push. Bump CACHE_NAME with every release that changes
// any file below, so phones pick up the new version.
const CACHE_NAME = "househunter-shell-v7";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./js/supabaseClient.js",
  "./js/format.js",
  "./js/store.js",
  "./js/ui.js",
  "./js/actions.js",
  "./js/board.js",
  "./js/propertySheet.js",
  "./js/editSheet.js",
  "./js/addSheet.js",
  "./js/settings.js",
  "./js/push.js",
  "./js/onboarding.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Shell files: cache first, refreshed in the background. Everything else (Supabase,
// listing photos, esm.sh) goes straight to the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached ?? network;
    })
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: "House Hunter", body: event.data?.text() ?? "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "House Hunter", {
      body: data.body ?? "",
      tag: data.tag,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: data.url ?? "#/board" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(`./${event.notification.data?.url ?? "#/board"}`, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.registration.scope)) {
          client.postMessage({ type: "navigate", url: event.notification.data?.url });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
