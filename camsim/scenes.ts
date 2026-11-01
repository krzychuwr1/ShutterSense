// Test scenes for the virtual camera. Each scene is a stack of photographic
// layers (a background plate and cut-out subjects) at known distances. The
// 8-bit images are turned into linear radiance calibrated to exposure values,
// so exposure, metering, white balance, depth of field, motion blur and noise
// can all be simulated physically. Each scene is set up so the camera's
// starting settings get it visibly wrong in a way a photographer would recognise.

import { illuminant, toLinear } from "./color.ts";
import { ellipse, fill, newLayer, type Layer } from "./paint.ts";

export const SCENE_W = 1200;
export const SCENE_H = 800;

export interface Lens {
  name: string;
  /** Focal length in mm (full frame). */
  focal: number;
  /** Widest and narrowest f-numbers. */
  maxAperture: number;
  minAperture: number;
}

/** A plane seen at an angle (lawn, table top): distance by row is k / (y - horizon), in normalised rows, capped at `far`. */
export interface Ground {
  horizon: number;
  k: number;
  far: number;
}

export interface SceneLayer {
  name: string;
  /** Distance from the camera in metres (for a ground plane, the distance where the subject stands). */
  depth: number;
  ground?: Ground;
  layer: Layer;
  /** A subject crossing the frame: it moves back and forth between `range` (pixel offsets) at `speed` px/s. */
  motion?: { speed: number; range: [number, number]; pivotX: number };
}

export interface SceneSettings {
  shootingmode?: string;
  av?: string;
  tv?: string;
  iso?: string;
  exposure?: string;
  wb?: string;
  colortemperature?: number;
  metering?: string;
  afoperation?: string;
  afmethod?: string;
  picturestyle?: string;
}

export interface Scene {
  id: string;
  title: string;
  /** One line for the scene picker. */
  blurb: string;
  /** Goals a judge can try, in the photographer's words. */
  goals: string[];
  w: number;
  h: number;
  /** Far to near. */
  layers: SceneLayer[];
  lens: Lens;
  /** The main subject at time 0, normalised box, and whether AF can find a face on it. */
  subject: { x: number; y: number; w: number; h: number; layer: string; face: boolean };
  /** Colour temperature the camera's auto white balance settles on in this light. */
  awbK: number;
  /** Colour temperature of the light on the subject (what "correct" white balance is). */
  lightK: number;
  /** Shooting handheld: slow shutter speeds shake. */
  handheld: boolean;
  /** Settings the camera starts in. */
  initial: SceneSettings;
}

