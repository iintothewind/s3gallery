/**
 * S3 Gallery configuration.
 *
 * This file is intentionally NOT bundled — it is copied to dist/ as plain JS
 * and loaded via a <script> tag at runtime.  Edit it directly in S3 after
 * deployment (aws s3 cp config.js s3://your-bucket/config.js) without
 * rebuilding the app.
 */
window.CONFIG = {
  /** S3 bucket name */
  bucketName: "collov-nexus",

  /** AWS region the bucket lives in */
  region: "us-west-1",

  /**
   * Prefix (folder) to use as the gallery root.
   * Set to "" to browse the entire bucket, or "photos/" to scope to a subfolder.
   * Must end with "/" when non-empty.
   */
  rootPrefix: "nexus/content/vol-97/",

  /** Title shown in the page header */
  title: "S3Gallery",

  /**
   * Optional ImageKit endpoint for gallery thumbnails.
   * Leave as "" to load thumbnails directly from S3 using the legacy pipeline.
   *
   * This ImageKit endpoint is configured with rootPrefix as its storage root,
   * so thumbnail URLs strip rootPrefix from the S3 key.
   */
  imageKitEndpoint: "https://ik.imagekit.io/iintothewind/",

  /** File extensions to treat as images (lowercase, including the dot) */
  imageExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"],

  /**
   * ImageKit thumbnail settings.
   * The browser picks from thumbnailWidths via srcset; thumbnailQuality is
   * passed to ImageKit as q-80 by default.
   */
  thumbnailWidths: [240, 360, 480, 640],
  thumbnailQuality: 80,

  /**
   * Local fallback thumbnail settings used only when imageKitEndpoint is empty.
   * Before decoding an original locally, the app checks these safety limits.
   * Images above the byte or pixel thresholds show a High-Res placeholder in
   * the gallery to avoid decoding very large bitmaps on mobile.
   *
   * Safe originals are displayed directly as thumbnails through the browser
   * HTTP cache. High-Res images get a local thumbnail only after the user opens
   * the full image in the lightbox.
   */
  thumbnailMaxBytes:  2.5 * 1024 * 1024,
  thumbnailMaxWidth:  2560,
  thumbnailMaxHeight: 2560,
  localThumbnailMaxSize: 480,
  localThumbnailQuality: 0.8,
  localThumbnailConcurrency: 2,

  /**
   * Maximum number of locally generated thumbnail blobs kept in IndexedDB.
   * When exceeded, the oldest entries are evicted automatically.
   * Raise for more aggressive caching (faster repeat visits),
   * lower for stricter memory/storage limits on the device.
   */
  cacheMaxEntries: 2000,
};
