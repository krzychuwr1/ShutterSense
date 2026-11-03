// Renders a scene through a virtual lens and sensor: depth of field from the
// thin-lens model, subject motion and hand shake over the exposure time,
// flash light falling off with distance, exposure in physical units, sensor
// noise that grows with ISO, highlight clipping, white balance (with shift),
// a picture style with its detail parameters, then 8-bit sRGB or Adobe RGB.
// Flickering lights are sampled row by row as the shutter crosses the frame
// (see flicker.ts).

import { illuminant, toSrgb } from "./color.ts";
import { rowGains, type ShutterTiming } from "./flicker.ts";
import { rng, type Layer, type RGB } from "./paint.ts";
import { depthAt, type Scene, type SceneLayer } from "./scenes.ts";

/** Full-frame sensor width in mm. */
const SENSOR_W = 36;
/** Electrons at saturation at ISO 100. Lower = noisier at high ISO. */
const FULL_WELL = 12000;
const READ_NOISE = 4;
const MAX_BLUR_SIGMA = 40;

export interface RenderOpts {
  /** Output width; rendered at the scene width divided by the nearest whole number. */
  w: number;
  /** f-number, seconds, ISO. */
  N: number;
  t: number;
  iso: number;
  /** Aperture used for depth of field. */
  dofN: number;
  /** Focus distance in metres. */
  focus: number;
  /** White balance colour temperature the camera applies. */
  wbK: number;
  pictureStyle: string;
  /** Picture style detail; without it the style's plain look, unsharpened. */
  styleDetail?: StyleDetail;
  /** The light colour to neutralise (a custom white balance reading); overrides wbK. */
  wbRgb?: RGB;
  /** White balance shift in steps: blue (-) / amber (+), magenta (-) / green (+). */
  wbShift?: { ba: number; mg: number };
  colorSpace?: "srgb" | "adobe_rgb";
  /** Flash output reaching the scene, as a guide number (metres at ISO 100) after power control. */
  flash?: { gn: number };
  /** Rolling shutter: time the sensor takes to read out top to bottom, seconds (0 = mechanical). */
  readout?: number;
  /**
   * How the shutter samples flickering lights (when and how fast it crosses
   * the frame), and `gain`: an exposure correction the camera applies (anti-flicker
   * shooting exposes for the light's peak, not its mean). Without it, lights are steady.
   */
  flicker?: ShutterTiming & { gain?: number };
  /** Focus stacking: more focus distances; each layer is as sharp as its best one. */
  focusStack?: number[];
  /** Also return the sensor data (after exposure and noise, before white balance). */
  linear?: boolean;
  /**
   * HDR Mode (set by hand in the camera's menus): three exposures merged
   * into one. "auto" fits the scene's range; a number is the bracket in
   * stops (1-3). Without it, one ordinary exposure.
   */
  hdr?: "auto" | number;
  /** Scene clock in seconds: where moving subjects are. */
  time: number;
  /** Blur moving subjects over the exposure time. */
  motionBlur: boolean;
  /** Hand shake: angular speed in degrees per second (0 = tripod / live view). */
  shake: number;
  seed: number;
}

export interface Rendered {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  /** Linear sensor RGB, 3 floats per pixel, 1.0 = saturation (when asked for). */
  linear?: Float32Array;
  /** Per-channel white balance gains that were applied. */
  wbGains: RGB;
}

/** Picture style detail parameters, as the camera's API names them. */
export interface StyleDetail {
  sharpness_strength: number;
  sharpness_fineness: number;
  sharpness_threshold: number;
  contrast: number;
  saturation?: number;
  colortone?: number;
  filtereffect?: string;
  toningeffect?: string;
}

// ------------------------------------------------------------------ layers at a size

const scaled = new WeakMap<Layer, Map<number, Layer>>();

