// Connects a CCAPI client straight to a VirtualCamera in the same process.

import type { HttpResponse, Transport } from "../ccapi/client.ts";
import type { SimRequest, SimResponse } from "./camera.ts";

export function simTransport(handle: (req: SimRequest) => Promise<SimResponse>): Transport {
  return async (method, path, body) => toHttp(await handle({ method, path, body }));
}

export function toHttp(r: SimResponse): HttpResponse {
  const bytes = r.bytes ?? new TextEncoder().encode(r.json === undefined ? "" : JSON.stringify(r.json));
  return {
    status: r.status,
    contentType: r.bytes ? (r.contentType ?? "application/octet-stream") : "application/json",
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    bytes: async () => bytes,
  };
}
