// The page's side of the simulated camera: request/response over postMessage,
// a CCAPI transport for the client, and a log of every CCAPI call for the panel.

import type { Transport } from "../../../ccapi/client.ts";
import type { SimResponse } from "../../../camsim/camera.ts";
import { toHttp } from "../../../camsim/transport.ts";

export interface TrafficEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Request body, abbreviated. */
  body?: string;
}

export class SimLink {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, (r: SimResponse) => void>();
  private listeners = new Set<(e: TrafficEntry) => void>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<SimResponse & { id: number }>) => {
      const done = this.waiting.get(e.data.id);
      this.waiting.delete(e.data.id);
      done?.(e.data);
    };
  }

  request(method: string, path: string, body?: unknown): Promise<SimResponse> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, method, path, body });
    });
  }

  onTraffic(fn: (e: TrafficEntry) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A CCAPI transport that logs each call (the panel shows them). */
  transport(): Transport {
    return async (method, path, body) => {
      const t = performance.now();
      const res = await this.request(method, path, body);
      const entry: TrafficEntry = { method, path, status: res.status, ms: Math.round(performance.now() - t) };
      if (body !== undefined) entry.body = JSON.stringify(body).slice(0, 80);
      for (const l of this.listeners) l(entry);
      return toHttp(res);
    };
  }
}
