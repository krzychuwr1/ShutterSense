// Autofocus: which part of the scene the AF method looks at, what it finds
// there, and whether it can lock. Point methods focus on whatever is under
// the AF point; zone methods pick the closest thing that fills a fair part of
// the zone (closest-subject priority, like a real camera); face / tracking
// methods find the scene's subject. AF fails on a flat, featureless patch
// (blank sky), where a contrast or phase detector has nothing to lock on.

import type { Rect } from "./image.ts";
import { composite, motionAt } from "./render.ts";
import { depthAt, type Scene, type SceneLayer } from "./scenes.ts";

/** AF area size per method, as fractions of the frame width and height. */
const AF_AREA: Record<string, [number, number]> = {
  spot: [0.015, 0.022],
  "1point": [0.03, 0.045],
  expand_cross: [0.07, 0.1],
  expand_around: [0.09, 0.13],
  zone: [0.22, 0.3],
  large_zone_vertical: [0.18, 0.7],
  large_zone_horizontal: [0.6, 0.25],
  flexible_zone_1: [0.3, 0.4],
  flexible_zone_2: [0.2, 0.5],
  flexible_zone_3: [0.5, 0.25],
  whole_area: [1, 1],
  "face+tracking": [1, 1],
};

const POINT_METHODS = ["spot", "1point"];

/** The AF area of `method` around `point` (sensor pixels), kept inside the frame. */
export function afArea(method: string, point: { x: number; y: number }, w: number, h: number): Rect {
  const [fw, fh] = AF_AREA[method] ?? AF_AREA["1point"];
  const aw = Math.round(fw * w);
  const ah = Math.round(fh * h);
  const x = Math.min(w - aw, Math.max(0, Math.round(point.x - aw / 2)));
  const y = Math.min(h - ah, Math.max(0, Math.round(point.y - ah / 2)));
  return { x, y, w: aw, h: ah };
}

/** The frontmost layer covering a sensor pixel at `time`, and its distance there. */
function layerAtPixel(scene: Scene, x: number, y: number, time: number): { layer: SceneLayer; depth: number } | null {
  const cy = Math.min(scene.h - 1, Math.max(0, Math.floor(y)));
  let hit: { layer: SceneLayer; depth: number } | null = null;
  for (const l of scene.layers) {
    const { dx, dir } = motionAt(l, time);
    let sx = Math.floor(x) - Math.round(dx);
    if (l.motion && dir === -1) sx = Math.round(2 * l.motion.pivotX - sx);
    if (sx < 0 || sx >= l.layer.w) continue;
    if (l.layer.a[cy * l.layer.w + sx] > 0.5) hit = { layer: l, depth: depthAt(l, cy / scene.h) };
  }
  return hit;
}

export interface AfResult {
  ok: boolean;
  /** Focus distance found, metres. */
  depth: number;
  /** What it focused on: a layer name, "face" or "subject". */
  on: string;
}

/**
 * Runs AF over `area`. `track` = the method follows a detected subject
 * (face+tracking, or whole-area AF with tracking on).
 */
export function autofocus(scene: Scene, method: string, area: Rect, time: number, track: boolean): AfResult {
  if (track) {
    const subject = scene.layers.find((l) => l.name === scene.subject.layer);
    return { ok: true, depth: subject?.depth ?? 3, on: scene.subject.face ? "face" : "subject" };
  }
  let pick: { layer: SceneLayer; depth: number } | null;
  if (POINT_METHODS.includes(method)) {
    pick = layerAtPixel(scene, area.x + area.w / 2, area.y + area.h / 2, time);
  } else {
    // Sample the zone; among things covering at least an eighth of it, take the closest.
    const nx = Math.max(3, Math.min(24, Math.round(area.w / 10)));
    const ny = Math.max(3, Math.min(24, Math.round(area.h / 10)));
    const found = new Map<SceneLayer, number[]>();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const hit = layerAtPixel(scene, area.x + ((i + 0.5) / nx) * area.w, area.y + ((j + 0.5) / ny) * area.h, time);
        if (hit) found.set(hit.layer, [...(found.get(hit.layer) ?? []), hit.depth]);
      }
    }
    pick = null;
    for (const [layer, depths] of found) {
      if (depths.length < (nx * ny) / 8) continue;
      const depth = depths.sort((a, b) => a - b)[Math.floor(depths.length / 2)];
      if (!pick || depth < pick.depth) pick = { layer, depth };
    }
    pick ??= layerAtPixel(scene, area.x + area.w / 2, area.y + area.h / 2, time);
  }
  if (!pick) return { ok: false, depth: 0, on: "" };
  return { ok: hasDetail(scene, area, time), depth: pick.depth, on: pick.layer.name };
}

/** Whether the patch has enough contrast for AF to lock (a 5 % luminance spread; a smooth sky has less). */
function hasDetail(scene: Scene, area: Rect, time: number): boolean {
  const f = 4;
  const { rgb, w, h } = composite(scene, { w: scene.w / f, dofN: 8, focus: 3, time, motionBlur: false, t: 0, blur: false });
  // Small points are judged on a slightly larger patch, as the sensor's AF pixels see one.
  const pad = Math.max(0, (0.03 * scene.w - area.w) / 2);
  const x0 = Math.max(0, Math.floor((area.x - pad) / f));
  const y0 = Math.max(0, Math.floor((area.y - pad) / f));
  const x1 = Math.min(w, Math.ceil((area.x + area.w + pad) / f));
  const y1 = Math.min(h, Math.ceil((area.y + area.h + pad) / f));
  let n = 0, sum = 0, sum2 = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      const l = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
      n++;
      sum += l;
      sum2 += l * l;
    }
  }
  if (n < 2 || sum <= 0) return false;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return sd / mean >= 0.05;
}
