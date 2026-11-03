// Messages between the host page (main.ts) and the camera worker (camera-worker.ts).

export interface HostRequest {
  id: number;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A finished answer, ready for the app: the body is already base64. */
export interface HostReply {
  id: number;
  /** HTTP status; 0 means the camera left the network and the app should treat it as a dropped connection. */
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body64: string;
}

export type FromWorker = HostReply | { ready: true } | { error: string };

/** The first message to the worker: where the scene images are (the page's own folder). */
export interface WorkerInit {
  init: string;
}
