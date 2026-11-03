// The virtual camera for the Android app, in a worker so rendering never
// blocks the page that relays requests. Same image loader and JPEG encoder as
// the web demo's worker (web/src/sim/codec.ts); answers go back already
// base64-encoded, which is what the app's bridge takes.

import { VirtualCamera } from "../../camsim/camera.ts";
import { handleSim } from "../../camsim/control.ts";
import { encodeJpeg, imageLoader } from "../src/sim/codec.ts";
import type { FromWorker, HostReply, HostRequest, WorkerInit } from "./protocol.ts";

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** How late this worker's timers fire (the camera's waits run on them). */
async function timing(): Promise<unknown> {
  const late: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 100));
    late.push(Math.round(performance.now() - t0 - 100));
  }
  return { workerTimerLateMs: late };
}

let camera: Promise<VirtualCamera> | null = null;

async function answer(req: HostRequest): Promise<HostReply> {
  const cam = await camera!;
  const t0 = performance.now();
  const res = req.path === "/host/timing" ? { status: 200, json: await timing() } : await handleSim(cam, req);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
  // Time the camera itself took, so the app can tell it apart from the bridge's.
  headers["x-sim-ms"] = String(Math.round(performance.now() - t0));
  const bytes = res.bytes ?? new TextEncoder().encode(res.json === undefined ? "" : JSON.stringify(res.json));
  return {
    id: req.id,
    status: res.closed ? 0 : res.status,
    contentType: res.bytes ? (res.contentType ?? "application/octet-stream") : "application/json",
    headers,
    body64: toBase64(bytes),
  };
}

self.onmessage = async (e: MessageEvent<HostRequest | WorkerInit>) => {
  const msg = e.data;
  if ("init" in msg) {
    const loadImage = imageLoader(msg.init);
    camera = VirtualCamera.create({ encodeJpeg, now: () => performance.now(), loadImage }, "concert");
    camera.then(
      () => post({ ready: true }),
      (err) => post({ error: String(err?.message ?? err) }),
    );
    return;
  }
  try {
    post(await answer(msg));
  } catch (err) {
    console.error(err);
    const body = new TextEncoder().encode(JSON.stringify({ message: "Internal error" }));
    post({ id: msg.id, status: 500, contentType: "application/json", headers: {}, body64: toBase64(body) });
  }
};
