// ImageTools for Node (tests and the end-to-end script), with jpeg-js.

import jpeg from "jpeg-js";
import type { ImageTools, PreparedImage } from "../agent/camera-tools.ts";
import { imageStats } from "../agent/image-stats.ts";

export const nodeImages: ImageTools = {
  async prepare(bytes: Uint8Array, maxSide: number, quality = 0.8): Promise<PreparedImage> {
    const img = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const out = new Uint8Array(w * h * 4);
    // Area average, good enough for downscaling.
    for (let y = 0; y < h; y++) {
      const sy0 = Math.floor(y / scale), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / scale));
      for (let x = 0; x < w; x++) {
        const sx0 = Math.floor(x / scale), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / scale));
        let r = 0, g = 0, b = 0, n = 0;
        for (let sy = sy0; sy < Math.min(sy1, img.height); sy++) {
          for (let sx = sx0; sx < Math.min(sx1, img.width); sx++) {
            const i = (sy * img.width + sx) * 4;
            r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
          }
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    const encoded = jpeg.encode({ data: Buffer.from(out.buffer), width: w, height: h }, Math.round(quality * 100)).data;
    return { dataUrl: `data:image/jpeg;base64,${Buffer.from(encoded).toString("base64")}`, w, h, stats: imageStats(out, w, h) };
  },
};
