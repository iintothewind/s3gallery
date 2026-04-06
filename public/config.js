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
  title: "My Gallery",

  /** File extensions to treat as images (lowercase, including the dot) */
  imageExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"],

  /** Number of image thumbnails shown before a "Load more" button appears */
  pageSize: 50,

  /**
   * Thumbnail lazy-load filters.
   * Images that exceed either threshold are shown as a High-Res placeholder
   * in the gallery grid (clicking still opens the full image in the lightbox).
   *
   * thumbnailMaxBytes     — max file size in bytes (default 2 MB)
   * thumbnailMaxWidth     — max pixel width  (default 2560)
   * thumbnailMaxHeight    — max pixel height (default 1440)
   */
  thumbnailMaxBytes:  2.5 * 1024 * 1024,
  thumbnailMaxWidth:  2560,
  thumbnailMaxHeight: 2048,
};
