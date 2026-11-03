// Web Worker hosting the virtual camera, so rendering never blocks the page.
// Messages: { id, method, path, body } in; { id, status, json?, bytes?, contentType? } out.

import { VirtualCamera } from "../../../camsim/camera.ts";
import { handleSim } from "../../../camsim/control.ts";
import type { RgbaImage } from "../../../camsim/scenes.ts";

async function encodeJpeg(rgba: Uint8ClampedArray, w: number, h: number, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Scene images from the site: decoded without colour management, alpha not premultiplied. */
async function loadImage(path: string): Promise<RgbaImage> {
  const res = await fetch(`/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return { w: bitmap.width, h: bitmap.height, data };
}

const camera = VirtualCamera.create({ encodeJpeg, now: () => performance.now(), loadImage }, "concert");

self.onmessage = async (e: MessageEvent<{ id: number; method: string; path: string; body?: unknown }>) => {
  const { id, method, path, body } = e.data;
  try {
    const res = await handleSim(await camera, { method, path, body });
    const transfer = res.bytes ? [res.bytes.buffer as ArrayBuffer] : [];
    (self as unknown as Worker).postMessage({ id, ...res }, transfer);
  } catch (err) {
    console.error(err);
    (self as unknown as Worker).postMessage({ id, status: 500, json: { message: "Internal error" } });
  }
};
