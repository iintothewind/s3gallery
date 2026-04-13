import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listObjects, getImageUrl } from "../s3.js";
import { getCached, setCached } from "../imageCache.js";
import { parseDimensions } from "../imageDimensions.js";
import { toHashPath } from "../App.jsx";
import Lightbox from "./Lightbox.jsx";
import Skeleton from "./Skeleton.jsx";

// Thresholds are read from CONFIG at load time so they can be changed in
// config.js without rebuilding the app. Fallbacks match the documented defaults.
const SIZE_LIMIT_BYTES = window.CONFIG.thumbnailMaxBytes  ?? 2 * 1024 * 1024;
const MAX_PX_W         = window.CONFIG.thumbnailMaxWidth  ?? 2560;
const MAX_PX_H         = window.CONFIG.thumbnailMaxHeight ?? 1440;

// ─── Shared tile observers ────────────────────────────────────────────────────
//
// One IntersectionObserver is shared across ALL tiles instead of one per tile.
// With 300 images rendered, this cuts active observer instances from 600+ to 2,
// eliminating the per-scroll re-evaluation overhead that causes gradual slowdown.

const _loadCbs   = new Map(); // element → (isIntersecting: bool) => void
const _unloadCbs = new Map();

const _sharedLoad = new IntersectionObserver(
  (entries) => { for (const e of entries) _loadCbs.get(e.target)?.(e.isIntersecting); },
  { rootMargin: "200px" }
);
const _sharedUnload = new IntersectionObserver(
  (entries) => { for (const e of entries) _unloadCbs.get(e.target)?.(e.isIntersecting); },
  { rootMargin: "2000px" }
);

const watchLoad   = (el, cb) => { _loadCbs.set(el, cb);   _sharedLoad.observe(el); };
const watchUnload = (el, cb) => { _unloadCbs.set(el, cb); _sharedUnload.observe(el); };
const stopLoad    = (el)     => { _loadCbs.delete(el);    _sharedLoad.unobserve(el); };
const stopUnload  = (el)     => { _unloadCbs.delete(el);  _sharedUnload.unobserve(el); };

// ─── Folder listing cache ─────────────────────────────────────────────────────
//
// Caches listObjects() results used by FolderTile previews (bounded LRU).
// Prevents re-issuing S3 ListObjectsV2 for every subfolder tile when the user
// navigates back to a parent folder they've already visited.

const _listCache     = new Map(); // prefix → images[]  (insertion = LRU order)
const LIST_CACHE_MAX = 60;

function listCacheGet(prefix) {
  if (!_listCache.has(prefix)) return null;
  const images = _listCache.get(prefix);
  _listCache.delete(prefix);   // re-insert as most-recently-used
  _listCache.set(prefix, images);
  return images;
}

function listCacheSet(prefix, images) {
  if (_listCache.size >= LIST_CACHE_MAX) {
    _listCache.delete(_listCache.keys().next().value); // evict oldest
  }
  _listCache.set(prefix, images);
}

// ─── Folder icon SVG ─────────────────────────────────────────────────────────

function FolderIcon() {
  return (
    <svg
      className="folder-icon"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3 7C3 5.895 3.895 5 5 5h5.586c.265 0 .52.105.707.293l1.414 1.414c.188.188.442.293.707.293H19c1.105 0 2 .895 2 2v8c0 1.105-.895 2-2 2H5c-1.105 0-2-.895-2-2V7z"
        fill="currentColor"
        fillOpacity="0.85"
      />
    </svg>
  );
}

// ─── High-res placeholder icon ────────────────────────────────────────────────

function HighResPlaceholder() {
  return (
    <div className="highres-placeholder">
      <svg
        className="highres-icon"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M2 16l5-5 4 4 3-3 5 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx="16" cy="9" r="1.5" fill="currentColor" />
      </svg>
      <span className="highres-label">High-Res</span>
    </div>
  );
}

// ─── Folder thumbnail ─────────────────────────────────────────────────────────

