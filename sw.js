const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/icon_192x192_new_subject.png',
  '/icon_192x192.png',
  '/icon_512x512.png',
  '/logpack.svg',
  '/manifest.json',
  '/screen_shot1.png',
  '/screen_shot2.png',
  '/screen_shot3.png',
  '/screen_shot4.png',
  '/assets/index-j0atv3cA.css',
  '/assets/index-DsGoMM8J.js',
  '/assets/gcashqr-CZRyxFUC.svg',
  '/assets/mayaqr-_1v_O_2M.svg',
];

const DB_NAME = 'static-assets-db';
const STORE_NAME = 'assets';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('indexedDB open blocked');
  });
}

function putAsset(db, urlKey, blob) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ url: urlKey, content: blob, contentType: blob.type || '' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAsset(db, urlKey) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(urlKey);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeKeyFromRequest(requestUrl) {
  // normalize to pathname + search to match install-time keys
  try {
    const u = new URL(requestUrl, self.location.origin);
    return `${u.pathname}${u.search || ''}`;
  } catch {
    return requestUrl;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const db = await openDB();
      await Promise.all(
        STATIC_ASSETS.map(async (asset) => {
          try {
            // force network to get fresh copy; skip cache so install fails gracefully if offline
            const response = await fetch(new Request(asset, { cache: 'no-store', credentials: 'same-origin' }));
            if (!response.ok) {
              // don't throw - just skip storing this asset
              console.warn('SW: install fetch failed for', asset, response.status);
              return;
            }
            const blob = await response.blob();
            const key = makeKeyFromRequest(response.url);
            await putAsset(db, key, blob);
          } catch (err) {
            // keep install from completely failing if one asset is unavailable
            console.warn('SW: error fetching/storing', asset, err && err.message);
          }
        })
      );
    } catch (err) {
      console.error('SW: install error', err && err.message);
    }
    // activate immediately
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      // take control immediately
      await self.clients.claim();
    } catch (err) {
      console.warn('SW: activate error', err && err.message);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET same-origin requests (avoid interfering with POST/PUT, cross-origin opaque)
  if (request.method !== 'GET') return;
  // Optional: only handle same-origin to avoid CORS/opaque issues
  const reqUrl = new URL(request.url);
  if (reqUrl.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const key = makeKeyFromRequest(request.url);

    try {
      const db = await openDB();
      const record = await getAsset(db, key);
      if (record && record.content) {
        // record.content is a Blob
        return new Response(record.content, {
          headers: { 'Content-Type': record.contentType || 'application/octet-stream' },
        });
      }
    } catch (err) {
      // DB errors should not break fetch; fall through to network attempt
      console.warn('SW: idb read error', err && err.message);
    }

    // Try network
    try {
      const networkResponse = await fetch(request);
      // if response is ok, store it (clone first)
      if (networkResponse && networkResponse.ok) {
        // Clone and store in background (don't await to speed up response)
        (async () => {
          try {
            const db = await openDB();
            const cloned = networkResponse.clone();
            // convert to blob and store
            const blob = await cloned.blob();
            const saveKey = makeKeyFromRequest(request.url);
            await putAsset(db, saveKey, blob);
          } catch (err) {
            // ignore storage errors
            // eslint-disable-next-line no-console
            console.warn('SW: failed to save network response', err && err.message);
          }
        })();
        return networkResponse;
      }
    } catch (err) {
      console.warn('SW: network fetch failed', err && err.message);
    }

    // If navigation request, return offline page from IDB if present
    if (request.mode === 'navigate') {
      try {
        const db = await openDB();
        const offline = await getAsset(db, makeKeyFromRequest('/offline.html'));
        if (offline && offline.content) {
          return new Response(offline.content, {
            headers: { 'Content-Type': offline.contentType || 'text/html' },
          });
        }
      } catch (err) {
        console.warn('SW: offline fallback error', err && err.message);
      }
    }

    // final fallback
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});

// optional: allow client to trigger skipWaiting via postMessage
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});