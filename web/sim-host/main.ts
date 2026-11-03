// Host page for the simulated camera inside the Android app (SimulatedCamera.kt).
// The app loads it in a headless WebView and calls `simRequest(...)`; the
// camera runs in a worker and every answer goes back through the
// `SimBridge` object the app injects. Nothing is drawn.

import type { FromWorker, HostReply, HostRequest } from "./protocol.ts";

/** The app's side of the bridge (an Android @JavascriptInterface). */
interface Bridge {
  ready(): void;
  fail(message: string): void;
  respond(id: number, status: number, contentType: string, headersJson: string, base64Body: string): void;
}

declare global {
  interface Window {
    SimBridge?: Bridge;
    simRequest(id: number, method: string, path: string, body: unknown, headers: Record<string, string> | null): void;
  }
}

const bridge: Bridge = window.SimBridge ?? {
  // Opened in a plain browser (for debugging): log instead.
  ready: () => console.log("simulator ready"),
  fail: (m) => console.error("simulator failed:", m),
  respond: (id, status, type, headers, body) => console.log(id, status, type, headers, `${body.length} base64 chars`),
};

let started = false;
const fail = (message: string) => {
  if (!started) bridge.fail(message);
  else console.error(message);
};
window.addEventListener("error", (e) => fail(e.message));
window.addEventListener("unhandledrejection", (e) => fail(String(e.reason)));

const worker = new Worker(new URL("./camera-worker.ts", import.meta.url), { type: "module" });
worker.onerror = (e) => fail(e.message || "The simulator worker failed to load");

/** Requests answered here rather than by the camera (diagnostics). */
const pageTiming = new Map<number, Promise<Record<string, unknown>>>();

worker.onmessage = async (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  if ("ready" in msg) {
    started = true;
    bridge.ready();
    return;
  }
  if ("error" in msg) {
    fail(msg.error);
    return;
  }
  const extra = pageTiming.get(msg.id);
  if (extra) {
    pageTiming.delete(msg.id);
    const merged = { ...JSON.parse(atob(msg.body64)), ...(await extra) };
    reply({ ...msg, body64: btoa(JSON.stringify(merged)) });
    return;
  }
  reply(msg);
};

function reply(r: HostReply) {
  bridge.respond(r.id, r.status, r.contentType, JSON.stringify(r.headers), r.body64);
}

/** Whether this page's own timers and frames keep running (it may be throttled when not on screen). */
async function measurePage(): Promise<Record<string, unknown>> {
  const late: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 100));
    late.push(Math.round(performance.now() - t0 - 100));
  }
  const frame = await Promise.race([
    new Promise<boolean>((r) => requestAnimationFrame(() => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ]);
  return { pageTimerLateMs: late, animationFrames: frame, visibility: document.visibilityState };
}

window.simRequest = (id, method, path, body, headers) => {
  if (path === "/host/timing") pageTiming.set(id, measurePage());
  const req: HostRequest = { id, method, path, body: body ?? undefined, headers: headers ?? undefined };
  worker.postMessage(req);
};

// Scene images live next to this page (assets/sim/scenes/...).
worker.postMessage({ init: new URL(".", location.href).href });