/** The layer box-downsampled by `factor` (cached). */
function layerAt(sl: SceneLayer, factor: number): Layer {
  if (factor === 1) return sl.layer;
  let sizes = scaled.get(sl.layer);
  if (!sizes) scaled.set(sl.layer, (sizes = new Map()));
  const hit = sizes.get(factor);
  if (hit) return hit;
  const src = sl.layer;
  const w = Math.floor(src.w / factor);
  const h = Math.floor(src.h / factor);
  const out: Layer = { w, h, rgb: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = (y * factor + dy) * src.w + x * factor + dx;
          r += src.rgb[i * 3];
          g += src.rgb[i * 3 + 1];
          b += src.rgb[i * 3 + 2];
          a += src.a[i];
        }
      }
      const o = y * w + x;
      out.rgb[o * 3] = r / n;
      out.rgb[o * 3 + 1] = g / n;
      out.rgb[o * 3 + 2] = b / n;
      out.a[o] = a / n;
    }
  }
  sizes.set(factor, out);
  return out;
}

/** Where a moving layer is at `time`: pixel offset (scene units) and direction. */
export function motionAt(sl: SceneLayer, time: number): { dx: number; dir: 1 | -1 } {
  if (!sl.motion) return { dx: 0, dir: 1 };
  const [r0, r1] = sl.motion.range;
  const span = r1 - r0;
  const phase = (((time * sl.motion.speed) % (2 * span)) + 2 * span) % (2 * span);
  return phase < span ? { dx: r0 + phase, dir: 1 } : { dx: r1 - (phase - span), dir: -1 };
}

/**
 * A moving layer placed at its current position (and mirrored when running
 * the other way). With a rolling shutter each row is read a little later
 * than the one above, so a moving subject leans.
 */
function placed(l: Layer, sl: SceneLayer, time: number, factor: number, readout = 0): Layer {
  if (!sl.motion) return l;
  const { dx, dir } = motionAt(sl, time);
  const pivot = sl.motion.pivotX / factor;
  const out: Layer = { w: l.w, h: l.h, rgb: new Float32Array(l.rgb.length), a: new Float32Array(l.a.length) };
  for (let y = 0; y < l.h; y++) {
    const off = Math.round((dx + dir * sl.motion.speed * readout * (y / l.h)) / factor);
    for (let x = 0; x < l.w; x++) {
      const u = x - off;
      const sx = dir === 1 ? u : Math.round(2 * pivot - u);
      if (sx < 0 || sx >= l.w) continue;
      const i = y * l.w + x;
      const j = y * l.w + sx;
      out.a[i] = l.a[j];
      out.rgb[i * 3] = l.rgb[j * 3];
      out.rgb[i * 3 + 1] = l.rgb[j * 3 + 1];
      out.rgb[i * 3 + 2] = l.rgb[j * 3 + 2];
    }
  }
  return out;
}

// ------------------------------------------------------------------ blurs

/** One horizontal or vertical box pass of radius r over 4 interleaved planes (r, g, b, a). */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride + c] = sum * norm;
        const add = Math.min(len - 1, i + r + 1);
        const sub = Math.max(0, i - r);
        sum += src[base + add * stride + c] - src[base + sub * stride + c];
      }
    }
  }
}

/** Gaussian blur (three box passes each way) of a premultiplied RGBA buffer, in place. */
function gaussian(buf: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.4) return;
  sigma = Math.min(sigma, MAX_BLUR_SIGMA);
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  const r = Math.max(1, Math.round((ideal - 1) / 2));
  const tmp = new Float32Array(buf.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(buf, tmp, w, h, r, true);
    boxPass(tmp, buf, w, h, r, false);
  }
}

/**
 * Blur that changes down the frame (a ground plane: near rows blur more than
 * far ones): the buffer is blurred at a few levels and each row mixes the two
 * levels around its own sigma.
 */
