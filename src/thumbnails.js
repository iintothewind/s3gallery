/**
 * Local thumbnail generation used only when ImageKit is not configured.
 *
 * The lightbox image is already decoded by the browser; when idle, it is drawn
 * to a small canvas and only that small thumbnail blob is stored in IDB.
 */

const DEFAULT_THUMB_SIZE = 480;
const DEFAULT_THUMB_QUALITY = 0.8;
const DEFAULT_CONCURRENCY = 2;
export const THUMBNAIL_READY_EVENT = "s3gallery:thumbnail-ready";

let activeJobs = 0;
const queue = [];

function enqueue(task, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const job = { task, resolve, reject, signal, onAbort: null };
    job.onAbort = () => {
      const index = queue.indexOf(job);
      if (index === -1) return;
      queue.splice(index, 1);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", job.onAbort, { once: true });
    queue.push(job);
    runNext();
  });
}

function runNext() {
  const max = window.CONFIG?.localThumbnailConcurrency ?? DEFAULT_CONCURRENCY;
  if (activeJobs >= max || queue.length === 0) return;

  const job = queue.shift();
  job.signal?.removeEventListener("abort", job.onAbort);
  if (job.signal?.aborted) {
    job.reject(new DOMException("Aborted", "AbortError"));
    runNext();
    return;
  }

  activeJobs += 1;
  job.task()
    .then(job.resolve, job.reject)
    .finally(() => {
      activeJobs -= 1;
      runNext();
    });
}

function getTimestamp(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getThumbnailCacheKey(image) {
  const size = window.CONFIG?.localThumbnailMaxSize ?? DEFAULT_THUMB_SIZE;
  return [
    "thumb",
    size,
    image.size ?? 0,
    getTimestamp(image.lastModified),
    image.key,
  ].join(":");
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Failed to create thumbnail")),
      type,
      quality
    );
  });
}

async function renderThumbnailBlob(source) {
  const maxSize = window.CONFIG?.localThumbnailMaxSize ?? DEFAULT_THUMB_SIZE;
  const quality = window.CONFIG?.localThumbnailQuality ?? DEFAULT_THUMB_QUALITY;

  const sourceWidth = source.width || source.naturalWidth;
  const sourceHeight = source.height || source.naturalHeight;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("Image dimensions unavailable");
  }

  const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);

  try {
    return await canvasToBlob(canvas, "image/webp", quality);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function createLocalThumbnailBlobFromImage(imageElement, signal) {
  return enqueue(() => renderThumbnailBlob(imageElement), signal);
}

export function dispatchThumbnailReady(cacheKey, blob) {
  window.dispatchEvent(new CustomEvent(THUMBNAIL_READY_EVENT, {
    detail: { cacheKey, blob },
  }));
}
