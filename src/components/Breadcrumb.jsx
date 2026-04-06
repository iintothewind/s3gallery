import React from "react";

/**
 * Clickable breadcrumb trail.
 *
 * parts: ["landscapes", "2024"]  →  Home / landscapes / 2024
 *
 * Clicking a segment navigates to that level by reconstructing the hash path
 * as "segment1/segment2/.../segmentN/".
 */
export default function Breadcrumb({ parts, onNavigate }) {
  const handleClick = (upToIndex) => {
    if (upToIndex < 0) {
      onNavigate("");
      return;
    }
    // Rebuild path up to and including this index, with trailing slash
    const path = parts.slice(0, upToIndex + 1).join("/") + "/";
    onNavigate(path);
  };

  return (
    <nav className="breadcrumb" aria-label="Folder path">
      <span
        className={`breadcrumb-item${parts.length === 0 ? " active" : ""}`}
        onClick={() => parts.length > 0 && handleClick(-1)}
        role={parts.length > 0 ? "button" : undefined}
        tabIndex={parts.length > 0 ? 0 : undefined}
        onKeyDown={(e) => e.key === "Enter" && parts.length > 0 && handleClick(-1)}
      >
        Home
      </span>

      {parts.map((part, idx) => {
        const isLast = idx === parts.length - 1;
        return (
          <React.Fragment key={idx}>
            <span className="breadcrumb-sep" aria-hidden="true"> / </span>
            <span
              className={`breadcrumb-item${isLast ? " active" : ""}`}
              onClick={() => !isLast && handleClick(idx)}
              role={!isLast ? "button" : undefined}
              tabIndex={!isLast ? 0 : undefined}
              onKeyDown={(e) => e.key === "Enter" && !isLast && handleClick(idx)}
            >
              {part}
            </span>
          </React.Fragment>
        );
      })}
    </nav>
  );
}
