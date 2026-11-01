// ImageTools for the browser: decode, downscale, re-encode, measure.

import type { ImageTools, PreparedImage } from "../../agent/camera-tools.ts";
import { imageStats } from "../../agent/image-stats.ts";

export const browserImages: ImageTools = {
  async prepare(jpeg: Uint8Array, maxSide: number, quality = 0.8): Promise<PreparedImage> {
    const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const stats = imageStats(ctx.getImageData(0, 0, w, h).data, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", quality), w, h, stats };
  },
};

export function blobUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
}
