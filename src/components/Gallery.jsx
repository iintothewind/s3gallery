import { useState, useEffect, useRef, useCallback } from "react";
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
  // preview: null = not loaded, string = blob URL, false = no usable image
  const [preview, setPreview] = useState(null);
  const [count,   setCount]   = useState(null);
  const ref        = useRef(null);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let cancelled = false;

    async function loadPreview(images) {
      // Pick the first candidate that fits within the size limit.
      // Only one range request is made — no looping through all images.
      const candidate = images.find((img) => img.size <= SIZE_LIMIT_BYTES);
      if (!candidate) return; // all images too large — keep folder icon

      const imgUrl = getImageUrl(candidate.key);
      let fullBlob = null;

      // Range-fetch 64 KB to check pixel dimensions before committing to a
      // full download. Same logic as ImageTile step 3.
      try {
        const resp = await fetch(imgUrl, { headers: { Range: "bytes=0-65535" } });
        if (cancelled) return;

        if (resp.status === 200) {
          // Server returned the full file — reuse it, no second download needed.
          fullBlob = await resp.blob();
          if (cancelled) return;
          const buf = await fullBlob.slice(0, 65536).arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) return; // too large
        } else {
          // 206 Partial Content — check dims from the slice only.
          const buf = await resp.arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) return; // too large
        }
      } catch {
        if (cancelled) return;
        // Range request failed — fall through to full download below.
      }

      // Passed checks — download the full file if we don't have it yet.
      try {
        const blob = fullBlob ?? await fetch(imgUrl).then((r) => r.blob());
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setPreview(url);
      } catch {
        // Network error — folder icon stays
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();

        listObjects(prefix)
          .then(({ images }) => {
            if (cancelled) return;
            setCount(images.length);
            loadPreview(images);
          })
          .catch(() => {
            if (!cancelled) setCount(0);
          });
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
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

    let cancelled = false;

    async function load() {
      if (cancelled) return;
      setStatus("loading");

      // ── 1. IndexedDB cache ──────────────────────────────────────────────────
      const cached = await getCached(image.key);
      if (cancelled) return;
      if (cached) {
        const url = URL.createObjectURL(cached);
        blobUrlRef.current = url;
        setObjectUrl(url);
        setStatus("loaded");
        return;
      }

      // ── 2. Size check (free — already in listing metadata) ─────────────────
      if (image.size > SIZE_LIMIT_BYTES) {
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
            setStatus("highres");
            return;
          }
        } else {
          // 206 Partial Content — parse the slice directly.
          const buf = await rangeResp.arrayBuffer();
          if (cancelled) return;
          const dims = parseDimensions(buf);
          if (dims && (dims.width > MAX_PX_W || dims.height > MAX_PX_H)) {
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

        await setCached(image.key, blob);
        if (cancelled) return;

        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setObjectUrl(url);
        setStatus("loaded");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        load();
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
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

  // Sort helpers
  const getFolderName = (fp) => fp.replace(/\/$/, "").split("/").pop() ?? fp;

  const sortedFolders = [...folders].sort((a, b) => {
    const cmp = getFolderName(a).localeCompare(getFolderName(b));
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const sortedImages = [...images].sort((a, b) => {
    const cmp = sortBy === "date"
      ? new Date(a.lastModified) - new Date(b.lastModified)
      : a.key.localeCompare(b.key);
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const visibleImages = sortedImages.slice(0, shown);
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