function gaussianByRow(buf: Float32Array, w: number, h: number, rowSigma: Float32Array) {
  let lo = Infinity, hi = 0;
  for (const s of rowSigma) {
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  hi = Math.min(hi, MAX_BLUR_SIGMA);
  if (hi - lo < 0.5) return gaussian(buf, w, h, (lo + hi) / 2);
  const levels = [lo];
  while (levels[levels.length - 1] < hi) levels.push(Math.min(hi, Math.max(levels[levels.length - 1] * 1.5, levels[levels.length - 1] + 1)));
  const out = new Float32Array(buf.length);
  const tmp = new Float32Array(buf.length);
  const row = w * 4;
  for (let j = 0; j < levels.length; j++) {
    tmp.set(buf);
    gaussian(tmp, w, h, levels[j]);
    for (let y = 0; y < h; y++) {
      const s = Math.min(rowSigma[y], hi);
      let wt = 0;
      if (j > 0 && s > levels[j - 1] && s <= levels[j]) wt = (s - levels[j - 1]) / (levels[j] - levels[j - 1]);
      else if (j < levels.length - 1 && s >= levels[j] && s < levels[j + 1]) wt = (levels[j + 1] - s) / (levels[j + 1] - levels[j]);
      else if (s === levels[j]) wt = 1;
      if (!wt) continue;
      for (let i = y * row; i < (y + 1) * row; i++) out[i] += tmp[i] * wt;
    }
  }
  buf.set(out);
}

/** Horizontal smear of `length` pixels (subject motion). */
function smear(buf: Float32Array, w: number, h: number, length: number) {
  if (length < 0.8) return;
  const r = Math.max(1, Math.round(length / 2));
  const tmp = new Float32Array(buf.length);
  boxPass(buf, tmp, w, h, r, true);
  buf.set(tmp);
}

/** Smear along an angle by `length` pixels (hand shake), on an RGB buffer. */
function lineBlur(rgb: Float32Array, w: number, h: number, length: number, angle: number) {
  if (length < 0.8) return;
  const taps = Math.min(48, Math.ceil(length) + 1);
  const dx = Math.cos(angle) * length;
  const dy = Math.sin(angle) * length;
  const out = new Float32Array(rgb.length);
  for (let t = 0; t < taps; t++) {
    const f = taps === 1 ? 0 : t / (taps - 1) - 0.5;
    const ox = Math.round(dx * f);
    const oy = Math.round(dy * f);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(h - 1, Math.max(0, y + oy));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x + ox));
        const i = (y * w + x) * 3;
        const j = (sy * w + sx) * 3;
        out[i] += rgb[j];
        out[i + 1] += rgb[j + 1];
        out[i + 2] += rgb[j + 2];
      }
    }
  }
  for (let i = 0; i < out.length; i++) rgb[i] = out[i] / taps;
}

// ------------------------------------------------------------------ optics

/** Blur circle diameter on the sensor (mm) for an object at `d` m with focus at `s` m. */
export function blurCircleMm(focal: number, N: number, s: number, d: number): number {
  const f = focal;
  const S = Math.max(s * 1000, f * 1.01);
  const D = d * 1000;
  return ((f * f) / (N * (S - f))) * (Math.abs(D - S) / D);
}

/** Flash colour: a speedlite is close to daylight. */
const FLASH_RGB = illuminant(5600);

type CompositeOpts = Pick<RenderOpts, "w" | "dofN" | "focus" | "time" | "motionBlur" | "t" | "flash" | "readout" | "focusStack" | "flicker"> & { blur?: boolean };