/** Decoded 8-bit sRGB image with alpha. */
export interface RgbaImage {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Loads an image by its path under the web root, e.g. "scenes/dog/plate.jpg". */
export type ImageLoader = (path: string) => Promise<RgbaImage>;

interface LayerSpec {
  name: string;
  file: string;
  depth: number;
  ground?: Ground;
  /**
   * Brightness: a mid-grey pixel of the image meters at this EV. Either one
   * value, or [row, EV] stops down the frame (sky far brighter than the land).
   */
  ev: number | Array<[number, number]>;
  /** Colour of the light. The images are white-balanced; this tints them as the light really is. */
  kelvin: number;
  /**
   * Light sources in the image (sun, flames, lamps): pixels above `knee`
   * (linear) are brightened up to `gain` times, optionally only inside a
   * normalised box [x0, y0, x1, y1] (so white icing doesn't glow like the flames).
   */
  highlights?: { knee: number; gain: number; box?: [number, number, number, number] };
  motion?: { speed: number; range: [number, number] };
  /** A soft contact shadow under the subject, moving with it. */
  shadow?: number;
}

interface SceneSpec extends Omit<Scene, "w" | "h" | "layers" | "subject"> {
  layers: LayerSpec[];
  subject: { layer: string; face: boolean };
}

const SPECS: Record<string, SceneSpec> = {
  backlit: {
    id: "backlit",
    title: "Backlit portrait",
    blurb: "Golden hour, sun right behind her. The camera exposes for the sky.",
    goals: ["She's backlit, fix it", "Portrait with a soft, dreamy background", "Keep the sunset colours but show her face"],
    layers: [
      {
        name: "landscape", file: "scenes/backlit/plate.jpg", depth: 40, ground: { horizon: 0.55, k: 3.6, far: 2000 },
        ev: [[0, 14.4], [0.45, 15], [0.53, 14.8], [0.555, 12.2], [1, 11.6]], kelvin: 5000, highlights: { knee: 0.82, gain: 40 },
      },
      { name: "person", file: "scenes/backlit/woman.png", depth: 2.6, ev: 9.4, kelvin: 6200, highlights: { knee: 0.9, gain: 3 } },
    ],
    lens: { name: "85mm F1.8", focal: 85, maxAperture: 1.8, minAperture: 22 },
    subject: { layer: "person", face: true },
    awbK: 5000,
    lightK: 6200,
    handheld: true,
    initial: {
      shootingmode: "av", av: "f5.6", tv: "1/250", iso: "auto", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
    },
  },
  dog: {
    id: "dog",
    title: "Dog running in the park",
    blurb: "Overcast afternoon, the dog is sprinting back and forth. The shutter is far too slow.",
    goals: ["Sharp shot of the dog, background blurred", "Freeze the dog mid-stride", "Show some motion but keep the dog's face sharp"],
    layers: [
      { name: "park", file: "scenes/dog/plate.jpg", depth: 15, ground: { horizon: 0.38, k: 4.3, far: 70 }, ev: 12, kelvin: 6600 },
      { name: "dog", file: "scenes/dog/dog.png", depth: 15, ev: 12, kelvin: 6600, motion: { speed: 1300, range: [-40, 360] }, shadow: 0.3 },
    ],
    lens: { name: "70-200mm F2.8 at 200mm", focal: 200, maxAperture: 2.8, minAperture: 32 },
    subject: { layer: "dog", face: false },
    awbK: 6300,
    lightK: 6600,
    handheld: true,
    initial: {
      shootingmode: "av", av: "f8.0", tv: "1/60", iso: "100", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "spot", picturestyle: "auto",
    },
  },
  dinner: {
    id: "dinner",
    title: "Birthday dinner indoors",
    blurb: "Candles and one warm lamp. The camera is at ISO 400 and f/5.6, so the shutter drags.",
    goals: ["Low light indoors: get a sharp, natural-looking shot", "Fix the orange colour cast", "Keep the cosy candlelight mood"],
    layers: [
      { name: "room", file: "scenes/dinner/room.jpg", depth: 4.5, ev: 3.9, kelvin: 2700, highlights: { knee: 0.75, gain: 30 } },
      { name: "person", file: "scenes/dinner/man.png", depth: 2.5, ev: 4.4, kelvin: 2500 },
      { name: "table", file: "scenes/dinner/table.png", depth: 1.6, ground: { horizon: 0.45, k: 0.6, far: 2.4 }, ev: 4.4, kelvin: 2500, highlights: { knee: 0.8, gain: 120, box: [0.4, 0.48, 0.6, 0.62] } },
    ],
    lens: { name: "35mm F1.8", focal: 35, maxAperture: 1.8, minAperture: 22 },
    subject: { layer: "person", face: true },
    awbK: 3400,
    lightK: 2500,
    handheld: true,
    initial: {
      shootingmode: "av", av: "f5.6", tv: "1/60", iso: "400", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
    },
  },
};

export const SCENE_IDS = Object.keys(SPECS);

/** Scene metadata without loading the pixels (for pickers). */
export const SCENE_INFO = SCENE_IDS.map((id) => {
  const { title, blurb, goals } = SPECS[id];
  return { id, title, blurb, goals };
});

/** Distance of a layer at normalised row `y`. */
export function depthAt(sl: Pick<SceneLayer, "depth" | "ground">, y: number): number {
  const g = sl.ground;
  if (!g) return sl.depth;
  return y <= g.horizon ? g.far : Math.min(g.far, g.k / (y - g.horizon));
}

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

function evAt(ev: LayerSpec["ev"], y: number): number {
  if (typeof ev === "number") return ev;
  if (y <= ev[0][0]) return ev[0][1];
  for (let i = 1; i < ev.length; i++) {
    const [y1, e1] = ev[i];
    if (y <= y1) {
      const [y0, e0] = ev[i - 1];
      return e0 + ((e1 - e0) * (y - y0)) / (y1 - y0);
    }
  }
  return ev[ev.length - 1][1];
}

/** An image as a layer of premultiplied linear radiance. */
function toLayer(img: RgbaImage, spec: LayerSpec): Layer {
  if (img.w !== SCENE_W || img.h !== SCENE_H) throw new Error(`${spec.file} is ${img.w}×${img.h}, expected ${SCENE_W}×${SCENE_H}`);
  const layer = newLayer(SCENE_W, SCENE_H);
  const tint = illuminant(spec.kelvin);
  const hl = spec.highlights;
  for (let y = 0; y < SCENE_H; y++) {
    const s = 2 ** evAt(spec.ev, (y + 0.5) / SCENE_H);
    const k: [number, number, number] = [tint[0] * s, tint[1] * s, tint[2] * s];
    for (let x = 0; x < SCENE_W; x++) {
      const i = y * SCENE_W + x;
      const a = img.data[i * 4 + 3] / 255;
      if (a === 0) continue;
      const r = LINEAR[img.data[i * 4]], g = LINEAR[img.data[i * 4 + 1]], b = LINEAR[img.data[i * 4 + 2]];
      let boost = 1;
      if (hl && (!hl.box || (x >= hl.box[0] * SCENE_W && x < hl.box[2] * SCENE_W && y >= hl.box[1] * SCENE_H && y < hl.box[3] * SCENE_H))) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l > hl.knee) boost = 1 + (hl.gain - 1) * ((l - hl.knee) / (1 - hl.knee)) ** 2;
      }
      layer.rgb[i * 3] = r * boost * k[0] * a;
      layer.rgb[i * 3 + 1] = g * boost * k[1] * a;
      layer.rgb[i * 3 + 2] = b * boost * k[2] * a;
      layer.a[i] = a;
    }
  }
  return layer;
}

