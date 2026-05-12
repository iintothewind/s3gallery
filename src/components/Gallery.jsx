import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  listObjects,
  getImageUrl,
  getImageKitThumbnailUrl,
  getImageKitThumbnailSrcSet,
} from "../s3.js";
import { getCached } from "../imageCache.js";
import { parseDimensions } from "../imageDimensions.js";
import { getThumbnailCacheKey, THUMBNAIL_READY_EVENT } from "../thumbnails.js";
import { toHashPath } from "../App.jsx";
import Lightbox from "./Lightbox.jsx";
import Skeleton from "./Skeleton.jsx";

const TILE_IMAGE_SIZES = "(max-width: 480px) 50vw, 175px";
const GRID_GAP = 12;
const MOBILE_GRID_GAP = 8;
const MIN_TILE_WIDTH = 175;
const MOBILE_MIN_TILE_WIDTH = 130;
const SIZE_LIMIT_BYTES = window.CONFIG.thumbnailMaxBytes ?? 1.2 * 1024 * 1024;
const MAX_PX_W = window.CONFIG.thumbnailMaxWidth ?? 1920;
const MAX_PX_H = window.CONFIG.thumbnailMaxHeight ?? 1920;

async function canDisplayOriginalAsThumbnail(image, signal) {
  if (image.size > SIZE_LIMIT_BYTES) return false;

  try {
    const resp = await fetch(getImageUrl(image.key), {
      headers: { Range: "bytes=0-65535" },
      signal,
    });
    if (!resp.ok) return false;

    const buf = await resp.arrayBuffer();
    const dims = parseDimensions(buf);
    if (!dims) return true;

    return dims.width <= MAX_PX_W && dims.height <= MAX_PX_H;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return false;
  }
}

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
  { rootMargin: "800px" }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getFolderName = (fp) => fp.replace(/\/$/, "").split("/").pop() ?? fp;

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.parentElement ?? el;

    const update = () => {
      const measured = Math.round(target.getBoundingClientRect().width);
      const viewportFallback = Math.max(0, Math.min(window.innerWidth, 1440) - 40);
      const next = Math.max(measured, viewportFallback);
      if (next > 0) {
        setWidth((prev) => prev === next ? prev : next);
      }
    };
    update();

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(update);
      observer.observe(target);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return [ref, width];
}

