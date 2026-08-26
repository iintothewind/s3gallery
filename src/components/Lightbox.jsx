import { useEffect, useCallback, useRef, useState } from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import { Virtual } from "swiper/modules";
import "swiper/css";
import ArtPlayer from "artplayer";
import { getImageUrl, hasImageKitEndpoint, getMediaType } from "../s3.js";
import { setCached } from "../imageCache.js";
import {
  createLocalThumbnailBlobFromImage,
  dispatchThumbnailReady,
  getThumbnailCacheKey,
} from "../thumbnails.js";

function runWhenIdle(task) {
  if ("requestIdleCallback" in window) {
    return window.requestIdleCallback(task, { timeout: 1200 });
  }
  return window.setTimeout(task, 250);
}

function cancelIdleJob(id) {
  if ("cancelIdleCallback" in window) {
    window.cancelIdleCallback(id);
  } else {
    window.clearTimeout(id);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

// Fully stop a <video> element so a torn-down ArtPlayer cannot keep playing
// audio (avoids "two players / audio ahead of picture" in StrictMode dev).
function stopVideo(video) {
  if (!video) return;
  try {
    video.pause();
    video.muted = true;
    video.removeAttribute("src");
    video.load();
  } catch {}
}

function getViewportOrientation() {
  if (typeof window === "undefined") return "portrait";
  return window.innerWidth >= window.innerHeight ? "landscape" : "portrait";
}

function isMobileViewport() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    navigator.maxTouchPoints > 1 ||
    /Android|iPad|iPhone|iPod|Mobile/i.test(navigator.userAgent || "")
  );
}

function getImageOrientation(dims) {
  if (!dims || dims.w === dims.h) return null;
  return dims.w > dims.h ? "landscape" : "portrait";
}

async function fetchBlobWithProgress(url, signal, onProgress) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const total = Number(response.headers.get("content-length")) || 0;

  onProgress({ loaded: 0, total, percent: total ? 0 : null });

  if (!response.body) {
    const blob = await response.blob();
    onProgress({ loaded: blob.size, total: blob.size, percent: 100 });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPercent = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;

    const percent = total
      ? Math.min(99, Math.floor((loaded / total) * 100))
      : null;

    if (percent === null || percent !== lastPercent) {
      lastPercent = percent;
      onProgress({ loaded, total, percent });
    }
  }

  onProgress({ loaded, total: total || loaded, percent: 100 });
  return new Blob(chunks, { type: contentType });
}

/**
 * Fetches one lightbox image as a Blob URL and revokes it on unmount.
 *
 * Why blobs instead of direct S3 URLs:
 *   Mobile browsers keep decoded bitmaps resident in their image cache keyed
 *   on the URL, even after the <img> element is removed from the DOM. After
 *   200-300 full-resolution images the accumulated decoded memory (≈ 4 MB per
 *   image) causes GC pressure and jank. Revoking a blob:// URL is an explicit
 *   signal to the browser that the underlying data can be freed immediately.
 *
 *   Because Swiper's Virtual module unmounts slides that leave its render
 *   window, React's cleanup runs the revoke for every slide that scrolls out
 *   of view — keeping live decoded memory bounded to ≈ 5 slides at all times.
 */