/** Normalised bounding box of a layer's opaque pixels. */
function bounds(l: Layer) {
  let x0 = l.w, y0 = l.h, x1 = 0, y1 = 0;
  for (let y = 0; y < l.h; y++) {
    for (let x = 0; x < l.w; x++) {
      if (l.a[y * l.w + x] < 0.5) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x: x0 / l.w, y: y0 / l.h, w: (x1 - x0) / l.w, h: (y1 - y0) / l.h };
}

/** A soft dark ellipse under the subject's lowest point, painted beneath it. */
function withShadow(l: Layer, opacity: number): Layer {
  const b = bounds(l);
  const out = newLayer(l.w, l.h);
  const cx = (b.x + b.w / 2) * l.w;
  fill(out, ellipse(cx, (b.y + b.h) * l.h + 14, b.w * l.w * 0.42, 12), [0, 0, 0], { feather: 18, opacity });
  for (let i = 0; i < l.a.length; i++) {
    const a = l.a[i];
    out.rgb[i * 3] = l.rgb[i * 3] + out.rgb[i * 3] * (1 - a);
    out.rgb[i * 3 + 1] = l.rgb[i * 3 + 1] + out.rgb[i * 3 + 1] * (1 - a);
    out.rgb[i * 3 + 2] = l.rgb[i * 3 + 2] + out.rgb[i * 3 + 2] * (1 - a);
    out.a[i] = a + out.a[i] * (1 - a);
  }
  return out;
}

const images = new Map<string, Promise<RgbaImage>>();
/** Only the current scene is kept as float layers (about 15 MB a layer). */
let current: Scene | null = null;

/** Loads and builds a scene. The decoded images stay cached, so switching back is quick. */
export async function loadScene(id: string, load: ImageLoader): Promise<Scene> {
  if (current?.id === id) return current;
  const spec = SPECS[id];
  if (!spec) throw new Error(`unknown scene ${id}`);
  const decoded = await Promise.all(
    spec.layers.map((l) => {
      let p = images.get(l.file);
      if (!p) {
        p = load(l.file);
        images.set(l.file, p);
        p.catch(() => images.delete(l.file));
      }
      return p;
    }),
  );
  const layers: SceneLayer[] = spec.layers.map((l, i) => {
    let layer = toLayer(decoded[i], l);
    if (l.shadow) layer = withShadow(layer, l.shadow);
    const out: SceneLayer = { name: l.name, depth: l.depth, layer };
    if (l.ground) out.ground = l.ground;
    if (l.motion) {
      const b = bounds(layer);
      out.motion = { ...l.motion, pivotX: Math.round((b.x + b.w / 2) * SCENE_W) };
    }
    return out;
  });
  const subjectLayer = layers.find((l) => l.name === spec.subject.layer)!;
  const scene: Scene = { ...spec, w: SCENE_W, h: SCENE_H, layers, subject: { ...bounds(subjectLayer.layer), ...spec.subject } };
  current = scene;
  return scene;
}
