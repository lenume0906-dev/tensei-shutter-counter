'use strict';

const CACHE_NAME = 'hokuto-tensei-v1';

// 必須キャッシュ（オフライン起動に必要）
const MUST_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

// 任意キャッシュ（アイコンは生成前でも失敗しない）
const TRY_CACHE = [
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// GAS APIはキャッシュしない
const GAS_ORIGIN = 'https://script.google.com';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(MUST_CACHE);
      for (const url of TRY_CACHE) {
        try { await cache.add(url); } catch (_) {}
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // GAS APIはネットワーク優先（失敗時はそのままエラー）
  if (e.request.url.startsWith(GAS_ORIGIN)) {
    e.respondWith(fetch(e.request));
    return;
  }

  // 静的アセットはキャッシュ優先、なければネットワーク取得してキャッシュ
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