function getGridMetrics(width) {
  const fallbackWidth = Math.max(1, Math.min(window.innerWidth || 0, 1440) - 40);
  const safeWidth = Math.max(width || 0, fallbackWidth);
  const gap = safeWidth <= 480 ? MOBILE_GRID_GAP : GRID_GAP;
  const minTileWidth = safeWidth <= 480 ? MOBILE_MIN_TILE_WIDTH : MIN_TILE_WIDTH;
  const columns = Math.max(1, Math.floor((safeWidth + gap) / (minTileWidth + gap)));
  const tileSize = Math.max(1, Math.floor((safeWidth - gap * (columns - 1)) / columns));

  return { safeWidth, gap, columns, tileSize };
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

const FolderTile = memo(function FolderTile({ prefix, name, onClick }) {
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
    const abort     = new AbortController();
    const { signal } = abort;

    function revoke() {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }

    async function loadPreview(images) {
      const candidate = images[0];
      if (!candidate) {
        localStatus = "no-preview";
        return;
      }

      const imageKitPreviewUrl = getImageKitThumbnailUrl(candidate.key);
      if (imageKitPreviewUrl) {
        setPreview(imageKitPreviewUrl);
        localStatus = "loaded";
        return;
      }

      // Check the local thumbnail cache first. The cache key is versioned with
      // size and lastModified so old original-blob entries are never reused.
      const cacheKey = getThumbnailCacheKey(candidate);
      const cachedBlob = await getCached(cacheKey);
      if (cancelled) return;
      if (cachedBlob) {
        const url = URL.createObjectURL(cachedBlob);
        blobUrlRef.current = url;
        setPreview(url);
        localStatus = "loaded";
        return;
      }

      try {
        if (!await canDisplayOriginalAsThumbnail(candidate, signal)) {
          localStatus = "no-preview";
          return;
        }

        setPreview(getImageUrl(candidate.key));
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

      listObjects(prefix, signal)
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
      abort.abort();
      stopLoad(el);
      stopUnload(el);
      revoke();
    };
  }, [prefix]);

  return (
    <div
      ref={ref}
      className="tile folder-tile"
      onClick={() => onClick(prefix)}
      role="button"
      tabIndex={0}
      aria-label={`Open folder ${name}`}
      onKeyDown={(e) => e.key === "Enter" && onClick(prefix)}
    >
      <div className="tile-inner">
        {preview ? (
          <img
            src={preview}
            alt=""
            className="tile-img"
            loading="lazy"
            decoding="async"
          />
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
});

// ─── Image thumbnail ──────────────────────────────────────────────────────────
//
// Loading pipeline (triggered by IntersectionObserver):
//   1. If ImageKit is configured, use its CDN thumbnail URL.
//   2. Otherwise check IndexedDB for a locally generated thumbnail.
//   3. If missing and the original is within safe thresholds, display the S3
//      original directly and rely on the browser HTTP cache.
//   4. If the original exceeds any threshold, show the High-Res placeholder.
//      Local thumbnails for these images are produced later when the user opens
//      the full image in the Lightbox.
//
// Clicking any tile (loaded or placeholder) opens the Lightbox which always
// fetches the original full-resolution file directly from S3.

const ImageTile = memo(function ImageTile({ image, index, onClick }) {
  const fileName = image.key.split("/").pop();
  const imageKitUrl = getImageKitThumbnailUrl(image.key);
  const imageKitSrcSet = imageKitUrl ? getImageKitThumbnailSrcSet(image.key) : null;
  const thumbnailCacheKey = getThumbnailCacheKey(image);

  // status: "idle" | "loading" | "loaded" | "highres" | "error"
  const [status,    setStatus]    = useState("idle");
  const [objectUrl, setObjectUrl] = useState(null);
  const [thumbnailUrl, setThumbnailUrl] = useState(null);
  const ref        = useRef(null);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Local status mirror — avoids stale React-state closures inside observer callbacks.
    let localStatus = "idle";
    let cancelled   = false;
    const abort     = new AbortController();
    const { signal } = abort;

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

      if (imageKitUrl) {
        setThumbnailUrl(imageKitUrl);
        setStatus("loaded");
        localStatus = "loaded";
        return;
      }

      // ── 1. Local thumbnail cache ────────────────────────────────────────────
      const cached = await getCached(thumbnailCacheKey);
      if (cancelled) return;
      if (cached) {
        const url = URL.createObjectURL(cached);
        blobUrlRef.current = url;
        setObjectUrl(url);
        localStatus = "loaded";
        setStatus("loaded");
        return;
      }

      // ── 2. Fallback direct S3 thumbnail or High-Res placeholder ────────────
      try {
        if (!await canDisplayOriginalAsThumbnail(image, signal)) {
          localStatus = "highres";
          setStatus("highres");
          return;
        }

        setThumbnailUrl(getImageUrl(image.key));
        localStatus = "loaded";
        setStatus("loaded");
      } catch (e) {
        if (!cancelled && e?.name !== "AbortError") {
          localStatus = "error";
          setStatus("error");
        }
      }
    }

    function onThumbnailReady(e) {
      if (e.detail?.cacheKey !== thumbnailCacheKey || !e.detail?.blob) return;

      revoke();
      const url = URL.createObjectURL(e.detail.blob);
      blobUrlRef.current = url;
      setObjectUrl(url);
      setThumbnailUrl(null);
      localStatus = "loaded";
      setStatus("loaded");
    }

    window.addEventListener(THUMBNAIL_READY_EVENT, onThumbnailReady);

    watchLoad(el,   (on) => { if (on && localStatus === "idle") load(); });
    watchUnload(el, (on) => {
      if (!on && localStatus === "loaded") {
        revoke();
        setObjectUrl(null);
        setThumbnailUrl(null);
        localStatus = "idle";
        setStatus("idle");
      }
    });

    return () => {
      cancelled = true;
      abort.abort();
      window.removeEventListener(THUMBNAIL_READY_EVENT, onThumbnailReady);
      stopLoad(el);
      stopUnload(el);
      revoke();
    };
  }, [image, imageKitUrl, thumbnailCacheKey]);

  return (
    <div
      ref={ref}
      className="tile image-tile"
      onClick={() => onClick(index)}
      role="button"
      tabIndex={0}
      aria-label={`View image ${fileName}`}
      onKeyDown={(e) => e.key === "Enter" && onClick(index)}
    >
      <div className="tile-inner">
        {(status === "idle" || status === "loading") && (
          <div className="tile-loading" />
        )}
        {thumbnailUrl && status !== "error" && (
          <img
            src={thumbnailUrl}
            srcSet={imageKitSrcSet}
            sizes={TILE_IMAGE_SIZES}
            alt={fileName}
            className="tile-img"
            loading="lazy"
            decoding="async"
            onLoad={() => setStatus("loaded")}
            onError={() => setStatus("error")}
          />
        )}
        {status === "loaded" && objectUrl && (
          <img src={objectUrl} alt={fileName} className="tile-img" decoding="async" />
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
});

// ─── Main gallery ─────────────────────────────────────────────────────────────

export default function Gallery({ prefix, onNavigate }) {
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [folders,   setFolders]   = useState([]);
  const [images,    setImages]    = useState([]);
  const [sortBy,    setSortBy]    = useState("name");  // "name" | "date"
  const [sortOrder, setSortOrder] = useState("desc");  // "asc"  | "desc"
  const [lbIndex,   setLbIndex]   = useState(null);
  const [gridRef, gridWidth] = useElementWidth();

  // Reload whenever the prefix changes
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    setFolders([]);
    setImages([]);
    setLbIndex(null);

    listObjects(prefix, abort.signal)
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

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [prefix]);

  const sortedFolders = useMemo(() =>
    [...folders].sort((a, b) => {
      const cmp = getFolderName(a).localeCompare(getFolderName(b));
      return sortOrder === "desc" ? -cmp : cmp;
    }),
    [folders, sortOrder]
  );

  const sortedImages = useMemo(() =>
    [...images].sort((a, b) => {
      // lastModified is a Date object from the AWS SDK — subtract directly.
      const cmp = sortBy === "date"
        ? a.lastModified - b.lastModified
        : a.key.localeCompare(b.key);
      return sortOrder === "desc" ? -cmp : cmp;
    }),
    [images, sortBy, sortOrder]
  );

  const galleryItems = useMemo(() => [
    ...sortedFolders.map((prefix) => ({ type: "folder", key: prefix, prefix })),
    ...sortedImages.map((image, imageIndex) => ({
      type: "image",
      key: image.key,
      image,
      imageIndex,
    })),
  ], [sortedFolders, sortedImages]);

  const { gap: gridGap, columns: columnCount, tileSize } = getGridMetrics(gridWidth);
  const rowCount = Math.ceil(galleryItems.length / columnCount);
  const rowVirtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => tileSize + gridGap,
    overscan: 4,
    scrollMargin: gridRef.current?.offsetTop ?? 0,
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [rowCount, tileSize, gridGap, columnCount]);

  // Stable callbacks so memoized tile components don't re-render on every
  // Gallery render (e.g. lightbox open/close, sort change).
  const handleFolderClick = useCallback(
    (folderPrefix) => { onNavigate(toHashPath(folderPrefix)); },
    [onNavigate]
  );
  const handleImageClick = useCallback((idx) => setLbIndex(idx), []);

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

      <div
        ref={gridRef}
        className="virtual-tile-grid"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * columnCount;
          const rowItems = galleryItems.slice(start, start + columnCount);

          return (
            <div
              key={virtualRow.key}
              className="virtual-tile-row"
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                gap: `${gridGap}px`,
                transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
              }}
            >
              {rowItems.map((item) => (
                <div key={item.key} className="virtual-tile-cell">
                  {item.type === "folder" ? (
                    <FolderTile
                      prefix={item.prefix}
                      name={getFolderName(item.prefix)}
                      onClick={handleFolderClick}
                    />
                  ) : (
                    <ImageTile
                      image={item.image}
                      index={item.imageIndex}
                      onClick={handleImageClick}
                    />
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {lbIndex !== null && (
        <Lightbox
          images={sortedImages}
          currentIndex={lbIndex}
          onClose={() => setLbIndex(null)}
          onNavigate={setLbIndex}
        />
      )}
    </div>
  );
}
