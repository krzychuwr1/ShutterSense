// CCAPI client (TypeScript).
// Every call is routed through discovery (GET /ccapi), because
// which API version hosts an endpoint differs per camera model; when an
// endpoint exists under several versions the highest one wins.
//
// The transport is pluggable: the web demo talks to the simulator in a Web
// Worker, Node talks HTTP. The Android app has its own Kotlin client with the
// same behaviour (android/app/src/main/java/.../ccapi).
//
// Coverage: discovery, device information and status, the camera functions
// (/functions/*, /customfunction/*), every shooting setting (list, range and
// composite values, picture style detail, DELETE resets), shooting control
// (shutter, AF, focus drive, movie, zoom, flicker), live view (single
// frames, framed records with incidental info, the bounded stream answers,
// RTP), the optical-viewfinder AF APIs, events (polling in both versions,
// monitoring) and contents (browse, page, count, chunked lists, info, range
// downloads, modify, delete).

export interface HttpResponse {
  status: number;
  contentType: string;
  json(): Promise<unknown>;
  bytes(): Promise<Uint8Array>;
  /** A response header (any case), if the transport exposes headers. */
  header?(name: string): string | null;
}

export type Transport = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<HttpResponse>;

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

/** A setting whose value is an object (wbshift, stillimagequality, picture style detail, powerzoom). */
export interface CompositeItem {
  value: Record<string, string | number | null>;
  ability: Record<string, Ability>;
}

export type AnySettingItem = SettingItem | CompositeItem;
export type SettingValue = string | number | Record<string, string | number>;

/** The bulk list. Composite entries (wbshift, picturestyle_*, …) are CompositeItems at runtime; see isComposite. */
export type Settings = Record<string, SettingItem>;

export interface StorageInfo {
  name: string;
  /** Contents path of the storage (absolute URLs from older cameras are reduced to paths). */
  path: string;
  accesscapability: "readwrite" | "readonly" | string;
  maxsize: number;
  spacesize: number;
  contentsnumber: number;
}

export interface BatteryInfo {
  position: string;
  name: string;
  kind: string;
  /** Percentage "0".."100" (batterylist), or a level word (battery): full, high, half, quarter, low, … */
  level: string;
  quality: string;
}

export interface FileInfo {
  filesize: number;
  protect: "enable" | "disable";
  archive: "enable" | "disable";
  rotate: "0" | "90" | "180" | "270";
  rating: "off" | "1" | "2" | "3" | "4" | "5";
  lastmodifieddate: string;
  playtime: number | null;
  hdr?: "pq" | "off";
}

export type FileKind = "main" | "display" | "thumbnail" | "embedded";

export interface LiveRect {
  positionx: number;
  positiony: number;
  positionwidth: number;
  positionheight: number;
}

/** Live view incidental information (coordinates in still-image Large pixels). */
export interface LiveViewInfo {
  liveviewdata?: {
    /** Y, R, G, B; 256 bins each. */
    histogram?: number[][];
    afframe?: Array<{ status: number; select: number; x: number; y: number; width: number; height: number }>;
    image?: LiveRect & { sizex: number; sizey: number };
    visible?: LiveRect;
    zoom?: LiveRect & { magnification: number };
    diorama?: LiveRect;
    systemtime?: { sec: number; subsec: number };
  };
  angleinformation?: { cameraposture: number; rolling: number; pitching: number };
}

export interface LiveDetail {
  image?: Uint8Array;
  info?: LiveViewInfo;
}

/** A framed record: FF 00 <type> <size:4> <data> FF FF. Types: 0 JPEG, 1 info JSON, 2 event JSON. */
export interface FramedRecord {
  type: number;
  data: Uint8Array;
}

/** A rejected setting change, worded so a model (or a person) can fix it. */
export class SettingError extends Error {
  readonly setting: string;
  constructor(setting: string, message: string) {
    super(message);
    this.setting = setting;
  }
}

type Method = "get" | "post" | "put" | "delete";

const versionNumber = (v: string) => Number(v.replace(/^ver/, "")) || 0;

/** "/ccapi/ver110/shooting/settings/shootingmode" -> ["ver110", "shooting/settings/shootingmode"]. */
function splitPath(path: string): [string, string] | null {
  const m = path.match(/^\/ccapi\/(ver\d+)\/(.+?)\/?$/);
  return m ? [m[1], m[2]] : null;
}

export function fetchTransport(base: string, init: { fetch?: typeof fetch; headers?: Record<string, string> } = {}): Transport {
  const f = init.fetch ?? fetch;
  return async (method, path, body, headers) => {
    const res = await f(base.replace(/\/$/, "") + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      json: async () => JSON.parse(new TextDecoder().decode(buf)),
      bytes: async () => buf,
      header: (name) => res.headers.get(name),
    };
  };
}

export class CcapiClient {
  /** Endpoint key (path after the version) -> its endpoints, highest version first. */
  private endpoints = new Map<string, Endpoint[]>();
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // ---------------------------------------------------------------- plumbing

