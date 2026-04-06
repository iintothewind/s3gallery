import { useEffect, useCallback, useRef, useState } from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import { Virtual } from "swiper/modules";
import "swiper/css";
import { getImageUrl } from "../s3.js";

/**
 * Full-screen image viewer with prev/next navigation, keyboard support,
 * and touch swipe gestures via Swiper.js:
 *   swipe left  (right→left) → next image
 *   swipe right (left→right) → previous image
 *   swipe up    (down→up)    → close
 *
 * Uses Swiper's Virtual module so only ~5 slides are ever in the DOM,
 * keeping memory usage constant regardless of total image count.
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

  const sizeMB = image?.size
    ? (image.size / (1024 * 1024)).toFixed(1) + " MB"
    : null;

  // Stable ref to onClose — lets the touch effect run once without stale closures.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const goNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1);
  }, [hasNext, currentIndex, onNavigate]);

  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1);
  }, [hasPrev, currentIndex, onNavigate]);

  // Sync Swiper when currentIndex changes from outside (keyboard / nav buttons)
  useEffect(() => {
    if (swiperRef.current && swiperRef.current.activeIndex !== currentIndex) {
      swiperRef.current.slideTo(currentIndex, 300);
    }
  }, [currentIndex]);

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
      className="lb-overlay"
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
          Virtual module: only the current slide + `addSlidesAfter/Before` neighbors
          are mounted in the DOM. With 300 images loaded only ~5 img elements exist
          at any time, preventing the memory crash on mobile.
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
              <img
                src={getImageUrl(img.key)}
                alt={img.key.split("/").pop()}
                className="lb-img"
                onLoad={(e) => {
                  const w = e.target.naturalWidth;
                  const h = e.target.naturalHeight;
                  if (w && h) {
                    setDimsMap((prev) => ({ ...prev, [img.key]: { w, h } }));
                  }
                }}
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
