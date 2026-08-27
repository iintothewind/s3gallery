# s3gallery

A static media gallery that browses a public S3 bucket using the AWS SDK v3
with **anonymous (unsigned) requests** — no credentials required. It displays
images, animated GIF/WebP, and mp4/webm video.

## Configuration

There are two supported ways to configure the gallery. The recommended path is
`.env.local` because it keeps bucket-specific values out of git.

For local/private deployment values, copy [`.env.example`](.env.example) to
`.env.local` and fill in your bucket, region, app deploy prefix, and gallery
root prefix:

```bash
cp .env.example .env.local
npm run generate:env
```

`npm run generate:env` reads `.env.local` and writes:

```text
public/config.js           # runtime gallery config copied into dist/
bucket_policy.local.json   # concrete bucket policy for your bucket
```

Both `.env.local` and `bucket_policy.local.json` are ignored by git. The
tracked [`bucket_policy.json`](bucket_policy.json) remains a placeholder
template.

You can also edit [`public/config.js`](public/config.js) directly before
building (or edit it in S3 after deploying), but if you use `.env.local` this
file should be treated as generated output:

```js
window.CONFIG = {
  bucketName:      "my-bucket-name",   // your S3 bucket
  region:          "us-east-1",        // bucket's AWS region
  rootPrefix:      "",                 // "" = entire bucket; "photos/" = scope to subfolder
  title:           "My Gallery",
  imageKitEndpoint: "",                // optional ImageKit URL endpoint for thumbnails
  thumbnailWidths: [240, 360, 480, 640],
  thumbnailQuality: 80,
  thumbnailMaxBytes:  2.5 * 1024 * 1024,
  thumbnailMaxWidth:  2560,
  thumbnailMaxHeight: 2560,
  localThumbnailMaxSize: 480,
  localThumbnailQuality: 0.8,
  localThumbnailConcurrency: 2,
  cacheMaxEntries: 2000,
  imageExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"],
  videoExtensions: [".mp4", ".webm"],
  animatedExtensions: [".gif", ".webp"],
  videoMuted: false,               // first-visit default for the toolbar Mute control
  videoLoop: false,                // first-visit default for the toolbar Loop control
};
```

`config.js` is **not bundled** — it is copied to `dist/` as-is and loaded via
a relative `<script src="./config.js">` tag at runtime. If you deploy the app
under a subdirectory such as `nexus/gallery/`, the deployed runtime config is:

```text
s3://my-bucket-name/nexus/gallery/config.js
```

After deploying, you can update just this file in S3 without rebuilding:

```bash
aws s3 cp public/config.js s3://my-bucket-name/nexus/gallery/config.js
```

### Thumbnails

If `imageKitEndpoint` is set, gallery thumbnails are loaded through ImageKit
with path transformations such as:

```text
https://ik.imagekit.io/iintothewind/tr:w-480,q-80/folder/image.jpg
```

This project assumes the ImageKit origin is already scoped to `rootPrefix`.
Therefore the app strips `rootPrefix` from the S3 key when building ImageKit
thumbnail URLs. Lightbox/original images still load directly from S3.

If `imageKitEndpoint` is empty, the fallback path is:

1. Check IndexedDB for a locally generated thumbnail.
2. If missing, inspect a small byte range of the S3 original to read dimensions.
3. Display the original directly as a thumbnail only when it is below
   `thumbnailMaxBytes`, `thumbnailMaxWidth`, and `thumbnailMaxHeight`.
4. Otherwise show a `High-Res` placeholder. A local thumbnail is generated only
   after the user opens that original in the lightbox.

Only small generated thumbnails are written to IndexedDB. Original images rely
on normal HTTP caching and are not stored in IndexedDB.

Video tiles skip ImageKit. They use a cached first-frame JPEG/WebP when one
exists; otherwise the grid shows a paused in-tile `<video>` and captures that
frame into IndexedDB. Playback happens only in the lightbox.

### Video mute, loop, and autoplay

The gallery toolbar (same row as Sort / Order) has **Mute** and **Loop**
selects. The visitor's choice is stored in `localStorage`. `videoMuted` and
`videoLoop` in `config.js` (or `S3GALLERY_VIDEO_MUTED` /
`S3GALLERY_VIDEO_LOOP` in `.env.local`) are used only on the first visit,
before anything is stored.

Opening a video tile starts playback. Loop uses the native `<video loop>`
attribute so the clip does not pause between cycles. If **Mute** is off, some
browsers still block the first unmuted autoplay — tap play once; looping after
that should continue without the center play button.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build & Deploy

`vite.config.js` uses a **relative base** (`base: "./"`), so the built assets
reference their own directory with relative paths. The app can therefore be
deployed under **any** S3 prefix — you do not need to rebuild or change a
config value when the deploy prefix changes.

```bash
npm run generate:env                                      # if using .env.local
npm run build                                              # produces dist/
aws s3 sync ./dist s3://my-bucket-name/<APP_PREFIX>/ --delete
```

`config.js` is the only prefix-dependent runtime file. If it is generated by
`generate:env`, run `npm run generate:env` before building so `dist/config.js`
matches your target bucket. If you instead keep a separately maintained runtime
`config.js` on S3 (e.g. generated from `.env.local` for a different bucket),
protect it from being overwritten by an older local copy:

```bash
aws s3 sync ./dist s3://my-bucket-name/<APP_PREFIX>/ --delete --exclude "config.js"
```

`npm run generate:env` only writes the generated files (`public/config.js`,
`bucket_policy.local.json`, `cors.local.xml`) from `.env.local`; it does not
affect the asset base anymore.

