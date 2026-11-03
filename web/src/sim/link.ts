// The page's side of the simulated camera: request/response over postMessage,
// and a CCAPI transport for the client.

import type { Transport } from "../../../ccapi/client.ts";
import type { SimResponse } from "../../../camsim/camera.ts";
import { toHttp } from "../../../camsim/transport.ts";

export class SimLink {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, (r: SimResponse) => void>();

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

  /** A CCAPI transport for the client. */
  transport(): Transport {
    return async (method, path, body) => toHttp(await this.request(method, path, body));
  }
}
