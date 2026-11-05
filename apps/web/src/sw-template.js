/* PDF 工具箱的 Service Worker（由 vite.config.ts 在建置時產生 dist/sw.js）
 *
 * - 程式檔：安裝時預先快取，之後優先從快取讀（檔名含雜湊，內容不會變）
 * - 網頁本身（導覽）：優先從網路讀最新版，離線時用快取
 * - pdf.js 資源（pdfjs/）：用到時才快取
 * 筆記本與原始 PDF 存在 IndexedDB，不經過這裡。
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const APP_CACHE = `app-${VERSION}`;
const RUNTIME_CACHE = "runtime-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new URL(p, self.registration.scope))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("app-") && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  // 導覽：網路優先（拿到最新版），離線用快取的首頁
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put(new URL("./", self.registration.scope), copy));
          return res;
        })
        .catch(() => caches.match(new URL("./", self.registration.scope), { ignoreVary: true })),
    );
    return;
  }

  // 其他：快取優先；pdf.js 資源第一次用到時存進快取。
  // ignoreVary：伺服器回應常帶 Vary: Origin，而 module script 的請求有 Origin 標頭，不忽略就對不上
  event.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.includes("/pdfjs/")) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
