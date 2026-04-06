# S3 Image Gallery

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
  imageExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"],
  pageSize:        50,                 // thumbnails before "Load more"
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

## S3 Bucket Requirements

The bucket must already have:

- **Static website hosting** enabled, **or** a CORS configuration that allows
  `GET` from the gallery's origin (see below).
- A **public bucket policy** granting `s3:GetObject` and `s3:ListBucket`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::my-bucket-name",
        "arn:aws:s3:::my-bucket-name/*"
      ]
    }
  ]
}
```

sample cfg:

```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <CORSRule>
      <ID>S3Drive</ID>
      <AllowedOrigin>*</AllowedOrigin>
      <AllowedOrigin>https://web.s3drive.app</AllowedOrigin>
      <AllowedOrigin>https://s3.amazonaws.com</AllowedOrigin>
      <AllowedOrigin>https://collov-nexus.s3.us-west-1.amazonaws.com</AllowedOrigin>
      <AllowedOrigin>https://collov-nexus.s3.dualstack.us-west-1.amazonaws.com</AllowedOrigin>
      <AllowedMethod>GET</AllowedMethod>
      <AllowedMethod>HEAD</AllowedMethod>
      <AllowedMethod>POST</AllowedMethod>
      <AllowedMethod>PUT</AllowedMethod>
      <AllowedMethod>DELETE</AllowedMethod>
      <MaxAgeSeconds>3600</MaxAgeSeconds>
      <ExposeHeader>etag</ExposeHeader>
      <ExposeHeader>x-amz-version-id</ExposeHeader>
      <ExposeHeader>x-amz-version-id</ExposeHeader>
      <ExposeHeader>x-amz-meta-mtime</ExposeHeader>
      <AllowedHeader>*</AllowedHeader>
    </CORSRule>
  </CORSConfiguration>
```

- A **CORS configuration** (required when the app is served from the S3
  website endpoint or a CDN, so the SDK can call the S3 REST API):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": []
  }
]
```

## Features

| Feature | Notes |
|---------|-------|
| Folder & image thumbnails | Unified grid; folders show a preview of their first image |
| Lightbox | Full-screen viewer with prev/next and caption |
| Keyboard navigation | `←` / `→` in lightbox, `Esc` to close |
| Breadcrumb | Clickable path back to any parent folder |
| Dark / light theme | Toggled from the header; preference saved to `localStorage` |
| URL hash routing | `#photos/landscapes/` — shareable, supports browser back/forward |
| Lazy thumbnails | Images load as they scroll into view (`loading="lazy"`) |
| Folder previews | Fetched lazily via `IntersectionObserver` |
| Loading skeleton | Shimmer placeholders while S3 responds |
| Sort | By name or last-modified date |
| Load more | Pagination with configurable `pageSize` |
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

```
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