/** Composite of all layers at output size, in linear radiance (no exposure applied). */
export function composite(scene: Scene, o: CompositeOpts): { rgb: Float32Array; w: number; h: number } {
  const factor = Math.max(1, Math.round(scene.w / o.w));
  const w = Math.floor(scene.w / factor);
  const h = Math.floor(scene.h / factor);
  const acc = new Float32Array(w * h * 3);
  const blur = o.blur ?? true;
  const focuses = [o.focus, ...(o.focusStack ?? [])];
  for (const sl of scene.layers) {
    const l = placed(layerAt(sl, factor), sl, o.time, factor, o.readout);
    const buf = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      buf[i * 4] = l.rgb[i * 3];
      buf[i * 4 + 1] = l.rgb[i * 3 + 1];
      buf[i * 4 + 2] = l.rgb[i * 3 + 2];
      buf[i * 4 + 3] = l.a[i];
    }
    if (o.flash && o.flash.gn > 0 && o.t > 0) addFlash(buf, sl, w, h, factor, o.flash.gn, o.t);
    if (blur) {
      // Blur circle for the nearest of the focus distances (just one unless stacking).
      const coc = (d: number) => Math.min(...focuses.map((f) => blurCircleMm(scene.lens.focal, o.dofN, f, d)));
      const sigma = (d: number) => ((coc(d) / SENSOR_W) * w) / 2.6;
      if (sl.ground) gaussianByRow(buf, w, h, Float32Array.from({ length: h }, (_, y) => sigma(depthAt(sl, (y + 0.5) / h))));
      else gaussian(buf, w, h, sigma(sl.depth));
      if (o.motionBlur && sl.motion) smear(buf, w, h, (sl.motion.speed / factor) * o.t);
    }
    // Flicker acts on the image as it falls on the sensor: row by row, after the lens blur.
    if (o.flicker && sl.flicker && o.t > 0) {
      const g = rowGains(sl.flicker.light, o.flicker, o.t, h);
      const share = sl.flicker.share;
      for (let y = 0; y < h; y++) {
        const kr = 1 - share + share * g[y * 3];
        const kg = 1 - share + share * g[y * 3 + 1];
        const kb = 1 - share + share * g[y * 3 + 2];
        for (let i = y * w * 4; i < (y + 1) * w * 4; i += 4) {
          buf[i] *= kr;
          buf[i + 1] *= kg;
          buf[i + 2] *= kb;
        }
      }
    }
    for (let i = 0; i < w * h; i++) {
      const a = buf[i * 4 + 3];
      acc[i * 3] = buf[i * 4] + acc[i * 3] * (1 - a);
      acc[i * 3 + 1] = buf[i * 4 + 1] + acc[i * 3 + 1] * (1 - a);
      acc[i * 3 + 2] = buf[i * 4 + 2] + acc[i * 3 + 2] * (1 - a);
    }
  }
  return { rgb: acc, w, h };
}

/**
 * Adds flash light to a layer. The light reaching a surface falls off with
 * the square of its distance; a surface reflects it in its own colour, which
 * is recovered from the layer's ambient lighting. Expressed as radiance over
 * the exposure time so the normal exposure maths applies: a mid-grey at
 * distance gn / N comes out mid-grey, as a guide number promises.
 */
function addFlash(buf: Float32Array, sl: SceneLayer, w: number, h: number, factor: number, gn: number, t: number) {
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sl.light.length - 1, Math.floor((y + 0.5) * factor));
    const d = Math.max(0.3, depthAt(sl, (y + 0.5) / h));
    const k = (gn / d) ** 2 / t / sl.light[sy];
    const kr = (k * FLASH_RGB[0]) / sl.tint[0];
    const kg = (k * FLASH_RGB[1]) / sl.tint[1];
    const kb = (k * FLASH_RGB[2]) / sl.tint[2];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] += buf[i] * kr;
      buf[i + 1] += buf[i + 1] * kg;
      buf[i + 2] += buf[i + 2] * kb;
    }
  }
}

// ------------------------------------------------------------------ picture styles

interface Style { contrast: number; saturation: number; warmth: number; mono?: boolean }

