/* Ou Meul Stock: service worker. Keeps the app's own files (and the Firebase and font files it loads) on the device,
   so the app opens with no internet. Your stock and roster data is NOT stored here: Firestore keeps that on the
   device itself (enablePersistence in js/backend.js).

   Own files: try the network first (so updates arrive as soon as there is signal), fall back to the saved copy.
   Firebase SDK and fonts: saved copy first, they never change for a given address.
   Everything else (Firestore, sign-in, anything else): left alone. */
const CACHE = "om-shell-v1";
const SCOPE = self.registration.scope;
const OWN = [
  "", "index.html", "css/app.css", "firebase-config.js",
  "js/roster-engine.js", "js/roster.js", "js/app.js", "js/admin.js", "js/backend.js", "js/offline.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"
].map(p => new URL(p, SCOPE).href);
const REMOTE = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"
];
const NETWORK_WAIT = 4000; // on a weak connection, give up after this long and use the saved copy

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not stop the rest from being saved.
    await Promise.allSettled([
      ...OWN.map(u => cache.add(new Request(u, { cache: "reload" }))),
      ...REMOTE.map(u => cache.add(new Request(u, { mode: "no-cors" })))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("om-shell-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("slow")), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, err => { clearTimeout(t); reject(err); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_WAIT);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await cache.match(new URL("index.html", SCOPE).href) : null);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(SCOPE)) return;
    e.respondWith(networkFirst(req));
  } else if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    e.respondWith(cacheFirst(req));
  } else if (url.hostname === "fonts.googleapis.com") {
    e.respondWith(staleWhileRevalidate(req));
  } else if (url.hostname === "fonts.gstatic.com") {
    e.respondWith(cacheFirst(req));
  }
});