function FolderTile({ prefix, name, onClick }) {
  // preview: null = not loaded / evicted, string = blob URL
  const [preview, setPreview] = useState(null);
  const [count,   setCount]   = useState(null);
  const ref        = useRef(null);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Local status mirror — avoids stale React-state closures inside observers.
    // "idle"       = not yet fetched (or evicted)
    // "loading"    = listObjects / preview fetch in progress
    // "loaded"     = blob URL is live and displayed
    // "no-preview" = loaded but no suitable image found (nothing to evict)
    let localStatus = "idle";
    let cancelled   = false;

    function revoke() {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }

    async function loadPreview(images) {
      // Pick the first candidate that fits within the size limit.
      const candidate = images.find((img) => img.size <= SIZE_LIMIT_BYTES);
      if (!candidate) {
        localStatus = "no-preview";
        return;
      }

      const imgUrl = getImageUrl(candidate.key);
      let fullBlob = null;

      // Range-fetch 64 KB to check pixel dimensions before committing to a
      // full download. Same logic as ImageTile step 3.
      try {
        const resp = await fetch(imgUrl, { headers: { Range: "bytes=0-65535" } });
        if (cancelled) return;

        if (resp.status === 200) {
          fullBlob = await resp.blob();
          if (cancelled) return;
          const buf = await fullBlob.slice(0, 65536).arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) {
            localStatus = "no-preview";
            return;
          }
        } else {
          const buf = await resp.arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) {
            localStatus = "no-preview";
            return;
          }
        }
      } catch {
        if (cancelled) return;
      }

      try {
        const blob = fullBlob ?? await fetch(imgUrl).then((r) => r.blob());
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setPreview(url);
        localStatus = "loaded";
      } catch {
        if (!cancelled) localStatus = "no-preview";
      }
    }

    function startLoad() {
      localStatus = "loading";

      // Serve from the listing cache when available — avoids re-issuing a
      // ListObjectsV2 call every time the user navigates back to this folder.
      const hit = listCacheGet(prefix);
      if (hit) {
        setCount(hit.length);
        loadPreview(hit);
        return;
      }

      listObjects(prefix)
        .then(({ images }) => {
          if (cancelled) return;
          listCacheSet(prefix, images);
          setCount(images.length);
          loadPreview(images);
        })
        .catch(() => {
          if (!cancelled) {
            localStatus = "no-preview";
            setCount(0);
          }
        });
    }

    // Shared observers — no per-tile IntersectionObserver instances created.
    watchLoad(el,   (on) => { if (on && localStatus === "idle") startLoad(); });
    watchUnload(el, (on) => {
      if (!on && localStatus === "loaded") {
        revoke();
        setPreview(null);
        localStatus = "idle";
      }
    });

    return () => {
      cancelled = true;
      stopLoad(el);
      stopUnload(el);
      revoke();
    };
  }, [prefix]);

  return (
    <div
      ref={ref}
      className="tile folder-tile"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Open folder ${name}`}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      <div className="tile-inner">
        {preview ? (
          <img src={preview} alt="" className="tile-img" />
        ) : (
          <div className="folder-icon-bg">
            <FolderIcon />
          </div>
        )}
        <div className="tile-overlay">
          <span className="tile-name" title={name}>{name}</span>
          {count !== null && (
            <span className="tile-badge">
              {count} img{count !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Image thumbnail ──────────────────────────────────────────────────────────
//
// Loading pipeline (triggered by IntersectionObserver):
//   1. Check IndexedDB — if a fresh (<24 h) blob exists, display it immediately.
//   2. Check image.size from the S3 listing — if > 2 MB, show High-Res placeholder.
//   3. Range-fetch the first 4 KB and parse pixel dimensions.
//      If > 2560×1440, show High-Res placeholder.
//   4. Fetch the full image, cache the blob in IndexedDB, display it.
//
// Clicking any tile (loaded or placeholder) opens the Lightbox which always
// fetches the original full-resolution file directly from S3.

function ImageTile({ image, onClick }) {
  const fileName = image.key.split("/").pop();

  // status: "idle" | "loading" | "loaded" | "highres" | "error"
  const [status,    setStatus]    = useState("idle");
  const [objectUrl, setObjectUrl] = useState(null);
  const ref        = useRef(null);
  const blobUrlRef = useRef(null); // tracked separately for cleanup

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Local status mirror used inside observer callbacks to avoid stale React
    // state closures. React state (setStatus / setObjectUrl) is used only to
    // drive rendering; this variable drives the load/unload logic.
    let localStatus = "idle"; // "idle" | "loading" | "loaded" | "highres" | "error"
    let cancelled   = false;

    function revoke() {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }

    async function load() {
      if (cancelled || localStatus !== "idle") return;
      localStatus = "loading";
      setStatus("loading");

      // ── 1. IndexedDB cache ──────────────────────────────────────────────────
      const cached = await getCached(image.key);
      if (cancelled) return;
      if (cached) {
        const url = URL.createObjectURL(cached);
        blobUrlRef.current = url;
        setObjectUrl(url);
        localStatus = "loaded";
        setStatus("loaded");
        return;
      }

      // ── 2. Size check (free — already in listing metadata) ─────────────────
      if (image.size > SIZE_LIMIT_BYTES) {
        localStatus = "highres";
        setStatus("highres");
        return;
      }

      // ── 3. Range-fetch first 64 KB → parse pixel dimensions ────────────────
      // 64 KB is needed because DSLR/phone JPEGs embed EXIF/APP1 blocks that
      // can be 20–80 KB before the SOF marker that carries the pixel dimensions.
      // If the server ignores the Range header and returns 200 (full file) we
      // reuse that blob in step 4 so the file is only downloaded once.
      const imgUrl = getImageUrl(image.key);
      let cachedFullBlob = null;
      try {
        const rangeResp = await fetch(imgUrl, { headers: { Range: "bytes=0-65535" } });
        if (cancelled) return;

        if (rangeResp.status === 200) {
          // Server sent the full file — parse dims from a slice and reuse the blob.
          cachedFullBlob = await rangeResp.blob();
          if (cancelled) return;
          const buf = await cachedFullBlob.slice(0, 65536).arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) {
            localStatus = "highres";
            setStatus("highres");
            return;
          }
        } else {
          // 206 Partial Content — parse the slice directly.
          const buf = await rangeResp.arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) {
            localStatus = "highres";
            setStatus("highres");
            return;
          }
        }
      } catch {
        // Range request failed — fall through to full download.
        if (cancelled) return;
      }

      // ── 4. Full download → cache → display ─────────────────────────────────
      try {
        // Reuse the blob from step 3 if the server already sent the whole file.
        const blob = cachedFullBlob ?? await fetch(imgUrl).then((r) => r.blob());
        if (cancelled) return;

        setCached(image.key, blob); // queued batch write — doesn't block display

        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setObjectUrl(url);
        localStatus = "loaded";
        setStatus("loaded");
      } catch {
        if (!cancelled) {
          localStatus = "error";
          setStatus("error");
        }
      }
    }

    // Shared observers — no per-tile IntersectionObserver instances created.
    watchLoad(el,   (on) => { if (on && localStatus === "idle") load(); });
    watchUnload(el, (on) => {
      if (!on && localStatus === "loaded") {
        revoke();
        setObjectUrl(null);
        localStatus = "idle";
        setStatus("idle");
      }
    });

    return () => {
      cancelled = true;
      stopLoad(el);
      stopUnload(el);
      revoke();
    };
  }, [image.key, image.size]);

  return (
    <div
      ref={ref}
      className="tile image-tile"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`View image ${fileName}`}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      <div className="tile-inner">
        {(status === "idle" || status === "loading") && (
          <div className="tile-loading" />
        )}
        {status === "loaded" && objectUrl && (
          <img src={objectUrl} alt={fileName} className="tile-img" />
        )}
        {status === "highres" && <HighResPlaceholder />}
        {status === "error" && (
          <div className="tile-error" aria-label="Failed to load">✕</div>
        )}
        <div className="tile-overlay">
          <span className="tile-name" title={fileName}>{fileName}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main gallery ─────────────────────────────────────────────────────────────

export default function Gallery({ prefix, onNavigate }) {
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [folders,   setFolders]   = useState([]);
  const [images,    setImages]    = useState([]);
  const [sortBy,    setSortBy]    = useState("name");  // "name" | "date"
  const [sortOrder, setSortOrder] = useState("desc");  // "asc"  | "desc"
  const [shown,     setShown]     = useState(window.CONFIG.pageSize || 50);
  const [lbIndex,   setLbIndex]   = useState(null);

  // Reload whenever the prefix changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFolders([]);
    setImages([]);
    setShown(window.CONFIG.pageSize || 50);
    setLbIndex(null);

    listObjects(prefix)
      .then(({ folders, images }) => {
        if (cancelled) return;
        setFolders(folders);
        setImages(images);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load objects from S3.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [prefix]);

  // Sort helpers — memoized so lightbox open/close doesn't re-sort 300 items.
  const getFolderName = (fp) => fp.replace(/\/$/, "").split("/").pop() ?? fp;

  const sortedFolders = useMemo(() =>
    [...folders].sort((a, b) => {
      const cmp = getFolderName(a).localeCompare(getFolderName(b));
      return sortOrder === "desc" ? -cmp : cmp;
    }),
    [folders, sortOrder] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const sortedImages = useMemo(() =>
    [...images].sort((a, b) => {
      const cmp = sortBy === "date"
        ? new Date(a.lastModified) - new Date(b.lastModified)
        : a.key.localeCompare(b.key);
      return sortOrder === "desc" ? -cmp : cmp;
    }),
    [images, sortBy, sortOrder]
  );

  const visibleImages = useMemo(() => sortedImages.slice(0, shown), [sortedImages, shown]);
  const remaining     = sortedImages.length - shown;

  const handleFolderClick = useCallback(
    (folderPrefix) => { onNavigate(toHashPath(folderPrefix)); },
    [onNavigate]
  );

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="gallery">
        <div className="tile-grid">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="gallery">
        <div className="status-box error-box">
          <p><strong>Could not load gallery</strong></p>
          <p>{error}</p>
          <p>
            Check that <code>bucketName</code> and <code>region</code> in{" "}
            <code>config.js</code> are correct and that the bucket has a public
            policy for <code>s3:ListBucket</code> and <code>s3:GetObject</code>.
          </p>
        </div>
      </div>
    );
  }

  if (sortedFolders.length === 0 && sortedImages.length === 0) {
    return (
      <div className="gallery">
        <div className="status-box empty-box"><p>No images here.</p></div>
      </div>
    );
  }

  return (
    <div className="gallery">
      {sortedImages.length > 0 && (
        <div className="gallery-controls">
          <span className="gallery-stats">
            {sortedFolders.length > 0 &&
              `${sortedFolders.length} folder${sortedFolders.length !== 1 ? "s" : ""}, `}
            {sortedImages.length} image{sortedImages.length !== 1 ? "s" : ""}
          </span>
          <div className="sort-controls">
            <label className="sort-label">
              Sort:{" "}
              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="name">Name</option>
                <option value="date">Date</option>
              </select>
            </label>
            <label className="sort-label">
              Order:{" "}
              <select
                className="sort-select"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              >
                <option value="asc">{sortBy === "name" ? "A → Z" : "Oldest first"}</option>
                <option value="desc">{sortBy === "name" ? "Z → A" : "Newest first"}</option>
              </select>
            </label>
          </div>
        </div>
      )}

      <div className="tile-grid">
        {sortedFolders.map((fp) => (
          <FolderTile
            key={fp}
            prefix={fp}
            name={getFolderName(fp)}
            onClick={() => handleFolderClick(fp)}
          />
        ))}
        {visibleImages.map((img, idx) => (
          <ImageTile
            key={img.key}
            image={img}
            onClick={() => setLbIndex(idx)}
          />
        ))}
      </div>

      {remaining > 0 && (
        <div className="load-more-row">
          <button
            className="load-more-btn"
            onClick={() => setShown((n) => n + (window.CONFIG.pageSize || 50))}
          >
            Load {Math.min(remaining, window.CONFIG.pageSize || 50)} more
            &nbsp;({remaining} remaining)
          </button>
        </div>
      )}

      {lbIndex !== null && (
        <Lightbox
          images={visibleImages}
          currentIndex={lbIndex}
          onClose={() => setLbIndex(null)}
          onNavigate={setLbIndex}
        />
      )}
    </div>
  );
}
