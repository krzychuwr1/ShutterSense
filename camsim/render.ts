// Renders a scene through a virtual lens and sensor: depth of field from the
// thin-lens model, subject motion and hand shake over the exposure time,
// exposure in physical units, sensor noise that grows with ISO, highlight
// clipping, white balance and a picture style, then sRGB 8-bit output.

import { illuminant, toSrgb } from "./color.ts";
import { rng, type Layer } from "./paint.ts";
import { depthAt, type Scene, type SceneLayer } from "./scenes.ts";

/** Full-frame sensor width in mm. */
const SENSOR_W = 36;
/** Electrons at saturation at ISO 100. Lower = noisier at high ISO. */
const FULL_WELL = 12000;
const READ_NOISE = 4;
const MAX_BLUR_SIGMA = 40;

export interface RenderOpts {
  /** Output width; the scene width divided by 1, 2, 4 or 8. */
  w: number;
  /** f-number, seconds, ISO. */
  N: number;
  t: number;
  iso: number;
  /** Aperture used for depth of field (live view shows it wide open). */
  dofN: number;
  /** Focus distance in metres. */
  focus: number;
  /** White balance colour temperature the camera applies. */
  wbK: number;
  pictureStyle: string;
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

/** A moving layer placed at its current position (and mirrored when running the other way). */
function placed(l: Layer, sl: SceneLayer, time: number, factor: number): Layer {
  if (!sl.motion) return l;
  const { dx, dir } = motionAt(sl, time);
  const off = Math.round(dx / factor);
  const pivot = sl.motion.pivotX / factor;
  const out: Layer = { w: l.w, h: l.h, rgb: new Float32Array(l.rgb.length), a: new Float32Array(l.a.length) };
  for (let x = 0; x < l.w; x++) {
    const u = x - off;
    const sx = dir === 1 ? u : Math.round(2 * pivot - u);
    if (sx < 0 || sx >= l.w) continue;
    for (let y = 0; y < l.h; y++) {
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

/** Composite of all layers at output size, in linear radiance (no exposure applied). */
export function composite(scene: Scene, o: Pick<RenderOpts, "w" | "dofN" | "focus" | "time" | "motionBlur" | "t"> & { blur?: boolean }): { rgb: Float32Array; w: number; h: number } {
  const factor = Math.max(1, Math.round(scene.w / o.w));
  const w = Math.floor(scene.w / factor);
  const h = Math.floor(scene.h / factor);
  const acc = new Float32Array(w * h * 3);
  const blur = o.blur ?? true;
  for (const sl of scene.layers) {
    const l = placed(layerAt(sl, factor), sl, o.time, factor);
    const buf = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      buf[i * 4] = l.rgb[i * 3];
      buf[i * 4 + 1] = l.rgb[i * 3 + 1];
      buf[i * 4 + 2] = l.rgb[i * 3 + 2];
      buf[i * 4 + 3] = l.a[i];
    }
    if (blur) {
      const sigma = (d: number) => ((blurCircleMm(scene.lens.focal, o.dofN, o.focus, d) / SENSOR_W) * w) / 2.6;
      if (sl.ground) gaussianByRow(buf, w, h, Float32Array.from({ length: h }, (_, y) => sigma(depthAt(sl, (y + 0.5) / h))));
      else gaussian(buf, w, h, sigma(sl.depth));
      if (o.motionBlur && sl.motion) smear(buf, w, h, (sl.motion.speed / factor) * o.t);
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
  const k = (o.t * o.iso) / (100 * o.N * o.N);
  for (let i = 0; i < rgb.length; i++) rgb[i] *= k;

  // Glow around anything far over saturation (sun, flames, bare bulbs).
  bloom(rgb, w, h);

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

  // White balance and picture style, then highlights rolled off to white.
  const wb = illuminant(o.wbK);
  const style = PICTURE_STYLES[o.pictureStyle] ?? PICTURE_STYLES.standard;
  const mr = (1 / wb[0]) * (1 + style.warmth);
  const mg = 1 / wb[1];
  const mb = (1 / wb[2]) * (1 - style.warmth);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    let r = rgb[p * 3] * mr;
    let g = rgb[p * 3 + 1] * mg;
    let b = rgb[p * 3 + 2] * mb;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (style.mono) r = g = b = y;
    else {
      r = Math.max(0, y + (r - y) * style.saturation);
      g = Math.max(0, y + (g - y) * style.saturation);
      b = Math.max(0, y + (b - y) * style.saturation);
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
    out[p * 4] = tone(r, style.contrast);
    out[p * 4 + 1] = tone(g, style.contrast);
    out[p * 4 + 2] = tone(b, style.contrast);
    out[p * 4 + 3] = 255;
  }
  return { w, h, rgba: out };
}

/** Linear value to 8-bit sRGB with a contrast curve around mid-grey. */
function tone(v: number, contrast: number): number {
  const s = toSrgb(Math.max(0, Math.min(1, v)));
  const c = 0.5 + (s - 0.5) * contrast;
  // Soft knees so contrast never crushes or clips abruptly.
  const t = c < 0.05 ? 0.05 * Math.exp((c - 0.05) / 0.05) : c > 0.96 ? 1 - 0.04 * Math.exp(-(c - 0.96) / 0.04) : c;
  return Math.round(t * 255);
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
