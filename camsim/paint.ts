// Layers of premultiplied linear radiance plus coverage, so they can be
// blurred and composited physically, and a small anti-aliased painter for
// shapes given as signed distance functions in pixel units.

export interface Layer {
  w: number;
  h: number;
  /** Premultiplied linear radiance, 3 floats per pixel. */
  rgb: Float32Array;
  /** Coverage 0..1. */
  a: Float32Array;
}

export type RGB = [number, number, number];
export type Paint = RGB | ((x: number, y: number) => RGB);

export interface Shape {
  sdf: (x: number, y: number) => number;
  /** x0, y0, x1, y1 in pixels; painting is limited to this box. */
  bounds: [number, number, number, number];
}

export function newLayer(w: number, h: number): Layer {
  return { w, h, rgb: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const len = (x: number, y: number) => Math.sqrt(x * x + y * y);

/** Ellipse, optionally rotated by `rot` radians. The distance is approximate but smooth. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0): Shape {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const m = Math.max(rx, ry);
  return {
    sdf: (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * c + dy * s) / rx;
      const v = (-dx * s + dy * c) / ry;
      const k = len(u, v);
      // Gradient-normalised distance keeps edges equally soft all round.
      const g = len(u / rx, v / ry);
      return k < 1e-6 ? -Math.min(rx, ry) : ((k - 1) * k) / Math.max(g, 1e-6);
    },
    bounds: [cx - m, cy - m, cx + m, cy + m],
  };
}

export interface FillOpts {
  /** Edge softness in pixels (1 = crisp anti-aliasing). */
  feather?: number;
  opacity?: number;
}

/** Paints `shape` over the layer (premultiplied "over"). */
export function fill(layer: Layer, shape: Shape, paint: Paint, opts: FillOpts = {}) {
  const feather = Math.max(0.5, opts.feather ?? 1);
  const opacity = opts.opacity ?? 1;
  const pad = Math.ceil(feather);
  const x0 = Math.max(0, Math.floor(shape.bounds[0]) - pad);
  const y0 = Math.max(0, Math.floor(shape.bounds[1]) - pad);
  const x1 = Math.min(layer.w, Math.ceil(shape.bounds[2]) + pad);
  const y1 = Math.min(layer.h, Math.ceil(shape.bounds[3]) + pad);
  const solid = typeof paint === "function" ? null : paint;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = shape.sdf(px, py);
      const cov = clamp01(0.5 - d / feather);
      if (cov <= 0) continue;
      const k = cov * opacity;
      const c = solid ?? (paint as (x: number, y: number) => RGB)(px, py);
      const i = y * layer.w + x;
      const j = i * 3;
      layer.rgb[j] = layer.rgb[j] * (1 - k) + c[0] * k;
      layer.rgb[j + 1] = layer.rgb[j + 1] * (1 - k) + c[1] * k;
      layer.rgb[j + 2] = layer.rgb[j + 2] * (1 - k) + c[2] * k;
      layer.a[i] = layer.a[i] * (1 - k) + k;
    }
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
