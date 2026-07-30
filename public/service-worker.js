/*
 * The service worker.
 *
 * Deliberately small, and deliberately conservative about what it will serve from a
 * cache. This is a financial system: a stale balance rendered from disk is not a
 * degraded experience, it is a wrong number presented as a current one.
 *
 * So the rules are:
 *
 *   - **Never touch anything but GET.** A POST that a service worker replayed or
 *     answered from a cache could duplicate or fabricate a document. Mutations go
 *     straight to the network, and the application's own queue handles them when it
 *     cannot — with an idempotency key, which a service worker has no way to supply.
 *   - **Never cache `/api/`.** Every API response here is tenant-scoped and
 *     permission-scoped. Cached under one user, it could be served to the next person to
 *     sign in on the same device.
 *   - **Network first for navigations, cache only as a fallback.** The shell is cached so
 *     that opening the app offline shows the app rather than the browser's error page,
 *     but a reachable server always wins.
 *
 * What this buys, then, is narrow and honest: the app opens offline, and the entry
 * screens work, because the drafts and the submission queue live in IndexedDB rather
 * than depending on the network at all.
 */

const VERSION = 'v1';
const SHELL_CACHE = `erp-shell-${VERSION}`;
const OFFLINE_URL = '/offline';

/**
 * Precached at install: the offline fallback and the icon it shows.
 *
 * Deliberately not the built JS chunks. Their names are content-hashed at build time and
 * a worker written by hand cannot know them; guessing would produce a worker that fails
 * to install after every deploy, taking offline mode with it.
 */
const PRECACHE = [OFFLINE_URL, '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `Promise.allSettled`: one 404 in the list must not fail the whole install and
      // leave the app with no worker at all.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions. Without this, a deploy leaves the old shell
      // on disk forever and the storage quota grows with every release.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('erp-shell-') && name !== SHELL_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // Lets the page activate a waiting worker on the user's say-so rather than reloading
  // underneath them.
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Rule 1: mutations are never mediated.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Rule 2: same-origin only, and never the API.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Rule 3: navigations are network-first with an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          // Cache the shell of a successful navigation so the next offline open has
          // something to show.
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            void cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(request);
          if (cached !== undefined) return cached;
          const offline = await cache.match(OFFLINE_URL);
          if (offline !== undefined) return offline;
          return new Response('غير متصل', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // Static build output is content-hashed, so a cache hit can never be stale: a changed
  // file has a different URL. Cache-first here is safe in a way it would not be for
  // anything the application generates.
  if (url.pathname.startsWith('/_next/static/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached !== undefined) return cached;

        const response = await fetch(request);
        if (response.ok) void cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
