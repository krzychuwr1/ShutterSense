// Connects a CCAPI client straight to a VirtualCamera in the same process.

import type { HttpResponse, Transport } from "../ccapi/client.ts";
import type { SimRequest, SimResponse } from "./camera.ts";

export function simTransport(handle: (req: SimRequest) => Promise<SimResponse>): Transport {
  return async (method, path, body, headers) => {
    const r = await handle({ method, path, body, headers });
    // The camera left the network (Wi-Fi disconnect, power off): like a dropped connection.
    if (r.closed) throw new Error("The connection to the camera was lost");
    return toHttp(r);
  };
}

export function toHttp(r: SimResponse): HttpResponse {
  const bytes = r.bytes ?? new TextEncoder().encode(r.json === undefined ? "" : JSON.stringify(r.json));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    status: r.status,
    contentType: r.bytes ? (r.contentType ?? "application/octet-stream") : "application/json",
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    bytes: async () => bytes,
    header: (name) => headers[name.toLowerCase()] ?? null,
  };
}
