// 오프라인 실행: 앱 파일을 캐시에 두고, 네트워크가 되면 새 버전으로 갱신한다
const V = 'sync-memo-v1.4.9';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'native.js', 'sync.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // 구글 API 는 캐시하지 않는다
  e.respondWith(caches.open(V).then(async c => {
    const key = e.request.mode === 'navigate' ? './' : e.request;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || new Response('오프라인', { status: 503 });
  }));
});