## S3 Bucket Setup

Before deploying, configure your bucket with the included policy and CORS files.
**Replace placeholder values with your actual bucket name, deploy prefix, and
gallery root prefix before applying them.**

Three paths must line up:

| Placeholder | Example | Meaning |
| --- | --- | --- |
| `<BUCKET_NAME>` | `my-bucket-name` | The S3 bucket that hosts the app and images |
| `<APP_PREFIX>` | `nexus/gallery` | Where the built `dist/` files are deployed |
| `<GALLERY_ROOT_PREFIX>` | `nexus/content/vol-97` | The image root configured as `rootPrefix` without the trailing slash |

These correspond to:

```js
// public/config.js
window.CONFIG = {
  bucketName: "my-bucket-name",
  rootPrefix: "nexus/content/vol-97/",
};
```

```js
// vite.config.js — relative base so the app works under any deploy prefix
export default defineConfig({
  base: "./",
});
```

### Bucket Policy

[`bucket_policy.json`](bucket_policy.json) is a template. It shows the required
permissions: the static app loads from `<APP_PREFIX>`, and the unsigned browser
client lists/reads objects under `<GALLERY_ROOT_PREFIX>`.

If you use `.env.local`, apply the generated `bucket_policy.local.json`
instead. That file has these placeholders already filled in.

Important mapping:

```json
"arn:aws:s3:::<BUCKET_NAME>/<APP_PREFIX>/*"
"arn:aws:s3:::<BUCKET_NAME>/<GALLERY_ROOT_PREFIX>/*"
```

Do not include leading or trailing slashes in `<APP_PREFIX>` or
`<GALLERY_ROOT_PREFIX>` inside the bucket policy.

Apply via AWS CLI:

```bash
aws s3api put-bucket-policy \
  --bucket my-bucket-name \
  --policy file://bucket_policy.local.json
```

Or in the AWS Console: **S3 → your bucket → Permissions → Bucket policy**.

### CORS Configuration

Apply the generated [`cors.local.xml`](cors.local.xml) so the browser can call the
S3 REST API from the gallery origin when you use `.env.local`. The template
[`cors.xml`](cors.xml) remains as the placeholder source for `npm run generate:env`.

```xml
<AllowedOrigin>https://my-bucket-name.s3.us-east-1.amazonaws.com</AllowedOrigin>
<AllowedOrigin>https://my-bucket-name.s3.dualstack.us-east-1.amazonaws.com</AllowedOrigin>
```

Apply via AWS CLI:

```bash
aws s3api put-bucket-cors \
  --bucket my-bucket-name \
  --cors-configuration file://cors.local.xml
```

Or in the AWS Console: **S3 → your bucket → Permissions → Cross-origin resource sharing (CORS)**.

## Features

| Feature | Notes |
| ------- | ----- |
| Folder & image thumbnails | Unified grid; folders show a preview of their first non-video item when possible |
| Video & animated media | mp4/webm in the lightbox via ArtPlayer; GIF/WebP show a static first frame in the grid |
| Lightbox | Full-screen viewer; the original fills the viewport (contained, longest edge touches the stage edge) |
| Floating caption | Filename, meta, and `N / total` counter pinned to the bottom, always visible (mobile included) |
| Copy original URL | Click the filename to copy the full original S3 URL to the clipboard |
| Rotate image | Rotate a photo 90° in the lightbox |
| Landscape video auto-rotate | On a phone held in portrait, a landscape video is rotated to fill the screen |
| Video mute / loop | Gallery toolbar next to Sort/Order; remembered in `localStorage`. `videoMuted` / `videoLoop` in `config.js` are first-visit defaults |
| Keyboard navigation | `←` / `→` in lightbox, `Esc` to close |
| Breadcrumb | Clickable path back to any parent folder |
| Dark / light theme | Toggled from the header; preference saved to `localStorage` |
| URL hash routing | `#photos/landscapes/` — shareable, supports browser back/forward |
| Virtual grid | Only visible rows are mounted, even in large folders |
| Lazy thumbnails | Tile images load as they scroll into view |
| Folder previews | Fetched lazily via `IntersectionObserver` |
| Loading skeleton | Shimmer placeholders while S3 responds |
| Sort | By name or last-modified date |
| S3 pagination | Follows `NextContinuationToken` for prefixes with > 1000 keys |
| Responsive | Auto-fill grid adapts from mobile to widescreen |

See [`DESIGN.md`](DESIGN.md) for the runtime architecture and memory model.

## Security

The `S3Client` is created with a **no-op signer** that passes every request
through unsigned:

```js
new S3Client({
  region: CONFIG.region,
  signer: { sign: async (request) => request },
});
```

No credentials, access keys, session tokens, Cognito, or STS calls are ever
made.  The bucket's public policy handles authorisation entirely.

## File layout after deployment

```text
s3://my-bucket-name/
├── nexus/
│   ├── gallery/                  ← <APP_PREFIX>
│   │   ├── index.html            ← gallery SPA entry point
│   │   ├── config.js             ← edit in-place without rebuilding
│   │   └── assets/               ← bundled JS + CSS
│   └── content/
│       └── vol-97/               ← <GALLERY_ROOT_PREFIX>
│           ├── landscapes/
│           └── portraits/
```

Use `rootPrefix: "nexus/content/vol-97/"` in `config.js` to scope the gallery
to the image folder. The app files live separately under `nexus/gallery/`, so
they do not appear as browsable gallery folders.
