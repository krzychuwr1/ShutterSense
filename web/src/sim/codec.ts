// The simulated camera's image work inside a worker: encoding JPEGs and
// decoding scene images, on an OffscreenCanvas. Shared by the web demo's
// worker and the Android app's simulator host (web/sim-host).

import type { RgbaImage } from "../../../camsim/scenes.ts";

export async function encodeJpeg(rgba: Uint8ClampedArray, w: number, h: number, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Loads scene images from under `base`: decoded without colour management, alpha not premultiplied. */
export function imageLoader(base: string) {
  return async (path: string): Promise<RgbaImage> => {
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return { w: canvas.width, h: canvas.height, data };
  };
}
