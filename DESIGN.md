# Design Notes

This gallery is optimized for browsing S3 prefixes that contain hundreds of
images, videos, and animated files, especially on memory-constrained mobile
browsers.

## Runtime Shape

- `public/config.js` is loaded at runtime and is not bundled. S3 deployment can
  update configuration without rebuilding the app.
- `src/s3.js` owns public S3 listing, direct S3 object URLs, media-type
  classification (`image` / `animated` / `video`), and ImageKit thumbnail URL
  construction.
- `src/components/Gallery.jsx` renders folder and image tiles with a virtual
  row grid, plus the Sort / Mute / Loop toolbar.
- `src/components/Lightbox.jsx` renders originals with Swiper's virtual slides.
  Images fill the stage as blob URLs; videos play through ArtPlayer. The
  caption floats over the bottom edge.
- `src/thumbnails.js` draws an `<img>` or in-tile `<video>` frame to a small
  canvas and stores that blob in IndexedDB.
- `src/imageCache.js` stores only generated local thumbnail blobs in IndexedDB.

## Thumbnail Pipeline

Preferred path, when `imageKitEndpoint` is configured:

1. Gallery tiles use ImageKit transformed URLs with `w-*` and `q-*` settings.
2. The browser chooses a width from `thumbnailWidths` through `srcset`.
3. ImageKit/CDN caching handles repeat visits.
4. Lightbox images still load the original file directly from S3.

Fallback path, when `imageKitEndpoint` is empty:

1. Gallery first checks IndexedDB for a local thumbnail key beginning with
   `thumb:`.
2. If no local thumbnail exists, the app range-fetches the first 64 KB of the
   original and parses image dimensions.
3. If file size and pixel dimensions are below the configured thresholds, the
   original S3 URL is used as the tile thumbnail and normal HTTP cache handles
   reuse.
4. If any threshold is exceeded, the gallery shows a `High-Res` placeholder and
   does not decode the original during thumbnail browsing.
5. When the user opens the original in the lightbox, an idle background task
   draws the already-loaded image to a small canvas and writes only that small
   thumbnail blob to IndexedDB.
6. Visible tiles listen for the thumbnail-ready event and replace placeholders
   or direct original thumbnails immediately.

Video tiles do not use ImageKit. They look up a cached first-frame thumbnail,
or show a paused in-tile `<video>` (`crossOrigin="anonymous"`, with a no-CORS
retry if that fails) and extract that frame into IndexedDB. Scrolling a tile
out of the unload margin aborts in-flight extraction and tears down the video
element. Animated GIF/WebP decode in a hidden `<img>` and keep a static frame
0 in the grid; playback is lightbox-only.

Legacy IndexedDB entries that are not `thumb:` keys are removed during cache
cleanup. This prevents older builds that stored original blobs from leaving
large stale data behind.

## Lightbox Display & Interactions

The lightbox stage (`.lb-swiper`) and `.lb-img` fill the whole overlay
(`width/height: 100%`) with `object-fit: contain`. The original is therefore
kept fully visible while being scaled proportionally so its **longer edge**
touches a stage edge — the image uses the entire viewport with no extra
letterbox, which also plays well with the rotate button.

- **Caption floats above the image.** `.lb-caption` is `position: absolute` and
  pinned to the bottom (`z-index: 1002`) instead of sitting in the document
  flow, so the filename, meta, and `N / total` counter stay visible on small
  screens without pushing the image out of the viewport. A topwards gradient
  keeps the text readable, and `env(safe-area-inset-bottom)` respects iOS home
  indicators. The high `z-index` also guarantees click/tap events land on the
  filename even though the image covers the whole stage.
- **Copy original URL.** Clicking or tapping the filename copies the **full
  original S3 URL** (`getImageUrl(image.key)`), never the lightbox `blob:` URL.
  Desktop-only path uses `navigator.clipboard.writeText` with `ok` / `fail`
  visual feedback (`is-copied` / `is-copy-fail`); the span is keyboard
  accessible (`role="button"` + Enter/Space).
