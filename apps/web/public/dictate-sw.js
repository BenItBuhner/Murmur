// Murmur web dictation (/dictate) service worker. It makes the page installable and keeps its
// shell loading offline; sign-in, the gateway and Convex always go to the network and are never
// cached. Bump VERSION when the caching rules change.
const VERSION = 'v1'
const CACHE = `murmur-dictate-${VERSION}`

// Build files are content-hashed, so each deploy adds new ones; keep only the newest.
const MAX_ENTRIES = 80
async function put(req, res) {
  const cache = await caches.open(CACHE)
  await cache.put(req, res)
  const keys = await cache.keys()
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(old)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/dictate', '/dictate.webmanifest', '/dictate/icon-192.png']))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('murmur-dictate-') && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate' && url.pathname === '/dictate') {
    // Network first so a deploy shows at once; the cached page when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put('/dictate', copy))
          }
          return res
        })
        .catch(() => caches.match('/dictate'))
    )
    return
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/dictate/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) put(req, res.clone())
            return res
          })
      )
    )
  }
})