export const PICTURE_STYLES: Record<string, Style> = {
  auto: { contrast: 1.1, saturation: 1.15, warmth: 0 },
  standard: { contrast: 1.1, saturation: 1.12, warmth: 0 },
  portrait: { contrast: 1.0, saturation: 1.05, warmth: 0.03 },
  landscape: { contrast: 1.15, saturation: 1.35, warmth: 0 },
  finedetail: { contrast: 1.08, saturation: 1.1, warmth: 0 },
  neutral: { contrast: 0.92, saturation: 0.9, warmth: 0 },
  faithful: { contrast: 0.95, saturation: 0.95, warmth: 0 },
  monochrome: { contrast: 1.15, saturation: 0, warmth: 0, mono: true },
};

/** Luminance weights of the monochrome filter effects (like colour filters on black-and-white film). */
const MONO_FILTERS: Record<string, RGB> = {
  none: [0.2126, 0.7152, 0.0722],
  yellow: [0.36, 0.6, 0.04],
  orange: [0.5, 0.46, 0.04],
  red: [0.72, 0.28, 0],
  green: [0.12, 0.83, 0.05],
};

/** Toning of monochrome images, as channel multipliers. */
const TONING: Record<string, RGB> = {
  none: [1, 1, 1],
  sepia: [1.08, 0.98, 0.82],
  blue: [0.88, 0.97, 1.12],
  purple: [1.04, 0.9, 1.1],
  green: [0.9, 1.06, 0.9],
};

/** Linear sRGB to linear Adobe RGB (1998); both use the D65 white point. */
const TO_ADOBE = [
  [0.7152, 0.2848, 0],
  [0, 1, 0],
  [0, 0.0412, 0.9588],
];
const adobeGamma = (c: number) => Math.max(0, c) ** (1 / 2.19921875);

// ------------------------------------------------------------------ render

/** Standard normal samples, generated once. */
const GAUSS = (() => {
  const r = rng(12345);
  const out = new Float32Array(1 << 16);
  for (let i = 0; i < out.length; i += 2) {
    const u = Math.max(1e-9, r());
    const v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    out[i] = m * Math.cos(2 * Math.PI * v);
    out[i + 1] = m * Math.sin(2 * Math.PI * v);
  }
  return out;
})();

