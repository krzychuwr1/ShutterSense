// Turns generated scene layers (1536×1024 PNGs) into the simulator's assets
// in web/public/scenes/<scene>/: resized to the scene size, opaque plates as
// JPEG, cut-outs as PNG with alpha.
//   npm run prepare-scenes -- <dir with a folder per scene> [scene ...]
// (only the named scenes, or every scene with a folder in <dir>).

import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { SCENE_H, SCENE_W } from "../camsim/scenes.ts";

const FILES: Record<string, Record<string, "jpg" | "png">> = {
  dog: { plate: "jpg", dog: "png" },
  dinner: { room: "jpg", man: "png", table: "png" },
  gym: { plate: "jpg", defender: "png", player: "png" },
  concert: { plate: "jpg", band: "png", singer: "png", crowd: "png" },
  group: { plate: "jpg", back: "png", middle: "png", front: "png" },
};

const [src, ...only] = process.argv.slice(2);
if (!src) {
  console.error("usage: npm run prepare-scenes -- <dir> [scene ...]");
  process.exit(1);
}
const unknown = only.filter((s) => !(s in FILES));
if (unknown.length) {
  console.error(`unknown scene ${unknown.join(", ")}; scenes are ${Object.keys(FILES).join(", ")}`);
  process.exit(1);
}

/** Area-weighted resize of premultiplied RGBA, one axis at a time. */
function resize(data: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  // The generator's cut-outs top out a little under 255: stretch to fully opaque.
  let top = 0;
  for (let i = 3; i < data.length; i += 4) top = Math.max(top, data[i]);
  const stretch = top > 200 ? 255 / (top - 2) : 1;
  const pre = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, (data[i * 4 + 3] * stretch) / 255);
    pre[i * 4] = data[i * 4] * a;
    pre[i * 4 + 1] = data[i * 4 + 1] * a;
    pre[i * 4 + 2] = data[i * 4 + 2] * a;
    pre[i * 4 + 3] = a * 255;
  }
  const axis = (buf: Float32Array, len: number, lines: number, olen: number, horizontal: boolean, srcW: number, outW: number) => {
    const out = new Float32Array((horizontal ? olen * lines : outW * olen) * 4);
    const s = len / olen;
    for (let line = 0; line < lines; line++) {
      for (let o = 0; o < olen; o++) {
        const a0 = o * s, a1 = (o + 1) * s;
        const acc = [0, 0, 0, 0];
        for (let i = Math.floor(a0); i < Math.min(len, Math.ceil(a1)); i++) {
          const wt = Math.min(a1, i + 1) - Math.max(a0, i);
          const j = (horizontal ? line * srcW + i : i * srcW + line) * 4;
          for (let c = 0; c < 4; c++) acc[c] += buf[j + c] * wt;
        }
        const k = (horizontal ? line * olen + o : o * outW + line) * 4;
        for (let c = 0; c < 4; c++) out[k + c] = acc[c] / s;
      }
    }
    return out;
  };
  const tmp = axis(pre, w, h, ow, true, w, ow);
  const res = axis(tmp, h, ow, oh, false, ow, ow);
  const out = new Uint8Array(ow * oh * 4);
  for (let i = 0; i < ow * oh; i++) {
    const a = res[i * 4 + 3];
    // Faint fringes the generator leaves around a cut-out are dropped.
    if (a < 6) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.min(255, Math.round(res[i * 4 + c] / (a / 255)));
    out[i * 4 + 3] = Math.round(a);
  }
  return out;
}

for (const [scene, layers] of Object.entries(FILES)) {
  if (only.length ? !only.includes(scene) : !fs.existsSync(path.join(src, scene))) continue;
  const dir = path.join("web/public/scenes", scene);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, kind] of Object.entries(layers)) {
    const png = PNG.sync.read(fs.readFileSync(path.join(src, scene, `${name}.png`)));
    const data = resize(new Uint8Array(png.data), png.width, png.height, SCENE_W, SCENE_H);
    const file = path.join(dir, `${name}.${kind}`);
    if (kind === "jpg") {
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      fs.writeFileSync(file, jpeg.encode({ data: Buffer.from(data.buffer), width: SCENE_W, height: SCENE_H }, 90).data);
    } else {
      const out = new PNG({ width: SCENE_W, height: SCENE_H });
      out.data = Buffer.from(data.buffer);
      fs.writeFileSync(file, PNG.sync.write(out, { colorType: 6 }));
    }
    console.log(`${file}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
}
