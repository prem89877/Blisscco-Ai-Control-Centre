// Blisscco AI Control Center service worker.
// Caches only the static app shell. It NEVER caches /api/ or any other origin (Supabase, GitHub),
// so approvals, health and login data are always live. Bump VERSION to force an update.
const VERSION = 'v1'
const CACHE = 'blisscco-' + VERSION
const SHELL = ['/', '/manifest.json', '/icon.svg', '/icon-maskable.svg']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('blisscco-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Supabase, GitHub etc.: never touched
  if (url.pathname.startsWith('/api/')) return // live data: never cached
  if (url.pathname === '/sw.js') return

  // Page loads: network first (always the newest app), cached shell only when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)) } return res })
        .catch(() => caches.match('/').then(r => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
    )
    return
  }

  // Built files (hashed names) and icons: cache first.
  if (url.pathname.startsWith('/assets/') || /\.(svg|png|ico|json|css|js|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)) }
        return res
      }))
    )
  }
})