export function render(scene: Scene, o: RenderOpts): Rendered {
  const { rgb, w, h } = composite(scene, o);
  const random = rng(o.seed);

  // Hand shake: angle of view turned into pixels per degree.
  if (o.shake > 0) {
    const fovDeg = (2 * Math.atan(SENSOR_W / 2 / scene.lens.focal) * 180) / Math.PI;
    const length = ((o.shake * o.t) / fovDeg) * w;
    lineBlur(rgb, w, h, length, random() * Math.PI);
  }

  // Exposure: 1.0 is sensor saturation.
  const k = ((o.t * o.iso) / (100 * o.N * o.N)) * (o.flicker?.gain ?? 1);
  for (let i = 0; i < rgb.length; i++) rgb[i] *= k;

  // Glow around anything far over saturation (sun, flames, bare bulbs).
  bloom(rgb, w, h);

  // HDR: the merged brackets hold highlights and shadows that one frame can't.
  // Merging before the noise: lifted shadows come from the brighter frame.
  if (o.hdr) mergeHdr(rgb, w, h, o.hdr);

  // Shot noise and read noise, larger at higher ISO; mostly luminance, some chroma.
  const gain = o.iso / 100 / FULL_WELL;
  const read = READ_NOISE * gain;
  let gi = Math.floor(random() * GAUSS.length);
  for (let p = 0; p < w * h; p++) {
    const shared = GAUSS[gi++ & 0xffff];
    for (let c = 0; c < 3; c++) {
      const i = p * 3 + c;
      const v = Math.max(0, rgb[i]);
      const sigma = Math.sqrt(v * gain + read * read);
      rgb[i] = v + sigma * (0.8 * shared + 0.55 * GAUSS[gi++ & 0xffff]);
    }
  }

  const linear = o.linear ? rgb.slice() : undefined;

  // White balance (with shift) and picture style, then highlights rolled off to white.
  const gains = wbGains(o.wbRgb ?? illuminant(o.wbK), o.wbShift);
  const style = PICTURE_STYLES[o.pictureStyle] ?? PICTURE_STYLES.standard;
  const d = o.styleDetail;
  const contrast = style.contrast * (1 + 0.06 * (d?.contrast ?? 0));
  const saturation = style.saturation * Math.max(0, 1 + 0.12 * (d?.saturation ?? 0));
  const colortone = 0.025 * (d?.colortone ?? 0);
  const monoW = MONO_FILTERS[d?.filtereffect ?? "none"] ?? MONO_FILTERS.none;
  const toning = TONING[d?.toningeffect ?? "none"] ?? TONING.none;
  const adobe = o.colorSpace === "adobe_rgb";
  const encode = adobe ? adobeGamma : toSrgb;
  const mr = gains[0] * (1 + style.warmth);
  const mg = gains[1];
  const mb = gains[2] * (1 - style.warmth);
  const fl = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    let r = rgb[p * 3] * mr;
    let g = rgb[p * 3 + 1] * mg;
    let b = rgb[p * 3 + 2] * mb;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (style.mono) {
      const m = monoW[0] * r + monoW[1] * g + monoW[2] * b;
      r = m * toning[0];
      g = m * toning[1];
      b = m * toning[2];
    } else {
      r = Math.max(0, y + (r - y) * saturation);
      g = Math.max(0, y + (g - y) * saturation);
      b = Math.max(0, y + (b - y) * saturation);
      // Colour tone: warm tones lean yellow (+) or red (-); neutrals stay put.
      if (colortone && r > g) g = Math.max(0, g + colortone * (r - g));
    }
    if (adobe) {
      const ar = TO_ADOBE[0][0] * r + TO_ADOBE[0][1] * g;
      const ab = TO_ADOBE[2][1] * g + TO_ADOBE[2][2] * b;
      r = ar;
      b = ab;
    }
    // Anything past saturation goes to white, whatever its colour (a clipped
    // flame is white, not cyan), fully so at three times saturation.
    const max = Math.max(r, g, b);
    if (max > 1) {
      const k = Math.min(1, (max - 1) / 2);
      r = (r / max) * (1 - k) + k;
      g = (g / max) * (1 - k) + k;
      b = (b / max) * (1 - k) + k;
    }
    fl[p * 3] = tone(r, contrast, encode);
    fl[p * 3 + 1] = tone(g, contrast, encode);
    fl[p * 3 + 2] = tone(b, contrast, encode);
  }
  if (d) sharpen(fl, w, h, d);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    out[p * 4] = Math.round(fl[p * 3] * 255);
    out[p * 4 + 1] = Math.round(fl[p * 3 + 1] * 255);
    out[p * 4 + 2] = Math.round(fl[p * 3 + 2] * 255);
    out[p * 4 + 3] = 255;
  }
  return { w, h, rgba: out, linear, wbGains: gains };
}

/**
 * Gains that render light of colour `light` neutral, then the shift: each
 * step is about 2.5 % on its axis, normalised so a shift keeps brightness.
 */
export function wbGains(light: RGB, shift?: { ba: number; mg: number }): RGB {
  let r = 1 / light[0];
  let g = 1 / light[1];
  let b = 1 / light[2];
  if (shift && (shift.ba || shift.mg)) {
    r *= 1 + 0.025 * shift.ba;
    b *= 1 - 0.025 * shift.ba;
    g *= 1 + 0.025 * shift.mg;
    const y = 0.2126 * r * light[0] + 0.7152 * g * light[1] + 0.0722 * b * light[2];
    r /= y;
    g /= y;
    b /= y;
  }
  return [r, g, b];
}

/** Coarse grid step for the HDR merge's local brightness, in pixels at full size. */
const HDR_CELL = 8;

