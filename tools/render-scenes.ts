// Renders every simulator scene as JPEGs: the picker thumbnails in
// web/public/scenes, and (with an output directory) full-size test renders at
// evaluative and spot metering to check the scenes by eye.
//   npm run render-scenes            thumbnails only
//   npm run render-scenes -- <dir>   plus full-size renders in <dir>

import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { meter, render } from "../camsim/render.ts";
import { loadScene, SCENE_IDS, type Scene } from "../camsim/scenes.ts";
import { loadImageNode } from "./scene-files-node.ts";

const out = process.argv[2];

/** Exposure tweaks for a nicer thumbnail, in stops, + = brighter (a dark venue fools the meter into overexposing the singer). */
const THUMB_BIAS: Record<string, number> = { concert: -1.3 };

function shot(sc: Scene, w: number, mode: string) {
  const focus = sc.layers.find((l) => l.name === sc.subject.layer)!.depth;
  const ev = meter(sc, mode, 0.1) - (THUMB_BIAS[sc.id] ?? 0);
  const N = 2.8;
  let t = (N * N) / 2 ** ev;
  let iso = 100;
  // Freeze moving subjects: a fast shutter, with ISO making up the light.
  if (sc.layers.some((l) => l.motion) && t > 1 / 500) {
    iso = Math.round((100 * t) / (1 / 500));
    t = 1 / 500;
  }
  return { ev, t, r: render(sc, { w, N, t, iso, dofN: N, focus, wbK: sc.lightK, pictureStyle: "standard", time: 0.1, motionBlur: true, shake: 0, seed: 1 }) };
}

const save = (file: string, r: { rgba: Uint8ClampedArray; w: number; h: number }, q: number) =>
  fs.writeFileSync(file, jpeg.encode({ data: Buffer.from(r.rgba.buffer), width: r.w, height: r.h }, q).data);

fs.mkdirSync("web/public/scenes", { recursive: true });
for (const id of SCENE_IDS) {
  const sc = await loadScene(id, loadImageNode);
  save(`web/public/scenes/${id}.jpg`, shot(sc, sc.w / 4, "partial").r, 80);
  if (!out) continue;
  fs.mkdirSync(out, { recursive: true });
  for (const mode of ["evaluative", "spot"]) {
    const { ev, t, r } = shot(sc, sc.w, mode);
    const file = path.join(out, `${id}-${mode}.jpg`);
    save(file, r, 85);
    console.log(`${file}: metered EV ${ev.toFixed(2)}, 1/${(1 / t).toFixed(0)} s at f/2.8`);
  }
}
console.log("thumbnails written to web/public/scenes");