  private async call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse> {
    const res = await this.transport(method, path, body, headers);
    if (res.status >= 200 && res.status < 300) return res;
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: unknown };
      if (typeof data?.message === "string" && data.message.trim()) message = data.message.trim();
    } catch {
      // not JSON
    }
    throw new CcapiError(res.status, message, path);
  }

  /** The answer as JSON; an empty body is an empty object. */
  private async callJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    if (!(await res.bytes()).length) return {} as T;
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
      for (const raw of list as Array<Record<string, unknown> | null>) {
        if (!raw || typeof raw !== "object") continue;
        // Older cameras list absolute URLs ("url"), newer ones paths ("path").
        let path = typeof raw.path === "string" ? raw.path.trim() : "";
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
        const eps = this.endpoints.get(parts[1]) ?? [];
        eps.push(ep);
        this.endpoints.set(parts[1], eps);
      }
    }
    for (const eps of this.endpoints.values()) eps.sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
    if (!this.endpoints.size) throw new CcapiError(0, "The camera listed no API endpoints", "/ccapi");
  }

  /** The highest-version path for `key` that supports `method`, or null. */
  endpoint(key: string, method: Method = "get"): string | null {
    return this.endpoints.get(key)?.find((e) => e[method])?.path ?? null;
  }

  has(key: string, method: Method = "get") {
    return this.endpoint(key, method) !== null;
  }

  /** Every discovered endpoint key (path after the version). */
  keys(): string[] {
    return [...this.endpoints.keys()];
  }

  private need(key: string, method: Method): string {
    const p = this.endpoint(key, method);
    if (!p) throw new CcapiError(404, `This camera has no ${method.toUpperCase()} ${key}`, key);
    return p;
  }

  /** The contents root path: content URLs live below it, not in the endpoint list. */
  private contentsRoot(): string {
    return this.need("contents", "get");
  }

  // ---------------------------------------------------------------- device

  async deviceInfo(): Promise<Record<string, string>> {
    const d = await this.callJson<Record<string, string>>("GET", this.need("deviceinformation", "get"));
    // Accept the misspelt key "munufacturer" too.
    if (d.manufacturer === undefined && d.munufacturer !== undefined) d.manufacturer = d.munufacturer;
    return d;
  }

  /** Battery level as a short string ("full", "75%"), or null if unknown. */
  async battery(): Promise<string | null> {
    try {
      const list = await this.batteries();
      const b = list.find((x) => x.position === "camera") ?? list[0];
      if (b) return /^\d+$/.test(b.level) ? `${b.level}%` : b.level;
    } catch {
      // battery is informational only
    }
    return null;
  }

  /** Every battery (body and grip): batterylist when offered, else the single battery as position "camera". */
  async batteries(): Promise<BatteryInfo[]> {
    if (this.has("devicestatus/batterylist")) {
      const d = await this.callJson<{ batterylist?: BatteryInfo[] }>("GET", this.need("devicestatus/batterylist", "get"));
      if (d.batterylist?.length) return d.batterylist;
    }
    const d = await this.callJson<Omit<BatteryInfo, "position">>("GET", this.need("devicestatus/battery", "get"));
    return [{ position: "camera", ...d }];
  }

  async lens(): Promise<string | null> {
    if (!this.has("devicestatus/lens")) return null;
    try {
      const d = await this.lensInfo();
      return d.mount && d.name ? d.name : null;
    } catch {
      return null;
    }
  }

  lensInfo() {
    return this.callJson<{ mount: boolean; name: string }>("GET", this.need("devicestatus/lens", "get"));
  }

  /** normal, warning, frameratedown, disableliveview, disablerelease, … */
  async temperature(): Promise<string> {
    return (await this.callJson<{ status: string }>("GET", this.need("devicestatus/temperature", "get"))).status;
  }

  powerZoomStatus() {
    return this.callJson<Record<string, string | boolean>>("GET", this.need("devicestatus/powerzoomstatus", "get"));
  }

  /** Mounted storages; empty when no card is in. */
  async storage(): Promise<StorageInfo[]> {
    const d = await this.callJson<{ storagelist?: Array<StorageInfo & { url?: string }> }>("GET", this.need("devicestatus/storage", "get"));
    return (d.storagelist ?? []).map(({ url, ...s }) => ({ ...s, path: s.path ?? (url ? toPath(url) : "") }));
  }

  /** The storage new files go to ({name:"", path:""} without a card). */
  currentStorage() {
    return this.callJson<{ name: string; path: string }>("GET", this.need("devicestatus/currentstorage", "get"));
  }

  /** The folder new files go to. */
  currentDirectory() {
    return this.callJson<{ name: string; path: string }>("GET", this.need("devicestatus/currentdirectory", "get"));
  }

  /** Step sizes the camera's custom functions use ("1/3", "1/2", …). */
  async increments(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const k of ["av", "tv", "exposure", "flashexposure"]) {
      const p = this.endpoint(`customfunction/exposureincrements/${k}`);
      if (p) out[k] = (await this.callJson<{ value: string }>("GET", p)).value;
    }
    const iso = this.endpoint("customfunction/isoincrements");
    if (iso) out.iso = (await this.callJson<{ value: string }>("GET", iso)).value;
    return out;
  }

  // ---------------------------------------------------------------- camera functions

  /** GET functions/<name> as the camera returns it. */
  getFunction<T = Record<string, unknown>>(name: string): Promise<T> {
    return this.callJson<T>("GET", this.need(`functions/${name}`, "get"));
  }
  putFunction<T = Record<string, unknown>>(name: string, body: unknown): Promise<T> {
    return this.callJson<T>("PUT", this.need(`functions/${name}`, "put"), body);
  }
  postFunction<T = Record<string, unknown>>(name: string, body: unknown): Promise<T> {
    return this.callJson<T>("POST", this.need(`functions/${name}`, "post"), body);
  }
  deleteFunction<T = Record<string, unknown>>(name: string): Promise<T> {
    return this.callJson<T>("DELETE", this.need(`functions/${name}`, "delete"));
  }

  /** A {value, ability} function such as beep, displayoff, autopoweroff, cors/corssetting, cardselection/stillimage. */
  functionSetting(name: string): Promise<SettingItem> {
    return this.getFunction<SettingItem>(name);
  }

  /** Changes a {value, ability} function after checking the value against its ability. */
  async setFunction(name: string, value: string | number): Promise<void> {
    const path = this.need(`functions/${name}`, "put");
    checkValue(name, value, await this.functionSetting(name));
    await this.putValue(name, path, value);
  }

  /** PUT {value}, with a camera refusal reworded as a SettingError. */
  private async putValue(name: string, path: string, value: SettingValue): Promise<void> {
    try {
      await this.call("PUT", path, { value });
    } catch (e) {
      if (e instanceof CcapiError) throw new SettingError(name, `${name} = ${JSON.stringify(value)} was refused by the camera (${e.message}).`);
      throw e;
    }
  }

  /** The camera clock: an RFC 1123 date with a numeric zone, and whether daylight saving is on. */
  datetime() {
    return this.getFunction<{ datetime: string; dst: boolean }>("datetime");
  }

  /**
   * Sets the camera clock. `offsetMinutes` is the zone east of UTC (defaults
   * to this machine's); with `dst` the wall-clock time already includes the shift.
   */
  async setDatetime(when: Date, dst = false, offsetMinutes = -when.getTimezoneOffset()): Promise<void> {
    await this.putFunction("datetime", { datetime: formatCameraDate(when, offsetMinutes), dst });
  }

  /** Formats a card (all files, protected ones too, are erased). `name` as in storage(), e.g. "card1". */
  async formatCard(name: string): Promise<void> {
    await this.postFunction("cardformat", { name });
  }

  /** copyright, author, ownername or nickname. */
  async registeredName(field: "copyright" | "author" | "ownername" | "nickname"): Promise<string> {
    return (await this.getFunction<Record<string, string>>(`registeredname/${field}`))[field] ?? "";
  }
  async setRegisteredName(field: "copyright" | "author" | "ownername" | "nickname", value: string): Promise<void> {
    await this.putFunction(`registeredname/${field}`, { [field]: value });
  }
  async clearRegisteredName(field: "copyright" | "author" | "ownername" | "nickname"): Promise<void> {
    await this.deleteFunction(`registeredname/${field}`);
  }

  /** Cleans the sensor; with autoPowerOff the camera switches off afterwards (the connection ends). */
  async sensorCleaning(autoPowerOff: boolean): Promise<void> {
    await this.postFunction("sensorcleaning", { autopoweroff: autoPowerOff });
  }

  /** Ends the Wi-Fi connection (202); the camera then has to be reconnected from its menu. */
  async wifiDisconnect(): Promise<void> {
    await this.postFunction("wificonnection", { action: "disconnect" });
  }

  /** Wired / multi-network bodies: "disconnect" or "reboot" the network function (202). */
  async networkConnection(action: "disconnect" | "reboot"): Promise<void> {
    await this.postFunction("networkconnection", { action });
  }

  /** Creates a folder (name: "" for the camera's default, or 5 of A-Z 0-9 _); it becomes the recording folder. */
  async createDirectory(name = ""): Promise<void> {
    await this.postFunction("directory/createdirectory", { directoryname: name });
  }

  /** The stored Wi-Fi settings (set1..set3). */
  wifiSettings() {
    return this.getFunction<Record<string, Record<string, string>>>("wifisetting");
  }
  wifiSetting(set: "set1" | "set2" | "set3") {
    return this.getFunction<Record<string, string>>(`wifisetting/${set}`);
  }
  setWifiSetting(set: "set1" | "set2" | "set3", setting: Record<string, string>) {
    return this.putFunction<Record<string, string>>(`wifisetting/${set}`, setting);
  }
  deleteWifiSetting(set: "set1" | "set2" | "set3") {
    return this.deleteFunction<Record<string, string>>(`wifisetting/${set}`);
  }

  /** The HTTPS root certificate (application/x-x509-user-cert). */
  async caCertificate(): Promise<Uint8Array> {
    return (await this.call("GET", this.need("functions/ssl/cacert", "get"))).bytes();
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

  /**
   * The endpoint key of a setting. Accepts the path form ("picturestyle/auto")
   * and the bulk-list form ("picturestyle_auto").
   */
  settingKey(name: string): string {
    if (this.endpoints.has(`shooting/settings/${name}`)) return name;
    const slashed = name.replace(/_/g, "/");
    return this.endpoints.has(`shooting/settings/${slashed}`) ? slashed : name;
  }

  async setting(name: string): Promise<SettingItem> {
    return this.callJson<SettingItem>("GET", this.need(`shooting/settings/${this.settingKey(name)}`, "get"));
  }

  /** A composite setting (wbshift, stillimagequality, picturestyle/<style>, powerzoom). */
  async compositeSetting(name: string): Promise<CompositeItem> {
    return (await this.setting(name)) as unknown as CompositeItem;
  }

  /**
   * Changes one setting after checking the value against what the camera
   * says it accepts right now, so a mistake comes back as a precise message.
   * Composite values are whole objects (see the set* helpers for partial changes).
   */
  async set(name: string, value: SettingValue, current?: AnySettingItem): Promise<void> {
    if (name === "shootingmode" || name === "shootingmodedial") return this.setMode(String(value));
    const key = this.settingKey(name);
    const path = this.endpoint(`shooting/settings/${key}`, "put");
    if (!path) throw new SettingError(name, `${name} can't be changed on this camera.`);
    checkValue(name, value, current ?? (await this.setting(key)));
    await this.putValue(name, path, value);
  }

  /** Changes some fields of a composite setting, keeping the others. */
  async setFields(name: string, changes: Record<string, string | number>): Promise<void> {
    const item = await this.compositeSetting(name);
    const value: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(item.value ?? {})) {
      // Fields with an empty list are read-only (the base of a user style).
      const ab = item.ability[k];
      if (Array.isArray(ab) && !ab.length) continue;
      if (v !== null) value[k] = v;
    }
    await this.set(name, { ...value, ...changes }, item);
  }

  /** DELETE on a setting: the picture style details go back to their defaults. Returns the new value. */
  async resetSetting(name: string): Promise<unknown> {
    const path = this.need(`shooting/settings/${this.settingKey(name)}`, "delete");
    return (await this.callJson<{ value: unknown }>("DELETE", path)).value;
  }

  /** Picture style detail: sharpness_strength/_fineness/_threshold, contrast, saturation, colortone (or filtereffect/toningeffect). */
  pictureStyleDetail(style: string) {
    return this.compositeSetting(`picturestyle/${style}`);
  }
  setPictureStyleDetail(style: string, changes: Record<string, string | number>) {
    return this.setFields(`picturestyle/${style}`, changes);
  }

  /** White balance shift: ba = blue (-) / amber (+), mg = magenta (-) / green (+). */
  setWbShift(ba: number, mg: number) {
    return this.set("wbshift", { ba, mg });
  }

  /** Still image quality: raw (none/raw/craw) and jpeg size (or heif); leave one out to keep it. */
  setStillImageQuality(q: { raw?: string; jpeg?: string; heif?: string }) {
    return this.setFields("stillimagequality", q as Record<string, string>);
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
    const refused = (e: unknown) => (e instanceof CcapiError ? new SettingError("shootingmode", `The camera refused shootingmode "${mode}" (${e.message}).`) : e);
    try {
      await this.call("PUT", path, { value: mode });
    } catch (e) {
      const ignore = this.endpoint("shooting/control/ignoreshootingmodedialmode", "post");
      if (!(e instanceof CcapiError) || e.status !== 503 || !ignore) throw refused(e);
      await this.call("POST", ignore, { action: "on" });
      try {
        await this.call("PUT", path, { value: mode });
      } catch (e2) {
        throw refused(e2);
      }
    }
  }

  /** Software override of the mode dial on or off. */
  async ignoreModeDial(on: boolean): Promise<void> {
    await this.call("POST", this.need("shooting/control/ignoreshootingmodedialmode", "post"), { action: on ? "on" : "off" });
  }
  async ignoreModeDialStatus(): Promise<boolean> {
    return (await this.callJson<{ status: string }>("GET", this.need("shooting/control/ignoreshootingmodedialmode", "get"))).status === "on";
  }

  /** Remaining shots (still mode) or seconds (movie mode); the other is null. */
  recordable() {
    return this.callJson<{ recordableshots: number | null; remainingtime: number | null }>("GET", this.need("shooting/information/recordable", "get"));
  }

  // ---------------------------------------------------------------- shooting control

  /**
   * One press of the shutter, with or without autofocus. A camera still
   * writing a burst answers "Device busy"; that press is retried until the
   * buffer clears (up to `busyWaitMs`). Without the one-shot endpoint it is a
   * full press and a release on the manual button, each retried on its own,
   * so a busy release can't take a second picture. `signal` stops the retries
   * of a press that hasn't happened yet; a press that did is always released.
   */
  async shutter(af: boolean, busyWaitMs = 15_000, signal?: AbortSignal): Promise<void> {
    const path = this.endpoint("shooting/control/shutterbutton", "post");
    if (path) return this.whileBusy(() => this.call("POST", path, { af }), busyWaitMs, signal);
    const manual = this.need("shooting/control/shutterbutton/manual", "post");
    await this.whileBusy(() => this.call("POST", manual, { action: "full_press", af }), busyWaitMs, signal);
    await this.whileBusy(() => this.call("POST", manual, { action: "release", af: false }), busyWaitMs);
  }

  /** Runs `fn`, again every 300 ms while the camera answers "Device busy", for up to `waitMs` or until `signal` aborts. */
  private async whileBusy(fn: () => Promise<unknown>, waitMs: number, signal?: AbortSignal): Promise<void> {
    const until = Date.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      try {
        await fn();
        return;
      } catch (e) {
        if (!(e instanceof CcapiError && e.status === 503 && /busy/i.test(e.message)) || Date.now() >= until) throw e;
        await sleep(300);
      }
    }
  }

  /** The shutter button by hand: half_press (AF/metering), full_press (holds: bursts, bulb), release. */
  async shutterButton(action: "half_press" | "full_press" | "release", af = false): Promise<void> {
    await this.call("POST", this.need("shooting/control/shutterbutton/manual", "post"), { action, af });
  }

  /** AF without shooting; the result shows in the live view AF frame status. */
  async autofocus(action: "start" | "stop"): Promise<void> {
    await this.call("POST", this.need("shooting/control/af", "post"), { action });
  }

  /** Moves focus closer (near) or further (far); 1 = small step, 3 = large. */
  async driveFocus(step: "near1" | "near2" | "near3" | "far1" | "far2" | "far3"): Promise<void> {
    await this.call("POST", this.need("shooting/control/drivefocus", "post"), { value: step });
  }

  async movieMode(): Promise<boolean> {
    return (await this.callJson<{ status: string }>("GET", this.need("shooting/control/moviemode", "get"))).status === "on";
  }
  async setMovieMode(on: boolean): Promise<void> {
    await this.call("POST", this.need("shooting/control/moviemode", "post"), { action: on ? "on" : "off" });
  }

  /** Starts or stops movie recording (movie mode must be on). */
  async record(action: "start" | "stop"): Promise<void> {
    await this.call("POST", this.need("shooting/control/recbutton", "post"), { action });
  }

  /** Optical zoom position (PowerShot models). */
  zoom() {
    return this.callJson<SettingItem>("GET", this.need("shooting/control/zoom", "get"));
  }
  async setZoom(value: number): Promise<void> {
    const item = await this.zoom();
    checkValue("zoom", value, item);
    await this.call("POST", this.need("shooting/control/zoom", "post"), { value });
  }

  /** Power zoom (adapter or PZ lens): state and driving wide / tele / stop. */
  powerZoom() {
    return this.callJson<SettingItem>("GET", this.need("shooting/control/powerzoom", "get"));
  }
  async drivePowerZoom(value: "wide" | "tele" | "stop"): Promise<void> {
    await this.call("POST", this.need("shooting/control/powerzoom", "post"), { value });
  }

  /** Mains flicker detection: "ok" = flicker found, "ng" = none. */
  async flickerDetection(): Promise<string> {
    return (await this.detectFlicker()).result;
  }

  /** Mains flicker detection with the frequency the camera found ("100Hz" / "120Hz"), when it found one. */
  detectFlicker() {
    return this.callJson<{ result: string; frequency?: string }>("POST", this.need("shooting/control/flickerdetection", "post"), { action: "start" });
  }

  /** High-frequency flicker detection; with applyResult the camera takes the recommended Tv. */
  hfFlickerDetection(action: "start" | "cancel", applyResult = true) {
    return this.callJson<{ result?: string; frequency?: string; tv?: string }>("POST", this.need("shooting/control/hfflickerdetection", "post"), { action, apply_result: applyResult });
  }

  /** Nudges the HF flicker shutter speed while the detection result is shown. */
  async stepHfFlickerTv(value: "decrement_large" | "decrement_small" | "increment_small" | "increment_large"): Promise<void> {
    await this.call("POST", this.need("shooting/control/hfflickertv", "post"), { value });
  }

  // ---------------------------------------------------------------- live view

  async startLiveView(size: "small" | "medium" = "small", display: "on" | "off" | "keep" = "on"): Promise<void> {
    await this.call("POST", this.need("shooting/liveview", "post"), { liveviewsize: size, cameradisplay: display });
  }

  async stopLiveView(display: "on" | "off" | "keep" = "keep"): Promise<void> {
    await this.call("POST", this.need("shooting/liveview", "post"), { liveviewsize: "off", cameradisplay: display });
  }

  /** Retries the first frames after starting live view, starting it if needed. */
  private async liveRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof CcapiError) || e.status !== 503 || attempt >= 4) throw e;
        if (/not started/i.test(e.message)) await this.startLiveView();
        await sleep(250 * (attempt + 1));
      }
    }
  }

  /** One live-view JPEG. Starts live view if needed; the first frames after starting may not be ready. */
  async liveFrame(): Promise<Uint8Array> {
    const path = this.need("shooting/liveview/flip", "get");
    return this.liveRetry(async () => (await this.call("GET", path)).bytes());
  }

  /** A live-view frame and/or its incidental information (histogram, AF frames, zoom, level). */
  async liveDetail(kind: "image" | "info" | "both" = "both"): Promise<LiveDetail> {
    const path = this.need("shooting/liveview/flipdetail", "get");
    const bytes = await this.liveRetry(async () => (await this.call("GET", `${path}?kind=${kind}`)).bytes());
    // One frame: its picture and its information, in whichever order the camera sends them.
    const frames = detailFrames(parseRecords(bytes));
    const image = frames.find((f) => f.image)?.image;
    const info = frames.find((f) => f.info)?.info;
    return { ...(image ? { image } : {}), ...(info ? { info } : {}) };
  }

  /**
   * Reads one of the continuous streams (scroll, scrolldetail, multipart)
   * and returns the frames it delivered. Over a transport that buffers the
   * whole response this only works with cameras (or simulators) that end
   * the stream; a real camera streams until stopLiveStream().
   */
  async liveStream(kind: "scroll" | "scrolldetail" | "multipart", detail: "image" | "info" | "both" = "image"): Promise<LiveDetail[]> {
    const path = this.need(`shooting/liveview/${kind}`, "get");
    const res = await this.call("GET", kind === "scrolldetail" ? `${path}?kind=${detail}` : path);
    const bytes = await res.bytes();
    if (kind === "scrolldetail") return detailFrames(parseRecords(bytes));
    if (kind === "multipart") return parseMultipart(bytes, multipartBoundary(res.contentType)).map((image) => ({ image }));
    return splitJpegs(bytes).map((image) => ({ image }));
  }

  async stopLiveStream(kind: "scroll" | "scrolldetail" | "multipart"): Promise<void> {
    await this.call("DELETE", this.need(`shooting/liveview/${kind}`, "delete"));
  }

  /** Moves the AF frame (and the magnified area) to a point in still-image Large pixels. */
  async setAfFramePosition(x: number, y: number): Promise<void> {
    await this.call("PUT", this.need("shooting/liveview/afframeposition", "put"), { positionx: Math.round(x), positiony: Math.round(y) });
  }

  /** Custom white balance from the live view at a point (still-image Large pixels); WB becomes "custom". */
  async clickWhiteBalance(x: number, y: number): Promise<void> {
    await this.call("POST", this.need("shooting/liveview/clickwb", "post"), { positionx: Math.round(x), positiony: Math.round(y) });
  }

  /** Adds the electronic level to the incidental information. */
  async angleInformation(on: boolean): Promise<void> {
    await this.call("POST", this.need("shooting/liveview/angleinformation", "post"), { action: on ? "start" : "stop" });
  }

  /** The SDP description of the RTP stream (text). */
  async rtpSessionDescription(): Promise<string> {
    return new TextDecoder().decode(await (await this.call("GET", this.need("shooting/liveview/rtpsessiondesc", "get"))).bytes());
  }

  /** Starts or stops RTP streaming of movie live view to `ipaddress`. */
  async rtp(action: "start" | "stop", ipaddress: string): Promise<void> {
    await this.call("POST", this.need("shooting/liveview/rtp", "post"), { action, ipaddress });
  }

  // ---------------------------------------------------------------- optical viewfinder AF

  /** afareaselectionmode, afareaselection, afframeinformation or afareainformation. */
  opticalFinder<T = Record<string, unknown>>(name: string): Promise<T> {
    return this.callJson<T>("GET", this.need(`shooting/opticalfinder/${name}`, "get"));
  }
  async setOpticalFinder(name: "afareaselectionmode" | "afareaselection", value: string): Promise<void> {
    await this.call("PUT", this.need(`shooting/opticalfinder/${name}`, "put"), { value });
  }

  // ---------------------------------------------------------------- events

  /**
   * Changes since the last poll. ver110+ supports a long-poll timeout; ver100
   * returns immediately with continue=off, or holds with continue=on. Pass a
   * version to use that one instead of the highest.
   */
  async poll(wait: "immediately" | "short" | "long" = "immediately", version?: string): Promise<Record<string, unknown>> {
    const eps = (this.endpoints.get("event/polling") ?? []).filter((e) => e.get && (!version || e.version === version));
    const ep = eps[0];
    if (!ep) throw new CcapiError(404, "This camera has no event polling", "event/polling");
    const q = versionNumber(ep.version) >= 110 ? `?timeout=${wait}` : `?continue=${wait === "immediately" ? "off" : "on"}`;
    return this.callJson<Record<string, unknown>>("GET", ep.path + q);
  }

  /** Ends a waiting poll. */
  async stopPolling(): Promise<void> {
    await this.call("DELETE", this.need("event/polling", "delete"));
  }

  /** Reads the monitoring stream: one event object per record (see liveStream about streams). */
  async monitor(): Promise<Array<Record<string, unknown>>> {
    const bytes = await (await this.call("GET", this.need("event/monitoring", "get"))).bytes();
    const dec = new TextDecoder();
    return parseRecords(bytes).filter((r) => r.type === 2).map((r) => JSON.parse(dec.decode(r.data)) as Record<string, unknown>);
  }

  async stopMonitoring(): Promise<void> {
    await this.call("DELETE", this.need("event/monitoring", "delete"));
  }

  /** Waits for the next file the camera writes and returns its path (JPEG preferred). `signal` stops the wait. */
  async waitForNewFile(timeoutMs = 15_000, onEvent?: (e: Record<string, unknown>) => void, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const hasVersion110 = (this.endpoints.get("event/polling") ?? []).some((e) => versionNumber(e.version) >= 110);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
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

  // ---------------------------------------------------------------- contents

  /** Storage paths, e.g. ["/ccapi/ver120/contents/card1"]. */
  async storages(): Promise<string[]> {
    return listOf(await this.callJson("GET", this.contentsRoot()));
  }

  /** Folder paths on a storage. */
  async directories(storage: string): Promise<string[]> {
    return listOf(await this.callJson("GET", toPath(storage)));
  }

  /** One page (100 entries, 1-based) of a folder, optionally one file type (jpeg, cr3, mp4, mov, hif, …). */
  async files(dir: string, opts: { type?: string; page?: number } = {}): Promise<string[]> {
    const q = new URLSearchParams();
    if (opts.type) q.set("type", opts.type);
    if (opts.page) q.set("page", String(opts.page));
    const qs = q.toString();
    return listOf(await this.callJson("GET", `${toPath(dir)}${qs ? `?${qs}` : ""}`));
  }

  /** How many entries a folder holds, and in how many pages. */
  contentsCount(dir: string, type?: string) {
    const q = new URLSearchParams({ kind: "number" });
    if (type) q.set("type", type);
    return this.callJson<{ contentsnumber: number; pagenumber: number }>("GET", `${toPath(dir)}?${q}`);
  }

  /** Every entry of a folder, page by page. */
  async allFiles(dir: string, type?: string): Promise<string[]> {
    const { pagenumber } = await this.contentsCount(dir, type);
    const out: string[] = [];
    for (let page = 1; page <= pagenumber; page++) out.push(...(await this.files(dir, { type, page })));
    return out;
  }

  /** Every entry of a folder in one chunked answer (a run of {"path": [...]} objects). */
  async filesChunked(dir: string, opts: { type?: string; order?: "asc" | "desc" } = {}): Promise<string[]> {
    const q = new URLSearchParams({ kind: "chunked" });
    if (opts.type) q.set("type", opts.type);
    if (opts.order) q.set("order", opts.order);
    const bytes = await (await this.call("GET", `${toPath(dir)}?${q}`)).bytes();
    const out: string[] = [];
    for (const obj of parseJsonSequence(new TextDecoder().decode(bytes))) {
      const o = obj as { message?: string };
      if (o.message) throw new CcapiError(503, o.message.trim(), dir);
      out.push(...listOf(obj));
    }
    return out;
  }

  fileInfo(path: string) {
    return this.callJson<FileInfo>("GET", `${toPath(path)}?kind=info`);
  }

  /** Downloads a file: a display-size JPEG when the camera offers one, else the original. */
  async download(path: string, kind: FileKind = "display"): Promise<Uint8Array> {
    const p = toPath(path);
    try {
      return await (await this.call("GET", `${p}?kind=${kind}`)).bytes();
    } catch (e) {
      if (e instanceof CcapiError && e.status === 400 && kind !== "main") return (await this.call("GET", `${p}?kind=main`)).bytes();
      throw e;
    }
  }

  /** Part of a file (`end` inclusive; omit for the rest). 416 when the range is outside the file. */
  async downloadRange(path: string, start: number, end?: number, kind: FileKind = "main"): Promise<{ bytes: Uint8Array; start: number; end: number; total: number | null }> {
    const res = await this.call("GET", `${toPath(path)}?kind=${kind}`, undefined, { range: `bytes=${start}-${end ?? ""}` });
    const bytes = await res.bytes();
    const m = res.header?.("content-range")?.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
    if (m) return { bytes, start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
    // The whole file came back (no range support).
    return { bytes: bytes.subarray(start, end === undefined ? undefined : end + 1), start, end: Math.min(bytes.length - 1, end ?? bytes.length - 1), total: bytes.length };
  }

  /** PUT on a file: rotate ("0".."270"), protect / archive ("enable"/"disable"), rating ("off", "1".."5"). */
  async modifyFile(path: string, action: "rotate" | "protect" | "archive" | "rating" | "xmp_description", value: string): Promise<void> {
    await this.call("PUT", toPath(path), { action, value });
  }
  rotateFile(path: string, degrees: 0 | 90 | 180 | 270) {
    return this.modifyFile(path, "rotate", String(degrees));
  }
  protectFile(path: string, on: boolean) {
    return this.modifyFile(path, "protect", on ? "enable" : "disable");
  }
  archiveFile(path: string, on: boolean) {
    return this.modifyFile(path, "archive", on ? "enable" : "disable");
  }
  rateFile(path: string, rating: "off" | 1 | 2 | 3 | 4 | 5) {
    return this.modifyFile(path, "rating", String(rating));
  }
  /** Writes GPS data into a file (rationals as [numerator, denominator]). */
  async setFileGps(path: string, gps: Record<string, unknown>): Promise<void> {
    await this.call("PUT", toPath(path), { action: "gps", gps });
  }

  /** Deletes a file (409 "File protected" for protected ones). */
  async deleteFile(path: string): Promise<void> {
    await this.call("DELETE", toPath(path));
  }

  /** Deletes a folder and its files; protected files stay (409 "Partial deletion"). */
  async deleteDirectory(path: string): Promise<void> {
    await this.call("DELETE", toPath(path));
  }
}

// ------------------------------------------------------------------ helpers

const isRange = (a: unknown): a is { min: number | null; max: number | null; step: number | null } =>
  !!a && typeof a === "object" && !Array.isArray(a) && "min" in a;

/** Whether an item's value is an object with per-field abilities. */
export function isComposite(item: AnySettingItem): item is CompositeItem {
  return !!item.ability && typeof item.ability === "object" && !Array.isArray(item.ability) && !isRange(item.ability);
}

/** Validates a value against an ability, with messages that list what would work. */
export function checkValue(name: string, value: SettingValue, item: AnySettingItem) {
  if (isComposite(item)) {
    if (!value || typeof value !== "object") throw new SettingError(name, `${name} takes an object with ${Object.keys(item.ability).join(", ")}.`);
    for (const [field, ab] of Object.entries(item.ability)) {
      if (Array.isArray(ab) && !ab.length && field === "basepicturestyle") continue; // read-only here
      if (!(field in value)) throw new SettingError(name, `${name} needs every field; ${field} is missing.`);
      checkValue(`${name}.${field}`, value[field], { value: null, ability: ab });
    }
    return;
  }
  const ab = item.ability;
  if (typeof value === "object") throw new SettingError(name, `${name} takes a single value, not an object.`);
  if (Array.isArray(ab)) {
    if (!ab.length) throw new SettingError(name, `${name} can't be changed in the current shooting mode.`);
    if (!ab.includes(value as never)) {
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

/**
 * Splits framed records (FF 00 <type> <size:4> <data> FF FF).
 * The size's byte order isn't known: big-endian is tried first,
 * little-endian when that doesn't land on the end marker.
 */
export function parseRecords(bytes: Uint8Array): FramedRecord[] {
  const out: FramedRecord[] = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  while (o + 9 <= bytes.length) {
    if (bytes[o] !== 0xff || bytes[o + 1] !== 0x00) throw new Error(`Bad live view record at byte ${o}`);
    const type = bytes[o + 2];
    let size = v.getUint32(o + 3, false);
    const endsAt = (n: number) => o + 7 + n + 1 < bytes.length && bytes[o + 7 + n] === 0xff && bytes[o + 8 + n] === 0xff;
    if (!endsAt(size)) {
      const le = v.getUint32(o + 3, true);
      if (endsAt(le)) size = le;
      else throw new Error(`Bad live view record size at byte ${o}`);
    }
    out.push({ type, data: bytes.subarray(o + 7, o + 7 + size) });
    o += size + 9;
  }
  return out;
}

/** Groups records into frames: an info record belongs with the image that follows it. */
function detailFrames(records: FramedRecord[]): LiveDetail[] {
  const dec = new TextDecoder();
  const out: LiveDetail[] = [];
  let cur: LiveDetail = {};
  for (const r of records) {
    if (r.type === 0x01) {
      if (cur.info || cur.image) out.push(cur);
      cur = { info: JSON.parse(dec.decode(r.data)) as LiveViewInfo };
    } else if (r.type === 0x00) {
      if (cur.image) {
        out.push(cur);
        cur = {};
      }
      cur.image = r.data;
    }
  }
  if (cur.info || cur.image) out.push(cur);
  return out;
}

/** The JPEGs of a multipart/x-mixed-replace body (LF or CRLF line ends). */
export function parseMultipart(bytes: Uint8Array, boundary = "boundary"): Uint8Array[] {
  const text = new TextDecoder("latin1").decode(bytes);
  const out: Uint8Array[] = [];
  const mark = `--${boundary}`;
  let o = 0;
  for (;;) {
    const b = text.indexOf(mark, o);
    if (b < 0 || text.startsWith(`${mark}--`, b)) break;
    const headerEnd = text.slice(b).search(/\r?\n\r?\n/);
    if (headerEnd < 0) break;
    const head = text.slice(b, b + headerEnd);
    const sep = text.slice(b + headerEnd).match(/^\r?\n\r?\n/)![0].length;
    const len = Number(head.match(/content-length:\s*(\d+)/i)?.[1]);
    const start = b + headerEnd + sep;
    if (!Number.isFinite(len)) break;
    out.push(bytes.subarray(start, start + len));
    o = start + len;
  }
  return out;
}

/** The boundary a multipart content type names, or "boundary". */
function multipartBoundary(contentType: string): string {
  return contentType.match(/boundary="?([^";\s]+)"?/i)?.[1] ?? "boundary";
}

/** Back-to-back JPEGs split at their end markers (a de-chunked scroll stream). */
export function splitJpegs(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 2; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9 && (i + 2 === bytes.length || (bytes[i + 2] === 0xff && bytes[i + 3] === 0xd8))) {
      out.push(bytes.subarray(start, i + 2));
      start = i + 2;
      i++;
    }
  }
  if (start < bytes.length && !out.length) out.push(bytes.subarray(start));
  return out;
}

/** Concatenated JSON objects ({…}{…}), as a de-chunked contents list arrives. */
export function parseJsonSequence(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}

/** A camera date: "Tue, 01 Jan 2019 01:23:45 +0900" for `when` shown in a zone `offsetMinutes` east of UTC. */
export function formatCameraDate(when: Date, offsetMinutes: number): string {
  const local = new Date(when.getTime() + offsetMinutes * 60_000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  const z = Math.abs(offsetMinutes);
  return `${days[local.getUTCDay()]}, ${p(local.getUTCDate())} ${months[local.getUTCMonth()]} ${local.getUTCFullYear()} ${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())} ${offsetMinutes < 0 ? "-" : "+"}${p(Math.floor(z / 60))}${p(z % 60)}`;
}

/** The path list of a contents answer ({"path": [...]} or, from older cameras, {"url": [...]}). */
function listOf(d: unknown): string[] {
  const o = d as { path?: string[]; url?: string[] };
  return (o.path ?? o.url ?? []).map((p) => toPath(p.trim()));
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
