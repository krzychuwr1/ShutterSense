// Scene images for the simulator under Node (tests, the HTTP simulator, the
// end-to-end runner): read from web/public, where the web demo fetches them.

import fs from "node:fs/promises";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { RgbaImage } from "../camsim/scenes.ts";

const ROOT = new URL("../web/public/", import.meta.url);

export async function loadImageNode(path: string): Promise<RgbaImage> {
  const bytes = await fs.readFile(new URL(path, ROOT));
  if (path.endsWith(".png")) {
    const png = PNG.sync.read(bytes);
    return { w: png.width, h: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  }
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { w: img.width, h: img.height, data: img.data };
}
