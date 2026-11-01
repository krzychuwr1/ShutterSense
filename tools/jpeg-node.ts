// JPEG encoding for the simulator under Node (the browser uses OffscreenCanvas).

import jpeg from "jpeg-js";

export async function encodeJpegNode(rgba: Uint8ClampedArray, w: number, h: number, quality: number): Promise<Uint8Array> {
  const data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, Math.round(quality * 100)).data);
}
