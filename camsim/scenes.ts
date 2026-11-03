// Test scenes for the virtual camera. Each scene is a stack of photographic
// layers (a background plate and cut-out subjects) at known distances. The
// 8-bit images are turned into linear radiance calibrated to exposure values,
// so exposure, metering, white balance, depth of field, motion blur and noise
// can all be simulated physically. Each scene is set up so the camera's
// starting settings get it visibly wrong in a way a photographer would recognise.

import { illuminant, toLinear } from "./color.ts";
import type { Flicker } from "./flicker.ts";
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
  /** Closest focus distance in metres. */
  minFocus: number;
}

/** A plane seen at an angle (lawn, table top): distance by row is k / (y - horizon), in normalised rows, capped at `far` (the sky, or things standing on the surface). */
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
  /**
   * How the layer is lit: radiance = reflectance × light[row] × tint. Lets
   * the renderer recover reflectance, so added light (a flash) falls on the
   * surfaces with their own colours.
   */
  light: Float32Array;
  tint: [number, number, number];
  /** The part of the layer's light (`share`, 0..1) that comes from a flickering source. */
  flicker?: { light: Flicker; share: number };
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
  shuttermode?: string;
  drive?: string;
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
  /** Lit (wholly, or `share` of it) by a light that flickers. */
  flicker?: { light: Flicker; share?: number };
}

interface SceneSpec extends Omit<Scene, "w" | "h" | "layers" | "subject"> {
  layers: LayerSpec[];
  subject: { layer: string; face: boolean };
}

/**
 * Old fluorescent tubes on magnetic ballasts, 50 Hz mains: a 100 Hz ripple
 * of over ±50 % in brightness, deeper in blue than in red (the phosphors
 * glow on for different times), so the light also turns warmer in each dip.
 */
const GYM_TUBES: Flicker = { name: "fluorescent tubes (50 Hz mains)", kind: "mains", hz: 100, depth: [0.5, 0.56, 0.75] };

/** Dimmed LED stage lights: switched fully on and off 1310 times a second, on a quarter of the time. */
const STAGE_LEDS: Flicker = { name: "dimmed LED stage lights", kind: "pwm", hz: 1310, duty: 0.25, floor: 0 };

