# s3gallery

A static image gallery that browses images from a public S3 bucket using the
AWS SDK v3 with **anonymous (unsigned) requests** — no credentials required.

## Configuration

Edit [`public/config.js`](public/config.js) before building (or edit it
directly in S3 after deploying):

```js
window.CONFIG = {
  bucketName:      "my-bucket-name",   // your S3 bucket
  region:          "us-east-1",        // bucket's AWS region
  rootPrefix:      "",                 // "" = entire bucket; "photos/" = scope to subfolder
  title:           "My Gallery",
  imageKitEndpoint: "",                // optional ImageKit URL endpoint for thumbnails
  imageExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"],
};
```

`config.js` is **not bundled** — it is copied to `dist/` as-is and loaded via
a `<script>` tag at runtime.  After deploying, you can update just this file
in S3 without rebuilding:

```bash
aws s3 cp public/config.js s3://my-bucket-name/config.js
```

## Development

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build & Deploy

```bash
npm run build                                              # produces dist/
aws s3 sync ./dist s3://my-bucket-name/ --delete          # deploy
```

## S3 Bucket Setup

Before deploying, configure your bucket with the included policy and CORS files.
**Replace `my-bucket-name` with your actual bucket name in both files.**

### Bucket Policy

Apply [`bucket_policy.json`](bucket_policy.json) to allow public read access
and replication. Replace the `bucket` placeholder in the `Resource` ARNs:

```json
"Resource": [
  "arn:aws:s3:::my-bucket-name",
  "arn:aws:s3:::my-bucket-name/*"
]
```

Apply via AWS CLI:

```bash
aws s3api put-bucket-policy \
  --bucket my-bucket-name \
  --policy file://bucket_policy.json
```

Or in the AWS Console: **S3 → your bucket → Permissions → Bucket policy**.

### CORS Configuration

Apply [`cors.xml`](cors.xml) so the browser can call the S3 REST API from the
gallery origin. Replace the `bucket` placeholder in the `AllowedOrigin` lines
with your bucket name and region:

```xml
<AllowedOrigin>https://my-bucket-name.s3.us-east-1.amazonaws.com</AllowedOrigin>
<AllowedOrigin>https://my-bucket-name.s3.dualstack.us-east-1.amazonaws.com</AllowedOrigin>
```

Apply via AWS CLI:

```bash
aws s3api put-bucket-cors \
  --bucket my-bucket-name \
  --cors-configuration file://cors.xml
```

Or in the AWS Console: **S3 → your bucket → Permissions → Cross-origin resource sharing (CORS)**.

## Features

| Feature | Notes |
| ------- | ----- |
| Folder & image thumbnails | Unified grid; folders show a preview of their first image |
| Lightbox | Full-screen viewer with prev/next and caption |
| Keyboard navigation | `←` / `→` in lightbox, `Esc` to close |
| Breadcrumb | Clickable path back to any parent folder |
| Dark / light theme | Toggled from the header; preference saved to `localStorage` |
| URL hash routing | `#photos/landscapes/` — shareable, supports browser back/forward |
| Virtual grid | Only visible rows are mounted, even in large folders |
| Lazy thumbnails | Images load as they scroll into view |
| Folder previews | Fetched lazily via `IntersectionObserver` |
| Loading skeleton | Shimmer placeholders while S3 responds |
| Sort | By name or last-modified date |
| Pagination | Follows `NextContinuationToken` for buckets with > 1000 keys |
| Responsive | Auto-fill grid adapts from mobile to widescreen |

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
├── index.html          ← gallery SPA entry point
├── config.js           ← edit in-place without rebuilding
├── assets/             ← bundled JS + CSS (content-hashed filenames)
└── photos/             ← (example) your actual images
    ├── landscapes/
    └── portraits/
```

Use `rootPrefix: "photos/"` in `config.js` to scope the gallery to that
subfolder so it doesn't show `assets/` or `index.html` as folders.
