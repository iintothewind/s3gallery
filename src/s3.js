import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { buildSrc } from "@imagekit/react";

/**
 * Returns a singleton S3Client that sends UNSIGNED requests.
 *
 * The no-op signer `{ sign: async (req) => req }` tells the SDK to skip
 * request signing entirely, so no credentials are ever needed or sent.
 * The bucket must allow public s3:ListBucket + s3:GetObject.
 */
let _client = null;

function getClient() {
  if (_client) return _client;
  const { region } = window.CONFIG;
  _client = new S3Client({
    region,
    // Dummy credentials satisfy the SDK's credential-resolution check in the
    // browser (no env vars / config files are available). The no-op signer
    // then passes the request through without adding an Authorization header,
    // so the request reaches S3 unsigned — which works for public buckets.
    credentials: { accessKeyId: "UNSIGNED", secretAccessKey: "UNSIGNED" },
    signer: { sign: async (request) => request },
  });
  return _client;
}

/**
 * Returns true if the S3 key looks like an image based on CONFIG.imageExtensions.
 */
export function isImage(key) {
  const lower = key.toLowerCase();
  return window.CONFIG.imageExtensions.some((ext) => lower.endsWith(ext));
}

/**
 * Constructs the public HTTPS URL for an S3 object key.
 * Use this as <img src="..."> — no SDK call needed just to display an image.
 */
export function getImageUrl(key) {
  const { bucketName, region } = window.CONFIG;
  // Encode each path segment but keep slashes intact
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  // If the app is served from any S3 hostname for this bucket (e.g. the
  // dualstack variant), reuse that origin so image requests go to the same
  // host and avoid CORS mismatches.
  const { origin, hostname } = window.location;
  if (hostname.startsWith(`${bucketName}.s3`)) {
    return `${origin}/${encodedKey}`;
  }
  return `https://${bucketName}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function encodeKeyPath(key) {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function getImageKitEndpoint() {
  const endpoint = (window.CONFIG.imageKitEndpoint || "").trim();
  return endpoint ? endpoint.replace(/\/+$/, "") + "/" : "";
}

function toImageKitPath(key) {
  const rootPrefix = window.CONFIG.rootPrefix || "";
  const relativeKey = rootPrefix && key.startsWith(rootPrefix)
    ? key.slice(rootPrefix.length)
    : key;

  return `/${encodeKeyPath(relativeKey.replace(/^\/+/, ""))}`;
}

export function hasImageKitEndpoint() {
  return getImageKitEndpoint().length > 0;
}

export function getImageKitThumbnailUrl(key, width = 480) {
  const endpoint = getImageKitEndpoint();
  if (!endpoint) return null;

  const quality = window.CONFIG.thumbnailQuality ?? 80;
  return buildSrc({
    urlEndpoint: endpoint,
    src: toImageKitPath(key),
    transformation: [{ width, quality }],
    transformationPosition: "path",
  });
}

export function getImageKitThumbnailSrcSet(key) {
  const widths = window.CONFIG.thumbnailWidths || [240, 360, 480, 640];
  const srcset = widths
    .map((width) => {
      const url = getImageKitThumbnailUrl(key, width);
      return url ? `${url} ${width}w` : null;
    })
    .filter(Boolean)
    .join(", ");
  return srcset || null;
}

/**
 * Lists immediate subfolders and image files under `prefix`.
 *
 * Uses Delimiter="/" so the response contains:
 *   CommonPrefixes → subfolders  (one level deep only)
 *   Contents       → objects at this level
 *
 * Follows NextContinuationToken to handle buckets with >1000 keys.
 *
 * @param {string} prefix  e.g. "" for root, "photos/landscapes/" for a subfolder
 * @returns {{ folders: string[], images: Array<{key,lastModified,size}> }}
 */
export async function listObjects(prefix, signal) {
  const client = getClient();
  const { bucketName } = window.CONFIG;

  const folders = [];
  const images = [];
  let continuationToken = undefined;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      Delimiter: "/",
      MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    });

    const resp = await client.send(cmd, signal ? { abortSignal: signal } : undefined);

    for (const cp of resp.CommonPrefixes ?? []) {
      if (cp.Prefix) folders.push(cp.Prefix);
    }

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue; // skip the prefix itself
      if (isImage(obj.Key)) {
        images.push({ key: obj.Key, lastModified: obj.LastModified, size: obj.Size });
      }
    }

    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  return { folders, images };
}

