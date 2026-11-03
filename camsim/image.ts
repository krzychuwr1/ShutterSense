// 8-bit RGBA helpers for the camera's image pipeline: cropping to an aspect
// ratio or a zoomed area, resizing to the recorded image size, thumbnails,
// and the histogram the live view reports.

export interface Rgba {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function crop(img: Rgba, r: Rect): Rgba {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.min(img.w - x0, Math.round(r.w)));
  const h = Math.max(1, Math.min(img.h - y0, Math.round(r.h)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, rgba: out };
}

/**
 * Resize to `w` × `h`: area averaging when shrinking, bilinear when
 * enlarging (the zoomed live view).
 */
export function resize(img: Rgba, w: number, h: number): Rgba {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === img.w && h === img.h) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.w / w;
  const sy = img.h / h;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(img.h, Math.floor((y + 1) * sy)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(img.w, Math.floor((x + 1) * sx)));
        let r = 0, g = 0, b = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * img.w + xx) * 4;
            r += img.rgba[i];
            g += img.rgba[i + 1];
            b += img.rgba[i + 2];
          }
        }
        const n = (y1 - y0) * (x1 - x0);
        const o = (y * w + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = 255;
      }
    }
    return { w, h, rgba: out };
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.w - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = img.rgba[(y0 * img.w + x0) * 4 + c] * (1 - tx) + img.rgba[(y0 * img.w + x1) * 4 + c] * tx;
        const b = img.rgba[(y1 * img.w + x0) * 4 + c] * (1 - tx) + img.rgba[(y1 * img.w + x1) * 4 + c] * tx;
        out[o + c] = a * (1 - ty) + b * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { w, h, rgba: out };
}

/** Pixel counts per level: luminance (Rec. 709 weights), red, green, blue; 256 bins each. */
export function histogram(img: Rgba): number[][] {
  const hist = [0, 1, 2, 3].map(() => new Array<number>(256).fill(0));
  for (let i = 0; i < img.w * img.h; i++) {
    const r = img.rgba[i * 4];
    const g = img.rgba[i * 4 + 1];
    const b = img.rgba[i * 4 + 2];
    hist[0][Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b))]++;
    hist[1][r]++;
    hist[2][g]++;
    hist[3][b]++;
  }
  return hist;
}
