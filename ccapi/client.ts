// CCAPI client (TypeScript).
// Every call is routed through discovery (GET /ccapi), because
// which API version hosts an endpoint differs per camera model; when an
// endpoint exists under several versions the highest one wins.
//
// The transport is pluggable: the web demo talks to the simulator in a Web
// Worker, Node talks HTTP. The Android app has its own Kotlin client with the
// same behaviour (android/app/src/main/java/.../ccapi).

export interface HttpResponse {
  status: number;
  contentType: string;
  json(): Promise<unknown>;
  bytes(): Promise<Uint8Array>;
}

export type Transport = (method: string, path: string, body?: unknown) => Promise<HttpResponse>;

export class CcapiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(status: number, message: string, endpoint: string) {
    super(message);
    this.status = status;
    this.endpoint = endpoint;
  }
}

export interface Endpoint {
  version: string;
  path: string;
  get: boolean;
  post: boolean;
  put: boolean;
  delete: boolean;
}

export type Ability = string[] | { min: number | null; max: number | null; step: number | null };

export interface SettingItem {
  value: string | number | null;
  ability: Ability;
}

export type Settings = Record<string, SettingItem>;

/** A rejected setting change, worded so a model (or a person) can fix it. */
export class SettingError extends Error {
  readonly setting: string;
  constructor(setting: string, message: string) {
    super(message);
    this.setting = setting;
  }
}

const versionNumber = (v: string) => Number(v.replace(/^ver/, "")) || 0;

/** "/ccapi/ver110/shooting/settings/shootingmode" -> ["ver110", "shooting/settings/shootingmode"]. */
function splitPath(path: string): [string, string] | null {
  const m = path.match(/^\/ccapi\/(ver\d+)\/(.+?)\/?$/);
  return m ? [m[1], m[2]] : null;
}

export function fetchTransport(base: string, init: { fetch?: typeof fetch; headers?: Record<string, string> } = {}): Transport {
  const f = init.fetch ?? fetch;
  return async (method, path, body) => {
    const res = await f(base.replace(/\/$/, "") + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      json: async () => JSON.parse(new TextDecoder().decode(buf)),
      bytes: async () => buf,
    };
  };
}

export class CcapiClient {
  /** Endpoint key (path after the version) -> best endpoint per method. */
  private endpoints = new Map<string, Endpoint[]>();
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // ---------------------------------------------------------------- plumbing