const SPECS: Record<string, SceneSpec> = {
  dog: {
    id: "dog",
    title: "Dog running in the park",
    blurb: "Overcast afternoon, the dog is sprinting back and forth. The shutter is far too slow.",
    goals: ["Sharp shot of the dog, background blurred", "Freeze the dog mid-stride", "Show some motion but keep the dog's face sharp"],
    layers: [
      { name: "park", file: "scenes/dog/plate.jpg", depth: 15, ground: { horizon: 0.38, k: 4.3, far: 70 }, ev: 12, kelvin: 6600 },
      { name: "dog", file: "scenes/dog/dog.png", depth: 15, ev: 12, kelvin: 6600, motion: { speed: 1300, range: [-40, 360] }, shadow: 0.3 },
    ],
    lens: { name: "70-200mm F2.8 at 200mm", focal: 200, maxAperture: 2.8, minAperture: 32, minFocus: 1.2 },
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
      { name: "table", file: "scenes/dinner/table.png", depth: 1.4, ground: { horizon: 0.6, k: 0.3, far: 1.4 }, ev: 4.4, kelvin: 2500, highlights: { knee: 0.8, gain: 120, box: [0.4, 0.48, 0.6, 0.62] } },
    ],
    lens: { name: "35mm F1.8", focal: 35, maxAperture: 1.8, minAperture: 22, minFocus: 0.25 },
    subject: { layer: "person", face: true },
    awbK: 3400,
    lightK: 2500,
    handheld: true,
    initial: {
      shootingmode: "av", av: "f5.6", tv: "1/60", iso: "400", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
    },
  },
  gym: {
    id: "gym",
    title: "Basketball under fluorescent lights",
    blurb: "A school sports hall lit by old fluorescent tubes. Silent shutter at 1/1000: every frame comes out a different brightness, with stripes.",
    goals: ["Freeze the drive to the basket", "Even exposure and colour across a burst", "Sharp player, defender and crowd softer behind"],
    layers: [
      {
        name: "hall", file: "scenes/gym/plate.jpg", depth: 44, ground: { horizon: 0.4, k: 6.2, far: 44 },
        ev: 7.3, kelvin: 4100, highlights: { knee: 0.85, gain: 12, box: [0, 0, 1, 0.08] }, flicker: { light: GYM_TUBES },
      },
      { name: "defender", file: "scenes/gym/defender.png", depth: 25, ev: 7.3, kelvin: 4100, motion: { speed: 230, range: [-50, 70] }, shadow: 0.25, flicker: { light: GYM_TUBES } },
      { name: "player", file: "scenes/gym/player.png", depth: 16, ev: 7.3, kelvin: 4100, motion: { speed: 440, range: [-70, 130] }, shadow: 0.3, flicker: { light: GYM_TUBES } },
    ],
    lens: { name: "85mm F1.8", focal: 85, maxAperture: 1.8, minAperture: 22, minFocus: 0.8 },
    subject: { layer: "player", face: true },
    awbK: 4300,
    lightK: 4100,
    handheld: true,
    initial: {
      shootingmode: "tv", av: "f1.8", tv: "1/1000", iso: "auto", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
      shuttermode: "electronic", drive: "highspeed",
    },
  },
  concert: {
    id: "concert",
    title: "Club gig under LED lights",
    blurb: "A small club stage lit by dimmed LED panels. Silent shutter at 1/800: dark stripes run across every frame.",
    goals: ["Shoot silently, but get rid of the dark stripes", "Sharp singer at a fast shutter speed, no banding", "Singer sharp, band softly blurred behind"],
    layers: [
      { name: "stage", file: "scenes/concert/plate.jpg", depth: 12, ev: 8.5, kelvin: 5200, highlights: { knee: 0.8, gain: 25, box: [0, 0, 1, 0.75] }, flicker: { light: STAGE_LEDS } },
      { name: "band", file: "scenes/concert/band.png", depth: 10, ev: 8.7, kelvin: 5200, flicker: { light: STAGE_LEDS } },
      { name: "singer", file: "scenes/concert/singer.png", depth: 4.5, ev: 9, kelvin: 5200, highlights: { knee: 0.9, gain: 3 }, flicker: { light: STAGE_LEDS } },
      { name: "crowd", file: "scenes/concert/crowd.png", depth: 2, ev: 6, kelvin: 5200, flicker: { light: STAGE_LEDS, share: 0.6 } },
    ],
    lens: { name: "24-70mm F2.8 at 70mm", focal: 70, maxAperture: 2.8, minAperture: 22, minFocus: 0.38 },
    subject: { layer: "singer", face: true },
    awbK: 5000,
    lightK: 5200,
    handheld: true,
    initial: {
      shootingmode: "tv", av: "f2.8", tv: "1/2000", iso: "auto", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
      shuttermode: "electronic",
    },
  },
  group: {
    id: "group",
    title: "Group portrait in the shade",
    blurb: "Three friends at 2, 3.4 and 5.6 m under a tree. The lens is wide open at f/1.4, so only the nearest face is sharp.",
    goals: ["Get all three of them sharp", "All three sharp, background still soft", "Warmer, natural skin tones in the shade"],
    layers: [
      {
        name: "park", file: "scenes/group/plate.jpg", depth: 30, ground: { horizon: 0.322, k: 2.18, far: 30 },
        ev: [[0, 13.2], [0.3, 13.2], [0.4, 12.8], [0.47, 11.6], [1, 11.4]], kelvin: 6000,
      },
      { name: "back", file: "scenes/group/back.png", depth: 5.6, ev: 11.4, kelvin: 7000 },
      { name: "middle", file: "scenes/group/middle.png", depth: 3.4, ev: 11.4, kelvin: 7000 },
      { name: "front", file: "scenes/group/front.png", depth: 2.1, ev: 11.4, kelvin: 7000 },
    ],
    lens: { name: "35mm F1.4", focal: 35, maxAperture: 1.4, minAperture: 16, minFocus: 0.3 },
    subject: { layer: "front", face: true },
    awbK: 6200,
    lightK: 7000,
    handheld: true,
    initial: {
      shootingmode: "av", av: "f1.4", tv: "1/250", iso: "auto", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
    },
  },
  // The same park as "group" on a bright day: the friend stands in the tree's
  // deep shade, the meadow behind is in full sun, about five stops brighter.
  // No single exposure holds both, and the photographer wants natural light,
  // so the fix is HDR Mode, which the control API can't switch on.
  shade: {
    id: "shade",
    title: "Portrait in deep shade, sunlit meadow",
    blurb: "Midday sun, your friend in the tree's shade. Expose for her face and the meadow burns out; expose for the meadow and she goes dark.",
    goals: ["Natural light, no flash: keep her face and the sunny meadow", "Nothing blown out, nothing too dark", "Bright, natural portrait with the green meadow behind"],
    layers: [
      {
        name: "park", file: "scenes/group/plate.jpg", depth: 30, ground: { horizon: 0.322, k: 2.18, far: 30 },
        ev: [[0, 15], [0.3, 15], [0.45, 14.4], [1, 14.4]], kelvin: 5500, highlights: { knee: 0.85, gain: 4, box: [0.3, 0, 1, 0.3] },
      },
      { name: "friend", file: "scenes/group/front.png", depth: 2.1, ev: 9.2, kelvin: 7500 },
    ],
    lens: { name: "35mm F1.4", focal: 35, maxAperture: 1.4, minAperture: 16, minFocus: 0.3 },
    subject: { layer: "friend", face: true },
    awbK: 5600,
    lightK: 7500,
    handheld: true,
    initial: {
      shootingmode: "av", av: "f2.8", tv: "1/500", iso: "auto", exposure: "+0.0", wb: "auto", colortemperature: 5200,
      metering: "evaluative", afoperation: "oneshot", afmethod: "face+tracking", picturestyle: "auto",
    },
  },
};

/** Picker order: the scenes where a little-known setting is the fix come first. */
export const SCENE_IDS = ["concert", "gym", "shade", "dog", "group", "dinner"].filter((id) => id in SPECS);

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
  return { x: x0 / l.w, y: y0 / l.h, w: (x1 - x0 + 1) / l.w, h: (y1 - y0 + 1) / l.h };
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
    const light = Float32Array.from({ length: SCENE_H }, (_, y) => 2 ** evAt(l.ev, (y + 0.5) / SCENE_H));
    const out: SceneLayer = { name: l.name, depth: l.depth, layer, light, tint: illuminant(l.kelvin) };
    if (l.ground) out.ground = l.ground;
    if (l.flicker) out.flicker = { light: l.flicker.light, share: l.flicker.share ?? 1 };
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
