// Brightness numbers for a decoded RGBA image, identical on every platform
// (the Android app computes the same ones in Kotlin).

import type { ImageStats } from "./camera-tools.ts";

export function imageStats(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): ImageStats {
  let sum = 0, center = 0, centerN = 0, hi = 0, lo = 0;
  const x0 = Math.floor(w / 3), x1 = Math.floor((2 * w) / 3);
  const y0 = Math.floor(h / 3), y1 = Math.floor((2 * h) / 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      sum += l;
      if (l >= 250) hi++;
      if (l <= 6) lo++;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        center += l;
        centerN++;
      }
    }
  }
  const n = w * h || 1;
  const pct = (v: number) => Math.round((v / n) * 1000) / 10;
  return { mean: Math.round(sum / n), center: Math.round(center / (centerN || 1)), highlights: pct(hi), shadows: pct(lo) };
}
