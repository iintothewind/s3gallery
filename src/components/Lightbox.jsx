import { useEffect, useCallback, useRef, useState } from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import { Virtual } from "swiper/modules";
import "swiper/css";
import { getImageUrl, hasImageKitEndpoint } from "../s3.js";
import { setCached } from "../imageCache.js";
import {
  createLocalThumbnailBlobFromImage,
  dispatchThumbnailReady,
  getThumbnailCacheKey,
} from "../thumbnails.js";

function getFullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function isIOSLike() {
  const ua = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isMobileLike() {
  return (
    /Android|iPad|iPhone|iPod|Mobile/i.test(navigator.userAgent || "") ||
    navigator.maxTouchPoints > 1 ||
    window.matchMedia?.("(pointer: coarse)")?.matches
  );
}

function isPortraitViewport() {
  return window.innerHeight > window.innerWidth;
}

function imagePrefersLandscape(dims) {
  return Boolean(dims && dims.w > dims.h);
}

function canLockOrientation() {
  return typeof screen.orientation?.lock === "function";
}

function canUseCssLandscapeFallback() {
  return isMobileLike();
}

async function requestNativeFullscreen(element) {
  if (!element) return false;
  const request =
    element.requestFullscreen ||
    element.webkitRequestFullscreen ||
    element.msRequestFullscreen;
  if (!request) return false;

  try {
    await request.call(element);
    return true;
  } catch {
    return false;
  }
}

async function exitNativeFullscreen() {
  if (!getFullscreenElement()) return;
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.msExitFullscreen;
  if (!exit) return;

  try {
    await exit.call(document);
  } catch {
    // The browser can reject if fullscreen already changed via a system gesture.
  }
}

async function exitElementFullscreen(element) {
  const fullscreenElement = getFullscreenElement();
  if (fullscreenElement && fullscreenElement === element) {
    await exitNativeFullscreen();
  }
}

async function lockLandscapeOrientation() {
  if (!canLockOrientation()) return false;

  try {
    await screen.orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}

function unlockOrientation() {
  try {
    screen.orientation?.unlock?.();
  } catch {
    // Some browsers expose unlock but throw when no lock is currently active.
  }
}

function getOrCreateThemeColorMeta() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  return meta;
}

function restoreBodyStyles(styles) {
  if (!styles) return;
  document.body.style.position = styles.position;
  document.body.style.top = styles.top;
  document.body.style.left = styles.left;
  document.body.style.right = styles.right;
  document.body.style.width = styles.width;
  document.body.style.overflow = styles.overflow;
}

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
function SlideImage({ image, alt, onDims }) {
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
  const imageKey = image.key;

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
  }, [image, imageKey]);

  if (!blobUrl) {
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
  const overlayRef = useRef(null);
  const contentRef = useRef(null);
  const smartFullscreenActiveRef = useRef(false);
  const orientationLockedRef = useRef(false);
  const immersiveLockRef = useRef(null);
  const preLightboxBodyStylesRef = useRef(null);

  // Map of image key → { w, h } populated via onLoad on each slide's <img>.
  // Persists across slides so dimensions don't disappear when you swipe back.
  const [dimsMap, setDimsMap] = useState({});
  const currentDims = dimsMap[image?.key];
  const [smartFullscreenActive, setSmartFullscreenActive] = useState(false);
  const [forceCssLandscape, setForceCssLandscape] = useState(false);

  const sizeMB = image?.size
    ? (image.size / (1024 * 1024)).toFixed(1) + " MB"
    : null;

  // Stable close ref lets the touch effect run once without stale closures.
  const onCloseRef = useRef(onClose);

  const goNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1);
  }, [hasNext, currentIndex, onNavigate]);

  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1);
  }, [hasPrev, currentIndex, onNavigate]);

  const releaseImmersiveLock = useCallback(({ bodyStyles } = {}) => {
    const lock = immersiveLockRef.current;
    document.documentElement.classList.remove("lightbox-immersive-lock");
    document.body.classList.remove("lightbox-immersive-lock");

    if (!lock) {
      restoreBodyStyles(bodyStyles);
      return;
    }

    restoreBodyStyles(bodyStyles ?? {
      position: lock.bodyPosition,
      top: lock.bodyTop,
      left: lock.bodyLeft,
      right: lock.bodyRight,
      width: lock.bodyWidth,
      overflow: lock.bodyOverflow,
    });

    if (lock.themeMeta) {
      if (lock.hadThemeColor) {
        lock.themeMeta.setAttribute("content", lock.themeColor);
      } else {
        lock.themeMeta.remove();
      }
    }

    window.scrollTo(0, lock.scrollY);
    immersiveLockRef.current = null;
  }, []);

  const applyImmersiveLock = useCallback(() => {
    if (immersiveLockRef.current) return;

    const themeMeta = getOrCreateThemeColorMeta();
    const hadThemeColor = themeMeta.hasAttribute("content");
    const themeColor = themeMeta.getAttribute("content") || "";
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;

    immersiveLockRef.current = {
      bodyPosition: document.body.style.position,
      bodyTop: document.body.style.top,
      bodyLeft: document.body.style.left,
      bodyRight: document.body.style.right,
      bodyWidth: document.body.style.width,
      bodyOverflow: document.body.style.overflow,
      hadThemeColor,
      scrollY,
      themeColor,
      themeMeta,
    };

    document.documentElement.classList.add("lightbox-immersive-lock");
    document.body.classList.add("lightbox-immersive-lock");
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    themeMeta.setAttribute("content", "#000000");
  }, []);

  const leaveSmartFullscreen = useCallback(async ({ exitNative = true } = {}) => {
    smartFullscreenActiveRef.current = false;
    orientationLockedRef.current = false;
    setSmartFullscreenActive(false);
    setForceCssLandscape(false);
    releaseImmersiveLock();
    unlockOrientation();
    if (exitNative) {
      await exitElementFullscreen(overlayRef.current);
    }
  }, [releaseImmersiveLock]);

  const closeLightbox = useCallback(() => {
    smartFullscreenActiveRef.current = false;
    orientationLockedRef.current = false;
    setSmartFullscreenActive(false);
    setForceCssLandscape(false);
    releaseImmersiveLock({ bodyStyles: preLightboxBodyStylesRef.current });
    unlockOrientation();
    exitElementFullscreen(overlayRef.current);
    onClose();
  }, [onClose, releaseImmersiveLock]);

  onCloseRef.current = closeLightbox;

  const syncCssLandscape = useCallback(() => {
    if (!smartFullscreenActiveRef.current || orientationLockedRef.current) return;

    if (canUseCssLandscapeFallback()) {
      setForceCssLandscape(isPortraitViewport() && imagePrefersLandscape(currentDims));
      return;
    }

    setForceCssLandscape(false);
  }, [currentDims]);

  const handleSmartFullscreen = useCallback(async (e) => {
    e.stopPropagation();

    if (smartFullscreenActiveRef.current) {
      await leaveSmartFullscreen();
      return;
    }

    const startedInPortrait = isPortraitViewport();
    const shouldUseLandscape = startedInPortrait && imagePrefersLandscape(currentDims);
    smartFullscreenActiveRef.current = true;
    orientationLockedRef.current = false;
    setSmartFullscreenActive(true);
    setForceCssLandscape(false);
    applyImmersiveLock();

    if (!isIOSLike()) {
      await requestNativeFullscreen(overlayRef.current);
    }

    if (shouldUseLandscape && !isIOSLike()) {
      orientationLockedRef.current = await lockLandscapeOrientation();
    }

    if (shouldUseLandscape && !orientationLockedRef.current && canUseCssLandscapeFallback()) {
      setForceCssLandscape(true);
    }
  }, [currentDims, leaveSmartFullscreen]);

  // Sync Swiper when currentIndex changes from outside (keyboard / nav buttons)
  useEffect(() => {
    if (swiperRef.current && swiperRef.current.activeIndex !== currentIndex) {
      swiperRef.current.slideTo(currentIndex, 300);
    }
  }, [currentIndex]);

  useEffect(() => {
    syncCssLandscape();
  }, [syncCssLandscape]);

  useEffect(() => {
    preLightboxBodyStylesRef.current = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };

    document.body.style.overflow = "hidden";

    return () => {
      releaseImmersiveLock({ bodyStyles: preLightboxBodyStylesRef.current });
      restoreBodyStyles(preLightboxBodyStylesRef.current);
      preLightboxBodyStylesRef.current = null;
    };
  }, [releaseImmersiveLock]);

  // Keyboard: Escape closes, arrow keys navigate
  useEffect(() => {
    const onKey = (e) => {
      switch (e.key) {
        case "Escape":     closeLightbox(); break;
        case "ArrowRight": goNext();  break;
        case "ArrowLeft":  goPrev();  break;
        default: break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [closeLightbox, goNext, goPrev]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!getFullscreenElement() && smartFullscreenActiveRef.current) {
        smartFullscreenActiveRef.current = false;
        orientationLockedRef.current = false;
        setSmartFullscreenActive(false);
        setForceCssLandscape(false);
        releaseImmersiveLock();
        unlockOrientation();
      }
    };

    const onViewportChange = () => {
      syncCssLandscape();
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    document.addEventListener("msfullscreenchange", onFullscreenChange);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
      document.removeEventListener("msfullscreenchange", onFullscreenChange);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
      releaseImmersiveLock();
      unlockOrientation();
      exitElementFullscreen(overlayRef.current);
    };
  }, [releaseImmersiveLock, syncCssLandscape]);

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
      ref={overlayRef}
      className={[
        "lb-overlay",
        smartFullscreenActive ? "is-smart-fullscreen" : "",
        forceCssLandscape ? "force-css-landscape" : "",
      ].filter(Boolean).join(" ")}
      onClick={closeLightbox}
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
          onClick={closeLightbox}
          aria-label="Close (Escape)"
          title="Close (Escape)"
        >
          ✕
        </button>

        <button
          className="lb-smart-fullscreen"
          onClick={handleSmartFullscreen}
          aria-label={smartFullscreenActive ? "Return to lightbox" : "Smart fullscreen"}
          title={smartFullscreenActive ? "Return to lightbox" : "Smart fullscreen"}
        >
          {smartFullscreenActive ? "返回" : "智能全屏"}
        </button>

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
          grabCursor
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
            <span className="lb-filename" title={image.key}>{fileName}</span>
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
