/**
 * IndexedDB-backed image cache.
 *
 * Stores image Blobs keyed by S3 object key with a Unix-ms timestamp.
 * Entries older than TTL_MS (24 h) are treated as stale and ignored.
 *
 * All public functions are safe to call even when IndexedDB is unavailable
 * (private-browsing mode, storage errors, etc.) — they silently return null/false.
 */

const DB_NAME = "s3-gallery-cache";
const STORE   = "images";
const VERSION = 1;
const TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

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

/**
 * Stores `blob` under `key` with the current timestamp.
 * Gracefully handles QuotaExceededError by skipping the write.
 */
export async function setCached(key, blob) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      let req;
      try {
        req = db
          .transaction(STORE, "readwrite")
          .objectStore(STORE)
          .put({ blob, timestamp: Date.now() }, key);
      } catch {
        return resolve(false);
      }
      req.onsuccess = () => resolve(true);
      req.onerror   = (e) => {
        if (e.target.error?.name === "QuotaExceededError") {
          console.warn("[s3-gallery] IndexedDB quota exceeded — skipping cache write.");
        }
        resolve(false);
      };
    });
  } catch {
    return false;
  }
}

/**
 * Deletes all cache entries older than 24 h.
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
  } catch {
    // Non-fatal — storage may be unavailable
  }
}
