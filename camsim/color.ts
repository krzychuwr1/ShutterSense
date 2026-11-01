// Colour helpers: sRGB <-> linear and the colour of light by colour temperature.

import type { RGB } from "./paint.ts";

export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export const luma = (c: RGB | Float32Array, i = 0) => 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2];

const cache = new Map<number, RGB>();

/**
 * Linear RGB of a black body at `kelvin`, normalised to luminance 1. Uses a
 * well-known curve fit of the Planckian locus in sRGB (good from 1000 K to 40000 K).
 */
export function illuminant(kelvin: number): RGB {
  const k = Math.round(Math.max(1000, Math.min(40000, kelvin)) / 10) * 10;
  const hit = cache.get(k);
  if (hit) return hit;
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  const lin: RGB = [r, g, b].map((v) => toLinear(Math.max(0, Math.min(255, v)) / 255)) as RGB;
  const y = luma(lin);
  const out: RGB = [lin[0] / y, lin[1] / y, lin[2] / y];
  cache.set(k, out);
  return out;
}
