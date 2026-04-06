/**
 * Parses image pixel dimensions from a partial buffer.
 *
 * A 64 KB slice is recommended — enough to cover JPEG files with large
 * EXIF/APP1 blocks (common in camera photos) before the SOF marker.
 *
 * Supported formats:
 *   PNG   — IHDR chunk is always at a fixed offset (bytes 16–23).
 *   JPEG  — walks segment markers to find the first SOF marker.
 *           EXIF (APP1) blocks can be 60 KB+, so 4 KB is often not enough.
 *   WebP  — handles VP8 (lossy), VP8X (extended), and VP8L (lossless).
 *
 * Returns { width, height } or null if the format is unrecognised or the
 * relevant header bytes aren't present in the supplied buffer.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ width: number, height: number } | null}
 */
export function parseDimensions(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length < 12) return null;

  // ── PNG ──────────────────────────────────────────────────────────────────────
  // Signature: 89 50 4E 47 0D 0A 1A 0A  (‌\x89PNG\r\n\x1a\n)
  // IHDR chunk immediately follows: [4 len][4 "IHDR"][4 width][4 height]
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return null;
    const width  = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const height = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // ── WebP ─────────────────────────────────────────────────────────────────────
  // Header: "RIFF" [4-byte LE size] "WEBP" [chunk-fourcc] [4-byte LE chunk-size] …
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50   // "WEBP"
  ) {
    if (b.length < 16) return null;
    const c0 = b[12], c1 = b[13], c2 = b[14], c3 = b[15];

    // VP8X (extended) — canvas size is at bytes 24–29 (24-bit LE, value + 1)
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x58) { // "VP8X"
      if (b.length < 30) return null;
      const width  = ((b[24] | (b[25] << 8) | (b[26] << 16)) >>> 0) + 1;
      const height = ((b[27] | (b[28] << 8) | (b[29] << 16)) >>> 0) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // VP8 (lossy) — bitstream starts at byte 20; start code at +3..+5
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x20) { // "VP8 "
      if (b.length < 30) return null;
      // Start code: 0x9D 0x01 0x2A
      if (b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        const width  = (b[26] | (b[27] << 8)) & 0x3fff;
        const height = (b[28] | (b[29] << 8)) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : null;
      }
    }

    // VP8L (lossless) — dimensions are packed into a 28-bit bitfield starting
    // at byte 21 (after the 0x2F signature byte). Each field is 14 bits (value+1).
    if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x4c) { // "VP8L"
      if (b.length < 25) return null;
      // Byte 20 is the 0x2F signature; dimensions start at byte 21.
      if (b[20] === 0x2f) {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        const width  = (bits & 0x3fff) + 1;
        const height = ((bits >>> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
    }

    return null;
  }

  // ── JPEG ─────────────────────────────────────────────────────────────────────
  // SOI: FF D8.  Walk segments to find a Start-Of-Frame (SOF) marker:
  //   FF Cx  [2-byte length including itself]  [1-byte precision]
  //          [2-byte height]  [2-byte width]
  //
  // SOF markers: C0–C3, C5–C7, C9–CB, CD–CF
  // (C4=DHT, C8=reserved/ext, CC=DAC are NOT dimension markers)
  //
  // Important: EXIF/APP1 blocks (marker FF E1) on DSLR photos can be 20–80 KB.
  // 64 KB is enough to reach the SOF in virtually all real-world JPEG files.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < b.length) {
      // Skip any padding 0xFF bytes
      if (b[i] !== 0xff) break;
      while (i < b.length && b[i] === 0xff) i++;
      if (i >= b.length) break;

      const marker = b[i];
      i++; // advance past the marker byte

      // Markers with no length field: SOI, EOI, RST0-RST7, TEM
      if (marker === 0xd8 || marker === 0xd9 ||
          (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }

      // Need 2 bytes for the length field
      if (i + 1 >= b.length) break;
      const segLen = (b[i] << 8) | b[i + 1]; // includes the 2 length bytes
      if (segLen < 2) break;

      // SOF marker?
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        // Layout: [2 len][1 precision][2 height][2 width]
        if (i + 6 >= b.length) return null;
        const height = (b[i + 3] << 8) | b[i + 4];
        const width  = (b[i + 5] << 8) | b[i + 6];
        return width > 0 && height > 0 ? { width, height } : null;
      }

      i += segLen; // skip to next segment
    }
  }

  return null; // format unsupported or header not present in the buffer slice
}