/**
 * What the camera's HDR merge does, as a local tone map: the brightness of
 * each region (a heavily blurred log luminance) is pulled towards mid-grey,
 * so a sunlit field and a face in deep shade both land in range, while the
 * detail within each region is kept. A bracket of n stops compresses by
 * 1 / (1 + 0.3 n); "auto" fits the scene's range into about four stops.
 * Like the real thing, it leaves a soft glow at hard light/shade edges.
 */
function mergeHdr(rgb: Float32Array, w: number, h: number, hdr: "auto" | number) {
  const cell = Math.max(1, Math.round((HDR_CELL * w) / 1200));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  // Mean log luminance per cell, in the first plane of an RGBA buffer for the blur.
  const grid = new Float32Array(gw * gh * 4);
  const count = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const l = Math.log2(Math.max(1e-5, 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2]));
      const g = Math.floor(y / cell) * gw + Math.floor(x / cell);
      grid[g * 4] += l;
      count[g]++;
    }
  }
  for (let g = 0; g < gw * gh; g++) {
    grid[g * 4] /= count[g] || 1;
    grid[g * 4 + 3] = 1;
  }
  gaussian(grid, gw, gh, 4);
  let c: number;
  if (hdr === "auto") {
    const sorted = Array.from({ length: gw * gh }, (_, g) => grid[g * 4]).sort((a, b) => a - b);
    const range = sorted[Math.floor(sorted.length * 0.98)] - sorted[Math.floor(sorted.length * 0.02)];
    c = Math.min(1, Math.max(0.4, 4 / Math.max(range, 1e-3)));
  } else c = 1 / (1 + 0.3 * Math.min(3, Math.max(1, hdr)));
  const anchor = Math.log2(0.18);
  const at = (gx: number, gy: number) => grid[(Math.min(gh - 1, Math.max(0, gy)) * gw + Math.min(gw - 1, Math.max(0, gx))) * 4];
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / cell - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / cell - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const base = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      const p = y * w + x;
      const gain = 2 ** ((anchor - base) * (1 - c));
      rgb[p * 3] *= gain;
      rgb[p * 3 + 1] *= gain;
      rgb[p * 3 + 2] *= gain;
    }
  }
}

/** Linear value to an encoded 0..1 value with a contrast curve around mid-grey. */
function tone(v: number, contrast: number, encode: (c: number) => number): number {
  const s = encode(Math.max(0, Math.min(1, v)));
  const c = 0.5 + (s - 0.5) * contrast;
  // Soft knees so contrast never crushes or clips abruptly.
  return c < 0.05 ? 0.05 * Math.exp((c - 0.05) / 0.05) : c > 0.96 ? 1 - 0.04 * Math.exp(-(c - 0.96) / 0.04) : c;
}

/**
 * Unsharp mask on brightness: strength scales the effect, fineness picks the
 * size of detail it works on (1 = finest), threshold leaves small
 * differences (noise, smooth skin) alone.
 */
function sharpen(rgb: Float32Array, w: number, h: number, d: StyleDetail) {
  const amount = 0.16 * d.sharpness_strength;
  if (amount <= 0) return;
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) lum[p] = 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2];
  const blurred = lum.slice();
  blur1(blurred, w, h, Math.max(1, Math.round(0.4 + 0.4 * d.sharpness_fineness)));
  const thr = 0.004 * d.sharpness_threshold;
  for (let p = 0; p < w * h; p++) {
    const diff = lum[p] - blurred[p];
    const mag = Math.abs(diff);
    if (mag <= thr) continue;
    const add = amount * Math.sign(diff) * (mag - thr);
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.min(1, Math.max(0, rgb[p * 3 + c] + add));
  }
}

/** Two box passes each way (close to a small Gaussian) on one channel, in place. */
function blur1(buf: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(buf.length);
  const norm = 1 / (2 * r + 1);
  const pass = (src: Float32Array, dst: Float32Array, len: number, lines: number, stride: number, lineStep: number) => {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride] = sum * norm;
        sum += src[base + Math.min(len - 1, i + r + 1) * stride] - src[base + Math.max(0, i - r) * stride];
      }
    }
  };
  for (let n = 0; n < 2; n++) {
    pass(buf, tmp, w, h, 1, w);
    pass(tmp, buf, h, w, w, 1);
  }
}