  private async call(method: string, path: string, body?: unknown): Promise<HttpResponse> {
    const res = await this.transport(method, path, body);
    if (res.status >= 200 && res.status < 300) return res;
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string };
      if (data?.message) message = data.message.trim();
    } catch {
      // not JSON
    }
    throw new CcapiError(res.status, message, path);
  }

  private async callJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    if (!res.contentType.includes("json")) {
      const bytes = await res.bytes();
      if (!bytes.length) return {} as T;
    }
    return (await res.json()) as T;
  }

  /** Reads the endpoint list. Activation-free cameras answer on topurlfordev instead of /ccapi. */
  async discover(): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = await this.callJson("GET", "/ccapi");
    } catch (e) {
      if (!(e instanceof CcapiError) || e.status !== 404) throw e;
      data = await this.callJson("GET", "/ccapi/ver100/topurlfordev");
    }
    this.endpoints.clear();
    for (const [version, list] of Object.entries(data)) {
      if (!/^ver\d+$/.test(version) || !Array.isArray(list)) continue;
      for (const raw of list as Array<Record<string, unknown>>) {
        // Older cameras list absolute URLs ("url"), newer ones paths ("path").
        let path = typeof raw.path === "string" ? raw.path : "";
        if (!path && typeof raw.url === "string") {
          try {
            path = new URL(raw.url).pathname;
          } catch {
            continue;
          }
        }
        const parts = splitPath(path);
        if (!parts) continue;
        const ep: Endpoint = { version: parts[0], path: `/ccapi/${parts[0]}/${parts[1]}`, get: !!raw.get, post: !!raw.post, put: !!raw.put, delete: !!raw.delete };
        const list2 = this.endpoints.get(parts[1]) ?? [];
        list2.push(ep);
        list2.sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
        this.endpoints.set(parts[1], list2);
      }
    }
    if (!this.endpoints.size) throw new CcapiError(0, "The camera listed no API endpoints", "/ccapi");
  }

  /** The highest-version path for `key` that supports `method`, or null. */
  endpoint(key: string, method: "get" | "post" | "put" | "delete" = "get"): string | null {
    return this.endpoints.get(key)?.find((e) => e[method])?.path ?? null;
  }

  has(key: string, method: "get" | "post" | "put" | "delete" = "get") {
    return this.endpoint(key, method) !== null;
  }

  private need(key: string, method: "get" | "post" | "put" | "delete"): string {
    const p = this.endpoint(key, method);
    if (!p) throw new CcapiError(404, `This camera has no ${method.toUpperCase()} ${key}`, key);
    return p;
  }

  // ---------------------------------------------------------------- device

  deviceInfo() {
    return this.callJson<Record<string, string>>("GET", this.need("deviceinformation", "get"));
  }

  /** Battery level as a short string ("full", "75%"), or null if unknown. */
  async battery(): Promise<string | null> {
    try {
      if (this.has("devicestatus/batterylist")) {
        const d = await this.callJson<{ batterylist?: Array<{ position: string; level: string }> }>("GET", this.need("devicestatus/batterylist", "get"));
        const b = d.batterylist?.find((x) => x.position === "camera") ?? d.batterylist?.[0];
        if (b) return /^\d+$/.test(b.level) ? `${b.level}%` : b.level;
      }
      if (this.has("devicestatus/battery")) {
        const d = await this.callJson<{ level?: string }>("GET", this.need("devicestatus/battery", "get"));
        return d.level ?? null;
      }
    } catch {
      // battery is informational only
    }
    return null;
  }

  async lens(): Promise<string | null> {
    if (!this.has("devicestatus/lens")) return null;
    try {
      const d = await this.callJson<{ mount?: boolean; name?: string }>("GET", this.need("devicestatus/lens", "get"));
      return d.mount && d.name ? d.name : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- settings

  /** All shooting settings, merging every version's bulk list (higher versions win). */
  async settings(): Promise<Settings> {
    const out: Settings = {};
    const versions = (this.endpoints.get("shooting/settings") ?? []).filter((e) => e.get).reverse(); // low -> high
    for (const ep of versions) Object.assign(out, await this.callJson<Settings>("GET", ep.path));
    // The mode lives outside the bulk list on some models.
    for (const key of ["shootingmode", "shootingmodedial"]) {
      const p = this.endpoint(`shooting/settings/${key}`, "get");
      if (p && !(key in out && (out[key].value ?? "") !== "")) {
        try {
          out[key] = await this.callJson<SettingItem>("GET", p);
        } catch {
          // not available in this state
        }
      }
    }
    return out;
  }

  async setting(name: string): Promise<SettingItem> {
    return this.callJson<SettingItem>("GET", this.need(`shooting/settings/${name}`, "get"));
  }

  /**
   * Changes one setting after checking the value against what the camera
   * says it accepts right now, so a mistake comes back as a precise message.
   */
  async set(name: string, value: string | number, current?: SettingItem): Promise<void> {
    if (name === "shootingmode" || name === "shootingmodedial") return this.setMode(String(value));
    const path = this.endpoint(`shooting/settings/${name}`, "put");
    if (!path) throw new SettingError(name, `${name} can't be changed on this camera.`);
    const item = current ?? (await this.setting(name));
    checkValue(name, value, item);
    try {
      await this.call("PUT", path, { value });
    } catch (e) {
      if (e instanceof CcapiError) throw new SettingError(name, `${name} = ${JSON.stringify(value)} was refused by the camera (${e.message}).`);
      throw e;
    }
  }

  /**
   * Changes the shooting mode. Cameras with a physical mode dial only accept
   * this after "ignore shooting mode dial" is switched on.
   */
  async setMode(mode: string): Promise<void> {
    const path = this.endpoint("shooting/settings/shootingmode", "put") ?? this.endpoint("shooting/settings/shootingmodedial", "put");
    if (!path) throw new SettingError("shootingmode", "The shooting mode is set by the camera's mode dial and can't be changed remotely.");
    const item = await this.callJson<SettingItem>("GET", path);
    if (Array.isArray(item.ability) && item.ability.length && !item.ability.includes(mode)) {
      throw new SettingError("shootingmode", `shootingmode "${mode}" is not available. Options: ${item.ability.join(", ")}.`);
    }
    try {
      await this.call("PUT", path, { value: mode });
    } catch (e) {
      const ignore = this.endpoint("shooting/control/ignoreshootingmodedialmode", "post");
      if (!(e instanceof CcapiError) || e.status !== 503 || !ignore) {
        throw new SettingError("shootingmode", `The camera refused shootingmode "${mode}" (${e instanceof Error ? e.message : e}).`);
      }
      await this.call("POST", ignore, { action: "on" });
      try {
        await this.call("PUT", path, { value: mode });
      } catch (e2) {
        throw new SettingError("shootingmode", `The camera refused shootingmode "${mode}" (${e2 instanceof Error ? e2.message : e2}).`);
      }
    }
  }

  // ---------------------------------------------------------------- live view and shooting

  async startLiveView(size: "small" | "medium" = "small"): Promise<void> {
    await this.call("POST", this.need("shooting/liveview", "post"), { liveviewsize: size, cameradisplay: "on" });
  }

  /** One live-view JPEG. Starts live view if needed; the first frames after starting may not be ready. */
  async liveFrame(): Promise<Uint8Array> {
    const path = this.need("shooting/liveview/flip", "get");
    for (let attempt = 0; ; attempt++) {
      try {
        return await (await this.call("GET", path)).bytes();
      } catch (e) {
        if (!(e instanceof CcapiError) || e.status !== 503 || attempt >= 4) throw e;
        if (/not started/i.test(e.message)) await this.startLiveView();
        await sleep(250 * (attempt + 1));
      }
    }
  }

  /** Full press and release, with or without autofocus. */
  async shutter(af: boolean): Promise<void> {
    const path = this.endpoint("shooting/control/shutterbutton", "post");
    if (path) {
      await this.call("POST", path, { af });
      return;
    }
    const manual = this.need("shooting/control/shutterbutton/manual", "post");
    await this.call("POST", manual, { action: "full_press", af });
    await this.call("POST", manual, { action: "release", af: false });
  }

  /**
   * Changes since the last poll. ver110+ supports a long-poll timeout; ver100
   * returns immediately with continue=off.
   */
  async poll(wait: "immediately" | "short" = "immediately"): Promise<Record<string, unknown>> {
    const eps = (this.endpoints.get("event/polling") ?? []).filter((e) => e.get);
    const ep = eps[0];
    if (!ep) throw new CcapiError(404, "This camera has no event polling", "event/polling");
    const q = versionNumber(ep.version) >= 110 ? `?timeout=${wait}` : "?continue=off";
    return this.callJson<Record<string, unknown>>("GET", ep.path + q);
  }

  /** Waits for the next file the camera writes and returns its path (JPEG preferred). */
  async waitForNewFile(timeoutMs = 15_000, onEvent?: (e: Record<string, unknown>) => void): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const hasVersion110 = (this.endpoints.get("event/polling") ?? []).some((e) => versionNumber(e.version) >= 110);
    while (Date.now() < deadline) {
      const ev = await this.poll(hasVersion110 ? "short" : "immediately");
      onEvent?.(ev);
      const added = Array.isArray(ev.addedcontents) ? (ev.addedcontents as unknown[]).map(String) : [];
      const files = added.map(toPath).filter((p) => /\.[a-z0-9]{3,4}$/i.test(p));
      const jpeg = files.find((p) => /\.jpe?g$/i.test(p));
      if (jpeg || files.length) return jpeg ?? files[0];
      if (!hasVersion110) await sleep(300);
    }
    throw new CcapiError(504, "The camera didn't report a new photo in time", "event/polling");
  }

  /** Downloads a file: a display-size JPEG when the camera offers one, else the original. */
  async download(path: string, kind: "display" | "thumbnail" | "main" = "display"): Promise<Uint8Array> {
    try {
      return await (await this.call("GET", `${path}?kind=${kind}`)).bytes();
    } catch (e) {
      if (e instanceof CcapiError && e.status === 400 && kind !== "main") return (await this.call("GET", `${path}?kind=main`)).bytes();
      throw e;
    }
  }
}

/** Validates a value against an ability, with messages that list what would work. */
export function checkValue(name: string, value: string | number, item: SettingItem) {
  const ab = item.ability;
  if (Array.isArray(ab)) {
    if (!ab.length) throw new SettingError(name, `${name} can't be changed in the current shooting mode.`);
    if (typeof value !== "string" || !ab.includes(value)) {
      const shown = ab.length > 40 ? `${ab.slice(0, 40).join(", ")}, …` : ab.join(", ");
      throw new SettingError(name, `${name} = ${JSON.stringify(value)} is not accepted. Options: ${shown}.`);
    }
    return;
  }
  if (ab.min === null || ab.max === null) throw new SettingError(name, `${name} can't be changed in the current shooting mode.`);
  const step = ab.step || 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < ab.min || value > ab.max || (value - ab.min) % step) {
    throw new SettingError(name, `${name} must be a whole number from ${ab.min} to ${ab.max} in steps of ${step}.`);
  }
}

function toPath(p: string): string {
  if (/^https?:\/\//.test(p)) {
    try {
      return new URL(p).pathname;
    } catch {
      return p;
    }
  }
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
