/* 黑板 — Service Worker
   只快取 App 外殼（介面檔案），讓加入主畫面後即使網路不好也能開得起來。
   筆畫資料不在這裡快取，那是 Firebase SDK 自己的離線佇列負責的。 */

const CACHE = "blackboard-v1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Firebase 的連線一律走網路，絕不快取
  if (url.hostname.endsWith("firebasedatabase.app") ||
      url.hostname.endsWith("firebaseio.com")) return;

  // 外殼採「網路優先、失敗回快取」，這樣改版後能立刻拿到新檔
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