function SlideImage({ image, alt, onDims, active, autoRotate }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [progress, setProgress] = useState({
    loaded: 0,
    total: image.size || 0,
    percent: image.size ? 0 : null,
  });
  const [error, setError] = useState(null);
  const urlRef = useRef(null);
  const idleJobRef = useRef(null);
  const signalRef = useRef(null);
  const artRef = useRef(null);
  const artContainerRef = useRef(null);
  const imageKey = image.key;
  const isVideo = getMediaType(image.key) === "video";

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    signalRef.current = abort.signal;

    setBlobUrl(null);
    setError(null);
    setProgress({
      loaded: 0,
      total: image.size || 0,
      percent: image.size ? 0 : null,
    });

    // Video: stream directly from S3 (no blob fetch). The instance is created
    // and destroyed by the dedicated ArtPlayer effect below; here we only
    // cancel this effect's own signal so nothing leaks.
    if (isVideo) {
      return () => {
        cancelled = true;
        abort.abort();
        if (signalRef.current === abort.signal) signalRef.current = null;
      };
    }

    fetchBlobWithProgress(getImageUrl(imageKey), abort.signal, (nextProgress) => {
      if (!cancelled && !abort.signal.aborted) {
        setProgress(nextProgress);
      }
    })
      .then((blob) => {
        if (cancelled || abort.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        if (cancelled || abort.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        urlRef.current = url;
        setBlobUrl(url);
      })
      .catch((e) => {
        // AbortError means the slide was unmounted — nothing to do.
        if (e?.name === "AbortError") return;
        if (cancelled) return;
        setError(e?.message || "Failed to load image");
      });

    return () => {
      cancelled = true;
      abort.abort();
      if (signalRef.current === abort.signal) {
        signalRef.current = null;
      }
      if (idleJobRef.current !== null) {
        cancelIdleJob(idleJobRef.current);
        idleJobRef.current = null;
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [image, imageKey, isVideo]);

  // Create/destroy the ArtPlayer instance for video slides.
  // Rules to avoid the "multiple audio sources / videos auto-play" mess:
  //   - Only the CURRENTLY ACTIVE slide gets a player (Swiper may keep the
  //     prev/next neighbors mounted; we must not create players for them).
  //   - autoplay is OFF — playback starts only when the user presses play.
  //   - On teardown we fully stop the element so no stale audio lingers and
  //     the next slide starts from the same "not playing" state.
  useEffect(() => {
    if (!isVideo || !active) return;
    if (artRef.current) {
      stopVideo(artRef.current.video);
      try { artRef.current.destroy(); } catch {}
      artRef.current = null;
    }

    const container = artContainerRef.current;
    if (!container) return;

    let player;
    try {
      player = new ArtPlayer({
        container,
        url: getImageUrl(imageKey),
        autoplay: false,
        // No autoSize: the player should fill the .lb-video-wrap container
        // (matching how images fill the lightbox stage).
        muted: false,
        playsInline: true,
      });
    } catch {
      return;
    }
    artRef.current = player;

    player.on("ready", () => {
      const v = player.video;
      if (v?.videoWidth && v?.videoHeight) onDims(v.videoWidth, v.videoHeight);
    });

    return () => {
      const live = artRef.current;
      if (live === player) {
        if (live.video) stopVideo(live.video);
        try { live.destroy(); } catch {}
        artRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey, active]);

  if (!isVideo && !blobUrl) {
    const progressText = progress.percent === null
      ? "Downloading original"
      : `Downloading original ${progress.percent}%`;
    const byteText = progress.total
      ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.loaded);

    return (
      <div className="lb-slide-loading">
        <div className="lb-loading-card">
          {error ? (
            <>
              <div className="lb-loading-title">Failed to load original</div>
              <div className="lb-loading-meta">{error}</div>
            </>
          ) : (
            <>
              <div className="lb-loading-title">{progressText}</div>
              <div
                className={`lb-progress ${progress.percent === null ? "is-indeterminate" : ""}`}
                role="progressbar"
                aria-label="Original image download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent ?? undefined}
              >
                <div
                  className="lb-progress-fill"
                  style={{ width: progress.percent === null ? "40%" : `${progress.percent}%` }}
                />
              </div>
              {byteText && <div className="lb-loading-meta">{byteText}</div>}
            </>
          )}
        </div>
      </div>
    );
  }

  // Video: streamed directly from S3, played via ArtPlayer (which provides the
  // mobile touch gestures: horizontal swipe to seek, vertical for volume,
  // double-tap to toggle, and its own native control bar). The container is
  // always rendered for video so the ArtPlayer instance has a mounting point.
  if (isVideo) {
    return (
      <div className={autoRotate ? "lb-video-wrap is-video-auto-rotated" : "lb-video-wrap"}>
        <div ref={artContainerRef} className="lb-artplayer" />
      </div>
    );
  }

  return (
    <img
      src={blobUrl}
      alt={alt}
      className="lb-img"
      decoding="async"
      onLoad={(e) => {
        const w = e.target.naturalWidth;
        const h = e.target.naturalHeight;
        if (w && h) onDims(w, h);

        if (!hasImageKitEndpoint() && idleJobRef.current === null) {
          if (!urlRef.current) return;
          const img = e.currentTarget;
          idleJobRef.current = runWhenIdle(() => {
            idleJobRef.current = null;
            const signal = signalRef.current;
            if (!signal || signal.aborted) return;
            const cacheKey = getThumbnailCacheKey(image);
            createLocalThumbnailBlobFromImage(img, signal)
              .then((thumbnailBlob) => {
                if (signal.aborted || signalRef.current !== signal) return;
                setCached(cacheKey, thumbnailBlob);
                dispatchThumbnailReady(cacheKey, thumbnailBlob);
              })
              .catch(() => {});
          });
        }
      }}
    />
  );
}

/**
 * Full-screen image viewer with prev/next navigation, keyboard support,
 * and touch swipe gestures via Swiper.js:
 *   swipe left  (right→left) → next image
 *   swipe right (left→right) → previous image
 *   swipe up    (down→up)    → close
 *
 * Uses Swiper's Virtual module so only ~5 slides are ever in the DOM.
 * Each slide loads its image as a Blob URL (see SlideImage above) so
 * decoded memory is freed as soon as a slide leaves the virtual window.
 *
 * Props:
 *   images        — array of { key, lastModified, size }
 *   currentIndex  — index of the currently displayed image
 *   onClose       — called when the user dismisses the lightbox
 *   onNavigate    — called with a new index when the user navigates
 */
export default function Lightbox({ images, currentIndex, onClose, onNavigate }) {
  const image = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;
  const fileName = image?.key.split("/").pop() ?? "";

  const swiperRef  = useRef(null);
  const contentRef = useRef(null);

  // Map of image key → { w, h } populated via onLoad on each slide's <img>.
  // Persists across slides so dimensions don't disappear when you swipe back.
  const [dimsMap, setDimsMap] = useState({});
  const currentDims = dimsMap[image?.key];
  const currentMediaType = getMediaType(image?.key);
  const [viewportOrientation, setViewportOrientation] = useState(getViewportOrientation);
  const [isImageRotated, setIsImageRotated] = useState(false);
  const imageOrientation = getImageOrientation(currentDims);
  const showRotateButton =
    isMobileViewport() &&
    imageOrientation !== null &&
    imageOrientation !== viewportOrientation &&
    currentMediaType !== "video";
  const canAutoRotateLandscapeVideo =
    isMobileViewport() && viewportOrientation === "portrait";

  // Copy-original-URL feedback state for the caption filename.
  const [copyState, setCopyState] = useState("idle"); // idle | ok | fail
  const copyTimerRef = useRef(null);

  const sizeMB = image?.size
    ? (image.size / (1024 * 1024)).toFixed(1) + " MB"
    : null;

  // Stable ref to onClose — lets the touch effect run once without stale closures.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Copy the full original S3 URL (not the lightbox blob URL) on click/tap.
  const copyOriginalUrl = useCallback(async () => {
    if (!image) return;
    try {
      await navigator.clipboard.writeText(getImageUrl(image.key));
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 1600);
  }, [image]);

  // Clear the copy feedback timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const goNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1);
  }, [hasNext, currentIndex, onNavigate]);

  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1);
  }, [hasPrev, currentIndex, onNavigate]);

  const toggleImageRotation = useCallback((e) => {
    e.stopPropagation();
    setIsImageRotated((rotated) => !rotated);
  }, []);

  // Sync Swiper when currentIndex changes from outside (keyboard / nav buttons)
  useEffect(() => {
    if (swiperRef.current && swiperRef.current.activeIndex !== currentIndex) {
      swiperRef.current.slideTo(currentIndex, 300);
    }
  }, [currentIndex]);

  useEffect(() => {
    setIsImageRotated(false);
  }, [image?.key]);

  // For video, disable Swiper's touch swiping so a horizontal swipe seeks the
  // video (handled on the <video>) instead of navigating between slides.
  useEffect(() => {
    const sw = swiperRef.current;
    if (sw) sw.allowTouchMove = currentMediaType !== "video";
  }, [currentMediaType, currentIndex]);

  useEffect(() => {
    const onViewportChange = () => {
      setViewportOrientation(getViewportOrientation());
      setIsImageRotated(false);
    };

    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, []);

  // Keyboard: Escape closes, arrow keys navigate
  useEffect(() => {
    const onKey = (e) => {
      switch (e.key) {
        case "Escape":     onClose(); break;
        case "ArrowRight": goNext();  break;
        case "ArrowLeft":  goPrev();  break;
        default: break;
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, goNext, goPrev]);

  // Native touch listeners for vertical swipe-up-to-close.
  // Swiper intercepts pointer events internally, so we bypass it by attaching
  // directly to the container element via the Web API.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onTouchEnd = (e) => {
      const t = e.changedTouches[0];
      const dx = Math.abs(t.clientX - startX);
      const dy = startY - t.clientY; // positive = finger moved upward
      if (dy > 60 && dy > dx) {
        onCloseRef.current();
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend",   onTouchEnd,   { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend",   onTouchEnd);
    };
  }, []);

  if (!image) return null;

  return (
    <div
      className={[
        "lb-overlay",
        isImageRotated ? "is-image-rotated" : "",
      ].filter(Boolean).join(" ")}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${fileName}`}
    >
      <div
        ref={contentRef}
        className="lb-content"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="lb-close"
          onClick={onClose}
          aria-label="Close (Escape)"
          title="Close (Escape)"
        >
          ✕
        </button>

        {showRotateButton && (
          <button
            className="lb-rotate"
            onClick={toggleImageRotation}
            aria-label={isImageRotated ? "Restore image orientation" : "Rotate image orientation"}
            title={isImageRotated ? "Restore orientation" : "Rotate orientation"}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        )}

        {hasPrev && (
          <button
            className="lb-nav lb-prev"
            onClick={goPrev}
            aria-label="Previous image (←)"
            title="Previous (←)"
          >
            ‹
          </button>
        )}

        {/*
          Virtual module: only currentIndex ± addSlidesAfter/Before neighbors
          are mounted in the DOM. Each SlideImage fetches via blob URL and revokes
          on unmount, so decoded image memory stays bounded to ~5 slides.
        */}
        <Swiper
          modules={[Virtual]}
          virtual={{ addSlidesAfter: 1, addSlidesBefore: 1 }}
          className="lb-swiper"
          initialSlide={currentIndex}
          spaceBetween={16}
          speed={300}
          onSwiper={(swiper) => { swiperRef.current = swiper; }}
          onSlideChange={(swiper) => {
            if (swiper.activeIndex !== currentIndex) {
              onNavigate(swiper.activeIndex);
            }
          }}
        >
          {images.map((img, idx) => (
            <SwiperSlide key={img.key} virtualIndex={idx}>
              <SlideImage
                image={img}
                alt={img.key.split("/").pop()}
                active={idx === currentIndex}
                autoRotate={
                  canAutoRotateLandscapeVideo &&
                  getMediaType(img.key) === "video" &&
                  (dimsMap[img.key]?.w ?? 0) > (dimsMap[img.key]?.h ?? 0)
                }
                onDims={(w, h) =>
                  setDimsMap((prev) => ({ ...prev, [img.key]: { w, h } }))
                }
              />
            </SwiperSlide>
          ))}
        </Swiper>

        {hasNext && (
          <button
            className="lb-nav lb-next"
            onClick={goNext}
            aria-label="Next image (→)"
            title="Next (→)"
          >
            ›
          </button>
        )}

        <div className="lb-caption">
          <div className="lb-caption-left">
            <span
              className={`lb-filename ${copyState === "ok" ? "is-copied" : copyState === "fail" ? "is-copy-fail" : ""}`}
              title={`Copy original URL · ${image.key}`}
              role="button"
              tabIndex={0}
              aria-label={`Copy original URL for ${fileName}`}
              onClick={copyOriginalUrl}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyOriginalUrl(); } }}
            >
              {copyState === "ok" ? "Copied ✓" : copyState === "fail" ? "Copy failed ✗" : fileName}
            </span>
            <span className="lb-meta">
              {[
                sizeMB,
                currentDims ? `${currentDims.w} × ${currentDims.h}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <span className="lb-counter">
            {currentIndex + 1} / {images.length}
          </span>
        </div>
      </div>
    </div>
  );
}
