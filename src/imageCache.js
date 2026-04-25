/**
 * IndexedDB-backed image cache.
 *
 * Stores image Blobs keyed by S3 object key with a Unix-ms timestamp.
 * Entries older than TTL_MS (24 h) are treated as stale and ignored.
 *
 * All public functions are safe to call even when IndexedDB is unavailable
 * (private-browsing mode, storage errors, etc.) — they silently return null/false.
 */

const DB_NAME          = "s3-gallery-cache";
const STORE            = "images";
const VERSION          = 1;
const TTL_MS           = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 400; // ~400 thumbnails × ~1 MB avg ≈ 400 MB cap
const EVICT_EVERY_N    = 150; // run eviction after every 150 newly written entries

let _db          = null;
// Shared in-flight promise: prevents concurrent openDB() calls from each
// issuing their own indexedDB.open() request. Without this, 50+ tiles
// loading simultaneously each create a separate IDB connection; the
// onversionchange handlers then close _db (the shared pointer) instead of
// themselves, leaking connections that block all future version-change
// operations and hang every subsequent open().
let _openPromise = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_openPromise) return _openPromise;

  _openPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch (e) {
      _openPromise = null;
      return reject(e);
    }

    req.onupgradeneeded = (e) => {
      try { e.target.result.createObjectStore(STORE); } catch { /* store already exists */ }
    };

    req.onsuccess = (e) => {
      const db  = e.target.result;
      _db          = db;
      _openPromise = null;

      // Close *this* connection (db), not whatever _db points to at the time
      // the event fires. This prevents a leaked earlier connection from
      // accidentally closing a newer one.
      db.onclose       = () => { if (_db === db) _db = null; };
      db.onversionchange = () => { db.close(); if (_db === db) _db = null; };

      resolve(db);
    };

    req.onerror   = () => { _openPromise = null; reject(req.error); };
    // onblocked fires when another open tab holds a connection and won't
    // close it. Reject immediately so callers don't hang indefinitely.
    req.onblocked = () => { _openPromise = null; reject(new Error("IDB open blocked")); };
  });

  return _openPromise;
}

/**
 * Returns the cached Blob for `key` if it exists and is less than 24 h old,
 * otherwise returns null.
 */
export async function getCached(key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      let req;
      try {
        req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      } catch {
        return resolve(null);
      }
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && Date.now() - entry.timestamp < TTL_MS) {
          resolve(entry.blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ─── Count-based eviction ─────────────────────────────────────────────────────
//
// TTL alone doesn't bound cache size within a session — all entries written
// during one browsing session are < 24 h old and survive cleanupOldEntries().
// After browsing 20-40 directories × 100-300 images the store can grow to
// several GB, causing WebKit to keep excessive data in memory.
//
// _evictToLimit() scans the store, sorts by timestamp, and deletes the oldest
// entries until the total is ≤ MAX_CACHE_ENTRIES. It runs every EVICT_EVERY_N
// newly written blobs (tracked in _sessionWriteCount).

let _sessionWriteCount = 0;

async function _evictToLimit(db) {
  const entries = [];
  await new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE, "readonly"); } catch { return resolve(); }
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      entries.push({ key: cursor.key, ts: cursor.value.timestamp });
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });

  if (entries.length <= MAX_CACHE_ENTRIES) return;

  entries.sort((a, b) => a.ts - b.ts);
  const toDelete = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);

  await new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE, "readwrite"); } catch { return resolve(); }
    for (const { key } of toDelete) {
      try { tx.objectStore(STORE).delete(key); } catch {}
    }
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });
}

// ─── Batched write queue ──────────────────────────────────────────────────────
//
// setCached() used to open one readwrite transaction per image. IDB serialises
// all readwrite transactions on the same store, so 300 simultaneous cache
// writes (full folder first load) queued up and stalled each other, making
// every subsequent image display slower. The queue collects writes that arrive
// within the same 100 ms window and flushes them in a single transaction.

const _writeQueue = new Map(); // key → blob
let   _writeTimer = null;

async function _flushWriteQueue() {
  if (_writeQueue.size === 0) return;
  const batch = [..._writeQueue.entries()];
  _writeQueue.clear();

  let db;
  try { db = await openDB(); } catch { return; }

  await new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE, "readwrite"); } catch { return resolve(); }

    const ts = Date.now();
    for (const [key, blob] of batch) {
      try {
        tx.objectStore(STORE).put({ blob, timestamp: ts }, key);
      } catch (e) {
        if (e?.name === "QuotaExceededError") {
          console.warn("[s3-gallery] IndexedDB quota exceeded — skipping cache writes.");
          try { tx.abort(); } catch {}
          return resolve();
        }
      }
    }

    tx.oncomplete = resolve;
    tx.onerror    = (e) => {
      if (e.target?.error?.name === "QuotaExceededError") {
        console.warn("[s3-gallery] IndexedDB quota exceeded — skipping cache writes.");
      }
      resolve();
    };
  });

  // After every EVICT_EVERY_N writes, enforce the entry count ceiling.
  // Fire-and-forget so it doesn't block the display pipeline.
  _sessionWriteCount += batch.length;
  if (_sessionWriteCount >= EVICT_EVERY_N) {
    _sessionWriteCount = 0;
    _evictToLimit(db).catch(() => {});
  }
}

/**
 * Queues `blob` to be stored under `key`. Writes are batched into a single
 * IDB transaction and flushed within 100 ms. Fire-and-forget — does not block
 * the caller waiting for the write to commit.
 */
export function setCached(key, blob) {
  _writeQueue.set(key, blob);
  if (!_writeTimer) {
    _writeTimer = setTimeout(() => { _writeTimer = null; _flushWriteQueue(); }, 100);
  }
}

/**
 * Deletes cache entries older than 24 h, then enforces MAX_CACHE_ENTRIES.
 * Intended to be called once on page load.
 */
export async function cleanupOldEntries() {
  try {
    const db     = await openDB();
    const cutoff = Date.now() - TTL_MS;
    await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch {
        return resolve();
      }
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (cursor.value.timestamp < cutoff) cursor.delete();
        cursor.continue();
      };
      req.onerror  = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
    // After TTL eviction, also enforce the absolute count ceiling so the store
    // doesn't grow unboundedly across many sessions.
    await _evictToLimit(db);
  } catch {
    // Non-fatal — storage may be unavailable
  }
}