/** Adds a soft halo of light that exceeds saturation. */
function bloom(rgb: Float32Array, w: number, h: number) {
  const f = 4;
  const bw = Math.ceil(w / f);
  const bh = Math.ceil(h / f);
  const buf = new Float32Array(bw * bh * 4);
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const lum = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
      if (lum <= 1.5) continue;
      any = true;
      const ex = Math.min(lum - 1.5, 30) / lum;
      const j = (Math.floor(y / f) * bw + Math.floor(x / f)) * 4;
      buf[j] += rgb[i] * ex;
      buf[j + 1] += rgb[i + 1] * ex;
      buf[j + 2] += rgb[i + 2] * ex;
    }
  }
  if (!any) return;
  // A tight halo plus a faint wide one, like lens glare; two scales keep a row
  // of small lights (candles) from spreading into a box.
  const wide = buf.slice();
  gaussian(buf, bw, bh, Math.max(1.5, bw / 120));
  gaussian(wide, bw, bh, Math.max(3, bw / 30));
  const near = 0.05 / (f * f);
  const far = 0.015 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const j = (Math.floor(y / f) * bw + Math.floor(x / f)) * 4;
      rgb[i] += buf[j] * near + wide[j] * far;
      rgb[i + 1] += buf[j + 1] * near + wide[j + 1] * far;
      rgb[i + 2] += buf[j + 2] * near + wide[j + 2] * far;
    }
  }
}

// ------------------------------------------------------------------ metering

export type MeteringMode = "evaluative" | "partial" | "spot" | "center_weighted_average";

/**
 * Metered brightness as EV at ISO 100: exposing at this EV renders the
 * weighted average of the frame as mid-grey. Evaluative weighs the whole
 * frame (with a little extra on the centre and subject), so a bright
 * background pulls it up, as on a real camera.
 */
export function meter(scene: Scene, mode: string, time: number): number {
  const { rgb, w, h } = composite(scene, { w: scene.w / 8, dofN: 8, focus: 3, time, motionBlur: false, t: 0, blur: false });
  const sb = scene.subject;
  const subj = scene.layers.find((l) => l.name === sb.layer);
  const shift = subj ? motionAt(subj, time).dx / scene.w : 0;
  let sumW = 0, sumLog = 0, sumLin = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w;
      const ny = (y + 0.5) / h;
      const dc = Math.hypot((nx - 0.5) * 1.5, ny - 0.5);
      let wt: number;
      switch (mode) {
        case "spot": wt = dc < 0.035 ? 1 : 0; break;
        case "partial": wt = dc < 0.09 ? 1 : 0; break;
        case "center_weighted_average": wt = 0.25 + Math.exp(-(dc * dc) / (2 * 0.18 * 0.18)); break;
        default: {
          const inSubject = nx >= sb.x + shift && nx <= sb.x + shift + sb.w && ny >= sb.y && ny <= sb.y + sb.h;
          wt = 1 + 0.6 * Math.exp(-(dc * dc) / (2 * 0.25 * 0.25)) + (inSubject ? 0.5 : 0);
        }
      }
      if (!wt) continue;
      const i = (y * w + x) * 3;
      const lum = Math.max(1e-6, 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]);
      sumW += wt;
      sumLog += wt * Math.log2(lum);
      sumLin += wt * Math.min(lum, 0.18 * 2 ** 17);
    }
  }
  const logMean = sumLog / sumW;
  const linMean = Math.log2(sumLin / sumW);
  // Mostly the geometric mean, pulled up by the brightest areas, as averaging meters are.
  const blend = mode === "evaluative" ? 0.55 : 0.75;
  return blend * logMean + (1 - blend) * linMean - Math.log2(0.18);
}