- **Rotate.** A toolbar button toggles `.lb-overlay.is-image-rotated`, which
  transposes the `.lb-img` layout box to the viewport turned on its side
  (`width: 100dvh`, `height: 100dvw`, with `vh`/`vw` fallbacks) before applying
  `rotate(90deg)`. `object-fit: contain` therefore scales the picture inside a
  full-screen-sized box and the rotation maps that box exactly back onto the
  screen — reproducing the unrotated mode's fill-the-viewport behaviour. The
  earlier `max-width: 84vh` / `max-height: 90vw` caps shrank the box before the
  rotation, leaving the rotated image far smaller than the screen.
- **Video playback (ArtPlayer).** Only the active Swiper slide mounts an
  ArtPlayer instance. Neighbors may stay in the DOM, but they do not get a
  player. Teardown calls `pause`, clears `src`, and `load()` so leftover audio
  cannot keep playing. Opening a video tile starts playback (`autoplay: true`).
  Unmuted autoplay can still be blocked until the viewer taps once.
- **Mute / Loop toolbar.** Mute and Loop sit on the gallery toolbar next to
  Sort/Order and persist in `localStorage` (`gallery-video-muted`,
  `gallery-video-loop`). `window.CONFIG.videoMuted` / `videoLoop` apply only
  when those keys are unset.
- **Seamless loop.** Loop is the native `<video loop>` attribute, not
  ArtPlayer's `ended → seek 0 → play` path. Native loop never pauses, so the
  center play button does not flash between cycles and unmuted replay is not
  treated as a new autoplay. `.lb-video-wrap.is-looping .art-mask` is hidden
  as a backstop. If a browser still fires `ended`, the lightbox seeks to 0 and
  plays immediately.
- **Landscape video auto-rotate.** On a coarse/touch portrait viewport, a
  video whose own stored dimensions are wider than tall gets
  `.is-video-auto-rotated` (layout box `100dvh × 100dvw`, then `rotate(90deg)`).
  Rotation is computed per slide from that slide's dimensions so a neighboring
  portrait video is not rotated during a swipe.
- **Video mute / loop vs grid tiles.** Grid tiles always use a muted, paused
  `<video>` only to capture a first-frame thumbnail. Toolbar Mute/Loop do not
  apply there.

## Memory Model

- The gallery virtualizes rows, so large prefixes do not keep hundreds of tile
  components mounted.
- Tile visibility uses shared `IntersectionObserver` instances instead of one
  observer per tile.
- Blob URLs created from IndexedDB thumbnails are revoked when tiles leave the
  unload margin or unmount.
- Lightbox originals are fetched as blob URLs and revoked when Swiper's virtual
  slide unmounts. Video slides stream from S3 and destroy the ArtPlayer instance
  (and stop the media element) when they become inactive or unmount.
- In-flight S3 listing, thumbnail safety range requests, and video-frame
  extraction are aborted when the user leaves a prefix or a tile scrolls out of
  the unload margin.
- Pending local thumbnail jobs are removed from the queue if their slide is
  unmounted before the job starts.

## Virtual Grid

The gallery virtualizes by rows rather than by individual tiles. Each virtual
row contains a CSS grid with the current responsive column count. This keeps the
normal multi-column gallery feel while limiting mounted DOM to the visible rows
plus overscan.

The row height estimate is based on the measured gallery width, configured gap,
and responsive minimum tile width:

- desktop minimum tile width: `175px`
- mobile minimum tile width: `130px`
- desktop gap: `12px`
- mobile gap: `8px`

## Cache Policy

IndexedDB is intentionally a thumbnail cache only:

- original files are not stored in IndexedDB
- original files rely on S3/HTTP cache headers
- thumbnail entries expire after 24 hours
- `cacheMaxEntries` caps the number of local thumbnail blobs
- eviction deletes invalid legacy records and then the oldest thumbnail records

## Operational Notes

- If ImageKit is enabled, verify that its origin root matches `rootPrefix`.
  With the current design, `rootPrefix` is stripped before building the
  ImageKit path.
- S3 CORS must allow browser `ListObjectsV2`, direct image and video fetches,
  canvas frame capture from `<video>` (`crossOrigin="anonymous"`), and range
  requests used by the fallback thumbnail safety check.
- The app assumes the S3 bucket is public-read for listing and object reads; no
  AWS credentials are used in the browser.
