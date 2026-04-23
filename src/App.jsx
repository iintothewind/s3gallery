import { useState, useEffect, useCallback, useMemo } from "react";
import Gallery from "./components/Gallery.jsx";
import Breadcrumb from "./components/Breadcrumb.jsx";
import { cleanupOldEntries } from "./imageCache.js";

/**
 * Read the current hash as a decoded path string (e.g. "landscapes/2024/").
 * Each segment is separately decoded so slashes stay as path separators.
 */
function parseHash() {
  const raw = window.location.hash.slice(1); // strip leading #
  if (!raw) return "";
  return raw
    .split("/")
    .map((seg) => decodeURIComponent(seg))
    .join("/");
}

/**
 * Convert a hash-relative path back to a full S3 prefix by prepending rootPrefix.
 *
 *   rootPrefix=""        + path=""              → ""
 *   rootPrefix=""        + path="landscapes/"   → "landscapes/"
 *   rootPrefix="photos/" + path=""              → "photos/"
 *   rootPrefix="photos/" + path="landscapes/"   → "photos/landscapes/"
 */
function toS3Prefix(hashPath) {
  const rootPrefix = window.CONFIG.rootPrefix || "";
  if (!hashPath) return rootPrefix;
  const normalized = hashPath.endsWith("/") ? hashPath : hashPath + "/";
  return rootPrefix + normalized;
}

/**
 * Convert a full S3 prefix back to the hash-relative path by stripping rootPrefix.
 */
export function toHashPath(s3Prefix) {
  const rootPrefix = window.CONFIG.rootPrefix || "";
  if (rootPrefix && s3Prefix.startsWith(rootPrefix)) {
    return s3Prefix.slice(rootPrefix.length);
  }
  return s3Prefix;
}

export default function App() {
  const config = window.CONFIG;

  // Run once on page load to evict stale IndexedDB cache entries (>24 h old)
  useEffect(() => { cleanupOldEntries(); }, []);

  const [currentPath, setCurrentPath] = useState(parseHash);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("gallery-theme") || "dark"
  );

  // Apply theme to <html> so CSS vars kick in
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gallery-theme", theme);
  }, [theme]);

  // Update page title from config
  useEffect(() => {
    document.title = config.title || "Gallery";
  }, [config.title]);

  // Sync state with browser hash changes (back/forward buttons)
  useEffect(() => {
    const onHashChange = () => setCurrentPath(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigateTo = useCallback((hashPath) => {
    if (!hashPath) {
      window.location.hash = "";
    } else {
      const encoded = hashPath
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      window.location.hash = encoded;
    }
  }, []);

  const breadcrumbParts = useMemo(() =>
    currentPath ? currentPath.replace(/\/$/, "").split("/").filter(Boolean) : [],
    [currentPath]
  );

  const s3Prefix = toS3Prefix(currentPath);

  return (
    <div className="app">
      <header className="app-header">
        <h1
          className="app-title"
          onClick={() => navigateTo("")}
          style={{ cursor: "pointer" }}
        >
          {config.title}
        </h1>
        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </header>

      <Breadcrumb parts={breadcrumbParts} onNavigate={navigateTo} />

      <Gallery prefix={s3Prefix} onNavigate={navigateTo} />
    </div>
  );
}
