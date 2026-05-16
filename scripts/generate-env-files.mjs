import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const envPath = resolve(root, ".env.local");

function parseEnv(content) {
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function normalizePrefix(value, { trailingSlash = false } = {}) {
  const trimmed = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  return trailingSlash ? `${trimmed}/` : trimmed;
}

function numberValue(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function csvValue(env, key, fallback) {
  const raw = env[key];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsValue(value) {
  return JSON.stringify(value);
}

if (!existsSync(envPath)) {
  console.log("No .env.local found; leaving generated files unchanged.");
  process.exit(0);
}

const env = parseEnv(readFileSync(envPath, "utf8"));
const bucketName = env.S3GALLERY_BUCKET_NAME || "YOUR_BUCKET_NAME";
const region = env.S3GALLERY_REGION || "us-east-1";
const appPrefix = normalizePrefix(env.S3GALLERY_APP_PREFIX || "nexus/gallery");
const rootPrefix = normalizePrefix(env.S3GALLERY_ROOT_PREFIX || "", {
  trailingSlash: true,
});
const rootPrefixForPolicy = normalizePrefix(rootPrefix);
const adminPrincipal = env.S3GALLERY_ADMIN_PRINCIPAL ||
  (env.S3GALLERY_ADMIN_ACCOUNT_ID && env.S3GALLERY_ADMIN_ROLE_NAME
    ? `arn:aws:iam::${env.S3GALLERY_ADMIN_ACCOUNT_ID}:role/${env.S3GALLERY_ADMIN_ROLE_NAME}`
    : "arn:aws:iam::<ACCOUNT_ID>:role/<ADMIN_OR_REPLICATION_ROLE>");

const config = `/**
 * S3 Gallery configuration.
 *
 * Generated from .env.local by scripts/generate-env-files.mjs.
 * This file is intentionally loaded at runtime via index.html.
 */
window.CONFIG = {
  bucketName: ${jsValue(bucketName)},
  region: ${jsValue(region)},
  rootPrefix: ${jsValue(rootPrefix)},
  title: ${jsValue(env.S3GALLERY_TITLE || "S3Gallery")},
  imageKitEndpoint: ${jsValue(env.S3GALLERY_IMAGEKIT_ENDPOINT || "")},
  imageExtensions: ${jsValue(csvValue(env, "S3GALLERY_IMAGE_EXTENSIONS", [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".bmp",
    ".svg",
  ]))},
  thumbnailWidths: ${jsValue(csvValue(env, "S3GALLERY_THUMBNAIL_WIDTHS", [
    "240",
    "360",
    "480",
    "640",
  ]).map(Number).filter(Number.isFinite))},
  thumbnailQuality: ${numberValue(env, "S3GALLERY_THUMBNAIL_QUALITY", 80)},
  thumbnailMaxBytes: ${numberValue(env, "S3GALLERY_THUMBNAIL_MAX_BYTES", 2.5 * 1024 * 1024)},
  thumbnailMaxWidth: ${numberValue(env, "S3GALLERY_THUMBNAIL_MAX_WIDTH", 2560)},
  thumbnailMaxHeight: ${numberValue(env, "S3GALLERY_THUMBNAIL_MAX_HEIGHT", 2560)},
  localThumbnailMaxSize: ${numberValue(env, "S3GALLERY_LOCAL_THUMBNAIL_MAX_SIZE", 480)},
  localThumbnailQuality: ${numberValue(env, "S3GALLERY_LOCAL_THUMBNAIL_QUALITY", 0.8)},
  localThumbnailConcurrency: ${numberValue(env, "S3GALLERY_LOCAL_THUMBNAIL_CONCURRENCY", 2)},
  cacheMaxEntries: ${numberValue(env, "S3GALLERY_CACHE_MAX_ENTRIES", 2000)},
};
`;

const listPrefixes = rootPrefixForPolicy
  ? [`${rootPrefixForPolicy}/`, `${rootPrefixForPolicy}/*`]
  : ["", "*"];

const galleryObjectResource = rootPrefixForPolicy
  ? `arn:aws:s3:::${bucketName}/${rootPrefixForPolicy}/*`
  : `arn:aws:s3:::${bucketName}/*`;

const policy = {
  Version: "2012-10-17",
  Id: "PolicyForDestinationBucket",
  Statement: [
    {
      Sid: "AdminAccess",
      Effect: "Allow",
      Principal: {
        AWS: adminPrincipal,
      },
      Action: [
        "s3:GetBucketVersioning",
        "s3:GetObjectAcl",
        "s3:GetObject",
        "s3:ReplicateObject",
        "s3:ReplicateDelete",
        "s3:PutObjectAcl",
        "s3:PutObjectVersionAcl",
        "s3:PutBucketVersioning",
        "s3:ObjectOwnerOverrideToBucketOwner",
        "s3:DeleteObject",
        "s3:Put*",
        "s3:List*",
      ],
      Resource: [
        `arn:aws:s3:::${bucketName}`,
        `arn:aws:s3:::${bucketName}/*`,
      ],
    },
    {
      Sid: "PublicReadAppShell",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: [
        `arn:aws:s3:::${bucketName}/${appPrefix}/*`,
      ],
    },
    {
      Sid: "PublicListGalleryPrefix",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${bucketName}`,
      Condition: {
        StringLike: {
          "s3:prefix": listPrefixes,
        },
      },
    },
    {
      Sid: "PublicReadGalleryObjects",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: galleryObjectResource,
    },
  ],
};

writeFileSync(resolve(root, "public/config.js"), config);
writeFileSync(
  resolve(root, "bucket_policy.local.json"),
  `${JSON.stringify(policy, null, 2)}\n`,
);

console.log("Generated public/config.js and bucket_policy.local.json from .env.local.");
