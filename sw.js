// Ascend service worker — v3.1 (security hardening: CSP, per-user enrollment, Anthropic proxy, brute-force lockout).
//   - Navigations + manifest + other same-origin GETs → network-first (cache fallback for offline)
//   - Icons → cache-first, precached on install
//   - Cross-origin (Plaid CDN, Anthropic API, etc.) → not intercepted; browser handles natively
// Cache name auto-derives from a hash of index.html so editing index.html yields a new cache
// and the old one is purged on activate — no manual version bumping for normal iteration.
// Caveat: changing an icon also requires editing any byte of this file, since SW updates only
// trigger on sw.js byte changes and icons are cache-first.

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
];

const ICON_RE = /\/icon-[\w-]+\.png$/;

let CACHE_NAME = null;

async function computeCacheName() {
  const r = await fetch("./index.html", { cache: "no-store" });
  const buf = await r.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hash = Array.from(new Uint8Array(digest).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "ascend-" + hash;
}

async function ensureCacheName() {
  if (CACHE_NAME) return CACHE_NAME;
  const keys = (await caches.keys()).filter((k) => k.startsWith("ascend-"));
  if (keys.length === 1) { CACHE_NAME = keys[0]; return CACHE_NAME; }
  CACHE_NAME = await computeCacheName();
  return CACHE_NAME;
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    CACHE_NAME = await computeCacheName();
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_ASSETS.map(async (u) => {
      try { await cache.add(new Request(u, { cache: "no-store" })); } catch {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const current = await ensureCacheName();
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("ascend-") && k !== current).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // /api/* and /stockanalyzer* → never cache. Both are served by the Python
  // backend (api/index.py): /api/* is the JSON/SSE surface (stock quotes go
  // stale, SSE streams would break under caching), /stockanalyzer{,-static}/*
  // is the standalone Flask page (dynamic HTML, would otherwise be pinned to
  // the hashed cache name). Let the browser talk to the backend natively.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/stockanalyzer" || url.pathname.startsWith("/stockanalyzer/") || url.pathname.startsWith("/stockanalyzer-static/")) return;

  if (ICON_RE.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  } else {
    e.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(await ensureCacheName());
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    return Response.error();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(await ensureCacheName());
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") {
      const fallback = (await cache.match("./index.html")) || (await cache.match("./"));
      if (fallback) return fallback;
    }
    return Response.error();
  }
}

// ============ Push notifications ============
// Receives Web Push events from the backend (when subscribed). The backend
// signs each push with VAPID; this handler decodes the payload (JSON
// {title, body, tag, url}) and shows a system notification — works while
// the app is closed (iOS 16.4+ Home Screen PWA, Android, desktop).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {
    try { data = { body: event.data ? event.data.text() : "" }; } catch {}
  }
  const title = data.title || "Ascend";
  const opts = {
    body: data.body || "",
    icon: data.icon || "./icon-192.png",
    badge: data.badge || "./icon-192.png",
    tag: data.tag || "ascend",
    data: { url: data.url || "/" },
    requireInteraction: !!data.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Clicking a notification opens (or focuses) the app to the URL the push
// included. Falls back to the root if the push didn't specify. The target
// URL is sanitized to same-origin AND an allowlisted path prefix to
// prevent a crafted push payload from (a) navigating an existing tab to
// evil.com, or (b) deep-linking to a same-origin route that triggers a
// destructive client-side action.
const ALLOWED_NAV_PATHS = [
  "/", "/?", "/?tab=today", "/?tab=money", "/?tab=stocks", "/?tab=goals",
  "/?tab=stats", "/?tab=calendar", "/?tab=planning", "/?tab=settings",
];
function _safeNavTarget(rawTarget) {
  try {
    const parsed = new URL(rawTarget, self.location.origin);
    if (parsed.origin !== self.location.origin) return "/";
    const pathPlusQuery = parsed.pathname + parsed.search;
    for (const ok of ALLOWED_NAV_PATHS) {
      if (pathPlusQuery === ok || pathPlusQuery.startsWith(ok)) return pathPlusQuery + parsed.hash;
    }
  } catch {}
  return "/";
}
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawTarget = (event.notification.data && event.notification.data.url) || "/";
  const target = _safeNavTarget(rawTarget);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      // Use a parsed-origin check instead of substring — "evil.com/?u=https://app"
      // would have falsely matched origin.includes().
      let sameOrigin = false;
      try { sameOrigin = (new URL(c.url).origin === self.location.origin); } catch {}
      if (sameOrigin) {
        await c.focus();
        if ("navigate" in c) { try { await c.navigate(target); } catch {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
