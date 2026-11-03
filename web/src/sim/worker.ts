// Web Worker hosting the virtual camera, so rendering never blocks the page.
// Messages: { id, method, path, body } in; { id, status, json?, bytes?, contentType? } out.

import { VirtualCamera } from "../../../camsim/camera.ts";
import { handleSim } from "../../../camsim/control.ts";
import { encodeJpeg, imageLoader } from "./codec.ts";

// Scene images come from the site's root (web/public/scenes).
const loadImage = imageLoader(new URL("/", location.href).href);
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
