/**
 * @file sw.js
 * @brief Service worker — cache-first for offline PWA support
 *
 * Caches all app shell files on install. Serves from cache first,
 * falling back to network. Bump CACHE_VERSION to force update.
 */

const CACHE_VERSION = 'drehm-v3';

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/serial.js',
  './js/msp.js',
  './js/cli.js',
  './js/util.js',
  './js/tabs/status.js',
  './js/tabs/receiver.js',
  './js/tabs/sensors.js',
  './js/tabs/terminal.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
];

// Install: pre-cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first, network fallback
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request))
  );
});
