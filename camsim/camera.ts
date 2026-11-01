// A virtual mirrorless camera that speaks CCAPI. It keeps settings like a
// real body (what is adjustable depends on the shooting mode), meters the
// scene and solves exposure the way Av / Tv / P / M with auto ISO do, focuses
// on the subject or whatever is under the centre point, and renders live view
// and photos of the current scene through the physical pipeline in render.ts.
//
// It is transport-free: `handle()` takes a method, path and JSON body and
// returns a status with JSON or bytes. The web demo runs it in a Web Worker;
// tools/sim-server.ts serves it over HTTP so the Android app can use it too.

import {
  AV_SCALE,
  avNumber,
  EXPOSURE_SCALE,
  evStops,
  ISO_SCALE,
  isoNumber,
  nearest,
  TV_SCALE,
  tvSeconds,
} from "../shared/settings.ts";
import { meter, render, motionAt } from "./render.ts";
import { depthAt, loadScene, SCENE_IDS, type ImageLoader, type Scene } from "./scenes.ts";

export interface SimDeps {
  encodeJpeg(rgba: Uint8ClampedArray, w: number, h: number, quality: number): Promise<Uint8Array>;
  /** Milliseconds; drives moving subjects. */
  now(): number;
  /** Scene images, by path under the web root. */
  loadImage: ImageLoader;
}

export interface SimRequest {
  method: string;
  /** Path with optional query, e.g. "/ccapi/ver110/event/polling?timeout=short". */
  path: string;
  body?: unknown;
}

export interface SimResponse {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
}

export interface Exposure {
  N: number;
  t: number;
  iso: number;
  /** Values as the camera writes them. */
  av: string;
  tv: string;
  isoValue: string;
  /** How far the result is from what the meter wanted, in stops (+ = brighter). */
  error: number;
}

export interface ShotRecord {
  path: string;
  name: string;
  /** The exposure and settings the photo was taken with. */
  exposure: Exposure;
  settings: Record<string, string | number>;
  focusOn: string;
  time: number;
}

export interface SimStatus {
  scene: string;
  sceneTitle: string;
  lens: string;
  settings: Record<string, string | number>;
  exposure: Exposure;
  meterEv: number;
  liveview: string;
  busy: boolean;
  shots: ShotRecord[];
}

const BUSY = { status: 503, json: { message: "Device busy" } };
const INVALID = { status: 400, json: { message: "Invalid parameter" } };
const NOT_FOUND = { status: 404, json: { message: "URL not found" } };
const ok = (json: unknown = {}): SimResponse => ({ status: 200, json });

const MODES = ["p", "av", "tv", "m"];
const WB = ["auto", "awbwhite", "daylight", "shade", "cloudy", "tungsten", "whitefluorescent", "flash", "colortemp"];
const WB_KELVIN: Record<string, number> = { daylight: 5200, shade: 7000, cloudy: 6000, tungsten: 3200, whitefluorescent: 4000, flash: 6000 };
const METERING = ["evaluative", "partial", "spot", "center_weighted_average"];
const AF_OPERATION = ["oneshot", "servo", "aifocus"];
const AF_METHOD = ["face+tracking", "spot", "1point", "expand_cross", "zone", "whole_area"];
const DRIVE = ["single", "highspeed", "lowspeed", "silent_single", "self_2sec", "self_10sec"];
const PICTURE_STYLE = ["auto", "standard", "portrait", "landscape", "finedetail", "neutral", "faithful", "monochrome"];
const COLOR_TEMP = { min: 2500, max: 10000, step: 100 };
const AUTO_ISO_MAX = 12800;
/** Hand-held shake, degrees per second. */
const SHAKE = 2.5;

const SETTING_PATHS = ["av", "tv", "iso", "exposure", "wb", "colortemperature", "metering", "afoperation", "afmethod", "drive", "picturestyle"];
const DIR = "/ccapi/ver120/contents/card1/100CANON";

interface StoredShot extends ShotRecord {
  main: Uint8Array;
  thumb: Uint8Array;
  size: number;
  modified: string;
}

export class VirtualCamera {
  private scene!: Scene;
  private settings: Record<string, string | number> = {};
  private ignoreDial = false;
  private liveview: "off" | "small" | "medium" = "off";
  private focus = 3;
  private focusOn = "subject";
  private busy = false;
  private seq = 0;
  private shots: StoredShot[] = [];
  /** Changes not yet delivered by event polling; null = deliver everything. */
  private pending: Record<string, unknown> | null = null;
  private lastEffective = "";
  private waiters: Array<() => void> = [];
  private start: number;
  private deps: SimDeps;

  private constructor(deps: SimDeps) {
    this.deps = deps;
    this.start = deps.now();
  }

  /** A camera pointed at `sceneId` (its images are loaded first). */
  static async create(deps: SimDeps, sceneId = "backlit"): Promise<VirtualCamera> {
    const cam = new VirtualCamera(deps);
    await cam.setScene(sceneId);
    return cam;
  }

  // ---------------------------------------------------------------- simulator controls

  async setScene(id: string) {
    if (!SCENE_IDS.includes(id)) throw new Error(`unknown scene ${id}`);
    this.scene = await loadScene(id, this.deps.loadImage);
    const i = this.scene.initial;
    this.settings = {
      shootingmode: i.shootingmode ?? "av",
      av: i.av ?? "f5.6",
      tv: i.tv ?? "1/125",
      iso: i.iso ?? "auto",
      exposure: i.exposure ?? "+0.0",
      wb: i.wb ?? "auto",
      colortemperature: i.colortemperature ?? 5200,
      metering: i.metering ?? "evaluative",
      afoperation: i.afoperation ?? "oneshot",
      afmethod: i.afmethod ?? "face+tracking",
      drive: "single",
      picturestyle: i.picturestyle ?? "auto",
    };
    this.clampAv();
    this.focus = this.subjectDepth();
    this.focusOn = "subject";
    this.pending = null;
    this.lastEffective = "";
    this.wake();
  }

  sceneId() {
    return this.scene.id;
  }

  status(): SimStatus {
    return {
      scene: this.scene.id,
      sceneTitle: this.scene.title,
      lens: this.scene.lens.name,
      settings: { ...this.settings },
      exposure: this.solve(this.clock()),
      meterEv: meter(this.scene, String(this.settings.metering), this.clock()),
      liveview: this.liveview,
      busy: this.busy,
      shots: this.shots.map(({ main: _m, thumb: _t, size: _s, modified: _d, ...rec }) => rec),
    };
  }

  /** What the camera's rear screen shows right now (exposure simulation), at width `w`. */
  async frame(w = 600): Promise<Uint8Array> {
    return this.renderLive(w);
  }

  private clock() {
    return (this.deps.now() - this.start) / 1000;
  }

  // ---------------------------------------------------------------- exposure

  private mode() {
    return String(this.settings.shootingmode);
  }

  private lensAv(): string[] {
    const { maxAperture, minAperture } = this.scene.lens;
    return AV_SCALE.filter((v) => {
      const n = avNumber(v)!;
      return n >= maxAperture - 0.01 && n <= minAperture + 0.01;
    });
  }

  private clampAv() {
    const list = this.lensAv();
    if (!list.includes(String(this.settings.av))) this.settings.av = nearest(list, avNumber(String(this.settings.av)) ?? 5.6, avNumber);
  }

  /** Exposure the camera would use now, from the meter and the mode. */
  solve(time: number): Exposure {
    const s = this.settings;
    const mode = this.mode();
    const lens = this.scene.lens;
    const ev = meter(this.scene, String(s.metering), time);
    const autoIso = s.iso === "auto";
    const comp = mode === "m" && !autoIso ? 0 : evStops(String(s.exposure)) ?? 0;
    const target = ev - comp; // EV at ISO 100 the camera aims for
    const minT = 1 / 8000;
    const maxT = 30;
    const handheldT = 1 / Math.max(lens.focal, 30);

    let N = avNumber(String(s.av)) ?? lens.maxAperture;
    let t = tvSeconds(String(s.tv)) ?? 1 / 125;
    let iso = autoIso ? 100 : isoNumber(String(s.iso)) ?? 100;
    const clampIso = (v: number) => Math.min(AUTO_ISO_MAX, Math.max(100, v));
    const needT = (n: number, i: number) => (n * n * 100) / (i * 2 ** target);

    switch (mode) {
      case "m":
        if (autoIso) iso = clampIso((N * N * 100) / (t * 2 ** target));
        break;
      case "tv": {
        // Aperture first; with auto ISO, raise ISO once the lens is wide open.
        N = Math.sqrt((t * iso * 2 ** target) / 100);
        if (N < lens.maxAperture) {
          N = lens.maxAperture;
          if (autoIso) iso = clampIso((N * N * 100) / (t * 2 ** target));
        }
        N = Math.min(Math.max(N, lens.maxAperture), lens.minAperture);
        break;
      }
      case "p":
        // Program line: stop down as light allows, between wide open and f/8.
        N = Math.min(8, Math.max(lens.maxAperture, Math.sqrt(2 ** target / 250)));
      // falls through: then behave like Av at that aperture
      default: {
        t = needT(N, iso);
        if (autoIso && t > handheldT) {
          iso = clampIso((N * N * 100) / (handheldT * 2 ** target));
          t = needT(N, iso);
        }
        t = Math.min(maxT, Math.max(minT, t));
      }
    }

    // Snap to what the camera can actually set.
    const lensList = this.lensAv();
    const av = nearest(lensList, N, avNumber);
    const tv = nearest(TV_SCALE, t, tvSeconds);
    const isoValue = nearest(ISO_SCALE, iso, isoNumber);
    const Nq = avNumber(av)!;
    const tq = tvSeconds(tv)!;
    const isoq = isoNumber(isoValue)!;
    const used = Math.log2((Nq * Nq) / tq) - Math.log2(isoq / 100);
    return { N: Nq, t: tq, iso: isoq, av, tv, isoValue, error: target - used };
  }

  private subjectDepth() {
    return this.scene.layers.find((l) => l.name === this.scene.subject.layer)?.depth ?? 3;
  }

  /** Autofocus: the subject for face/zone methods, or whatever is under the centre point. */
  private autofocus(time: number) {
    const method = String(this.settings.afmethod);
    const subject = this.scene.layers.find((l) => l.name === this.scene.subject.layer);
    let depth = this.subjectDepth();
    let on = this.scene.subject.face ? "face" : "subject";
    if (method === "spot" || method === "1point" || method === "expand_cross") {
      // Topmost layer under the centre of the frame.
      const cx = Math.floor(this.scene.w / 2);
      const cy = Math.floor(this.scene.h / 2);
      depth = depthAt(this.scene.layers[0], cy / this.scene.h);
      on = this.scene.layers[0].name;
      for (const l of this.scene.layers) {
        const { dx, dir } = motionAt(l, time);
        let sx = cx - Math.round(dx);
        if (l.motion && dir === -1) sx = Math.round(2 * l.motion.pivotX - sx);
        if (sx < 0 || sx >= l.layer.w) continue;
        if (l.layer.a[cy * l.layer.w + sx] > 0.5) {
          depth = depthAt(l, cy / this.scene.h);
          on = l.name;
        }
      }
    }
    // One-shot AF locks before the shutter fires: a moving subject has moved on.
    if (subject?.motion && on === subject.name && this.settings.afoperation === "oneshot") depth *= 1.07;
    this.focus = depth;
    this.focusOn = on;
  }

  private wbKelvin(): number {
    const wb = String(this.settings.wb);
    if (wb === "colortemp") return Number(this.settings.colortemperature);
    if (wb === "auto" || wb === "awbwhite") {
      // White priority corrects warm light more fully than ambience priority.
      return wb === "awbwhite" && this.scene.awbK < 4000 ? (this.scene.awbK + this.scene.lightK) / 2 : this.scene.awbK;
    }
    return WB_KELVIN[wb] ?? 5200;
  }

  private async renderLive(w: number): Promise<Uint8Array> {
    const time = this.clock();
    const e = this.solve(time);
    const r = render(this.scene, {
      w,
      N: e.N,
      t: e.t,
      iso: e.iso,
      dofN: this.scene.lens.maxAperture, // live view runs wide open
      focus: this.focus,
      wbK: this.wbKelvin(),
      pictureStyle: String(this.settings.picturestyle),
      time,
      motionBlur: false,
      shake: 0,
      seed: Math.floor(time * 1000),
    });
    return this.deps.encodeJpeg(r.rgba, r.w, r.h, 0.75);
  }

  private async shoot(af: boolean) {
    if (this.busy) return BUSY;
    this.busy = true;
    const time = this.clock();
    if (af) this.autofocus(time);
    const exposure = this.solve(time);
    const settings = { ...this.settings };
    const focusOn = this.focusOn;
    // The camera answers at once; the file appears in event polling when it is written.
    void (async () => {
      try {
        // Let the response go out first, and stay busy while "writing to the card".
        const done = new Promise((r) => setTimeout(r, 250));
        await new Promise((r) => setTimeout(r, 0));
        const r = render(this.scene, {
          w: this.scene.w,
          N: exposure.N,
          t: exposure.t,
          iso: exposure.iso,
          dofN: exposure.N,
          focus: this.focus,
          wbK: this.wbKelvin(),
          pictureStyle: String(settings.picturestyle),
          time,
          motionBlur: true,
          shake: this.scene.handheld ? SHAKE : 0,
          seed: ++this.seq * 7919,
        });
        const main = await this.deps.encodeJpeg(r.rgba, r.w, r.h, 0.9);
        const thumb = await this.deps.encodeJpeg(downscale(r.rgba, r.w, r.h, 8), Math.floor(r.w / 8), Math.floor(r.h / 8), 0.8);
        const name = `IMG_${String(this.seq).padStart(4, "0")}.JPG`;
        const path = `${DIR}/${name}`;
        this.shots.push({ path, name, exposure, settings, focusOn, time, main, thumb, size: main.length, modified: new Date(this.deps.now()).toUTCString() });
        if (this.shots.length > 40) this.shots.shift();
        await done;
        this.event({
          addedcontents: [path],
          effective_value_av: { value: exposure.av },
          effective_value_tv: { value: exposure.tv },
          effective_value_iso: { value: exposure.isoValue },
        });
      } finally {
        this.busy = false;
      }
    })();
    return ok();
  }

  // ---------------------------------------------------------------- CCAPI state

  /** One setting as CCAPI reports it: emptied when the current mode doesn't use it. */
  private item(name: string): { value: unknown; ability: unknown } {
    const mode = this.mode();
    const v = this.settings[name];
    const empty = { value: "", ability: [] };
    switch (name) {
      case "shootingmodedial":
        return { value: mode, ability: [] };
      case "shootingmode":
        return { value: mode, ability: MODES };
      case "av":
        return mode === "av" || mode === "m" ? { value: v, ability: this.lensAv() } : empty;
      case "tv":
        return mode === "tv" || mode === "m" ? { value: v, ability: TV_SCALE } : empty;
      case "iso":
        return { value: v, ability: ["auto", ...ISO_SCALE] };
      case "exposure":
        return mode !== "m" || this.settings.iso === "auto" ? { value: v, ability: EXPOSURE_SCALE } : empty;
      case "wb":
        return { value: v, ability: WB };
      case "colortemperature":
        return { value: v, ability: COLOR_TEMP };
      case "metering":
        return { value: v, ability: METERING };
      case "afoperation":
        return { value: v, ability: AF_OPERATION };
      case "afmethod":
        return { value: v, ability: AF_METHOD };
      case "drive":
        return { value: v, ability: DRIVE };
      case "picturestyle":
        return { value: v, ability: PICTURE_STYLE };
    }
    return empty;
  }

  private allItems(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const n of ["shootingmodedial", ...SETTING_PATHS]) out[n] = this.item(n);
    return out;
  }

  private put(name: string, value: unknown): SimResponse {
    if (name === "colortemperature") {
      const n = typeof value === "number" ? value : NaN;
      if (!Number.isInteger(n) || n < COLOR_TEMP.min || n > COLOR_TEMP.max || (n - COLOR_TEMP.min) % COLOR_TEMP.step) return INVALID;
      this.settings.colortemperature = n;
    } else {
      const { ability } = this.item(name);
      if (typeof value !== "string" || !Array.isArray(ability) || !ability.includes(value)) return INVALID;
      this.settings[name] = value;
    }
    const changed: Record<string, unknown> = { [name]: this.item(name) };
    if (name === "shootingmode" || name === "iso") {
      // A mode change empties or restores other settings.
      Object.assign(changed, this.allItems(), { shootingmode: this.item("shootingmode") });
    }
    this.event(changed);
    return ok({ value });
  }

  private event(changes: Record<string, unknown>) {
    if (this.pending) Object.assign(this.pending, changes);
    this.wake();
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  private effectiveChanges(): Record<string, unknown> {
    const e = this.solve(this.clock());
    const key = `${e.av}|${e.tv}|${e.isoValue}`;
    if (key === this.lastEffective) return {};
    this.lastEffective = key;
    return {
      effective_value_av: { value: e.av },
      effective_value_tv: { value: e.tv },
      effective_value_iso: { value: e.isoValue },
    };
  }

  private async poll(timeout: string | null): Promise<SimResponse> {
    const take = () => {
      const out = this.pending === null ? { ...this.allItems(), shootingmode: this.item("shootingmode"), ...this.statusItems() } : this.pending;
      this.pending = {};
      return { ...out, ...this.effectiveChanges() };
    };
    let out = take();
    const wait = timeout === "short" ? 10_000 : timeout === "long" ? 30_000 : 0;
    if (!Object.keys(out).length && wait) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      out = take();
    }
    return ok(out);
  }

  private statusItems() {
    return {
      battery: { name: "LP-E6NH", kind: "battery", level: "full", quality: "good" },
      lens: { mount: true, name: this.scene.lens.name },
    };
  }

  private discovery() {
    const e = (path: string, m: { get?: boolean; post?: boolean; put?: boolean; delete?: boolean }) => ({
      path,
      get: !!m.get,
      post: !!m.post,
      put: !!m.put,
      delete: !!m.delete,
    });
    return {
      ver100: [
        e("/ccapi/ver100/deviceinformation", { get: true }),
        e("/ccapi/ver100/devicestatus/battery", { get: true }),
        e("/ccapi/ver100/devicestatus/lens", { get: true }),
        e("/ccapi/ver100/shooting/settings", { get: true }),
        e("/ccapi/ver100/shooting/settings/shootingmodedial", { get: true }),
        ...SETTING_PATHS.map((n) => e(`/ccapi/ver100/shooting/settings/${n}`, { get: true, put: true })),
        e("/ccapi/ver100/shooting/control/shutterbutton", { post: true }),
        e("/ccapi/ver100/shooting/control/shutterbutton/manual", { post: true }),
        e("/ccapi/ver100/shooting/control/ignoreshootingmodedialmode", { get: true, post: true }),
        e("/ccapi/ver100/shooting/liveview", { post: true }),
        e("/ccapi/ver100/shooting/liveview/flip", { get: true }),
      ],
      ver110: [
        e("/ccapi/ver110/devicestatus/batterylist", { get: true }),
        e("/ccapi/ver110/shooting/settings/shootingmode", { get: true, put: true }),
        e("/ccapi/ver110/event/polling", { get: true, delete: true }),
      ],
      ver120: [e("/ccapi/ver120/contents", { get: true })],
    };
  }

  // ---------------------------------------------------------------- CCAPI routing

  async handle(req: SimRequest): Promise<SimResponse> {
    const [pathname, query = ""] = req.path.split("?");
    const params = new URLSearchParams(query);
    const p = pathname.replace(/\/+$/, "");
    const m = req.method.toUpperCase();
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;

    if (p === "/ccapi" && m === "GET") return ok(this.discovery());
    if (p === "/ccapi/ver100/deviceinformation" && m === "GET") {
      return ok({ manufacturer: "Simulator", productname: "Simulated mirrorless camera", guid: "00000000-0000-0000-0000-000000000000", serialnumber: "000000000001", macaddress: "00:00:00:00:00:01", firmwareversion: "1.0.0" });
    }
    if (p === "/ccapi/ver100/devicestatus/battery" && m === "GET") return ok(this.statusItems().battery);
    if (p === "/ccapi/ver110/devicestatus/batterylist" && m === "GET") {
      return ok({ batterylist: [{ position: "camera", kind: "battery", name: "LP-E6NH", quality: "good", level: "100" }] });
    }
    if (p === "/ccapi/ver100/devicestatus/lens" && m === "GET") return ok(this.statusItems().lens);

    if (p === "/ccapi/ver100/shooting/settings" && m === "GET") return ok(this.allItems());
    let s = p.match(/^\/ccapi\/ver100\/shooting\/settings\/([a-z_+]+)$/);
    if (s && (SETTING_PATHS.includes(s[1]) || s[1] === "shootingmodedial")) {
      if (m === "GET") return ok(this.item(s[1]));
      if (m === "PUT" && s[1] !== "shootingmodedial") {
        if (!("value" in body)) return INVALID;
        return this.put(s[1], body.value);
      }
      return { status: 405, json: { message: "Method not allowed" } };
    }
    if (p === "/ccapi/ver110/shooting/settings/shootingmode") {
      if (m === "GET") return ok(this.item("shootingmode"));
      if (m === "PUT") {
        // The mode dial is physical: software may only override it in "ignore dial" mode.
        if (!this.ignoreDial) return { status: 503, json: { message: "Mode not supported" } };
        return this.put("shootingmode", body.value);
      }
    }
    if (p === "/ccapi/ver100/shooting/control/ignoreshootingmodedialmode") {
      if (m === "GET") return ok({ status: this.ignoreDial ? "on" : "off" });
      if (m === "POST") {
        if (body.action !== "on" && body.action !== "off") return INVALID;
        this.ignoreDial = body.action === "on";
        return ok();
      }
    }

    if (p === "/ccapi/ver100/shooting/control/shutterbutton" && m === "POST") {
      if (typeof body.af !== "boolean") return INVALID;
      return this.shoot(body.af);
    }
    if (p === "/ccapi/ver100/shooting/control/shutterbutton/manual" && m === "POST") {
      const action = body.action;
      if (action === "half_press") {
        if (body.af === true) this.autofocus(this.clock());
        return ok();
      }
      if (action === "full_press") return this.shoot(false);
      if (action === "release") return ok();
      return INVALID;
    }

    if (p === "/ccapi/ver100/shooting/liveview" && m === "POST") {
      const size = body.liveviewsize;
      if (size !== "off" && size !== "small" && size !== "medium") return INVALID;
      this.liveview = size;
      return ok();
    }
    if (p === "/ccapi/ver100/shooting/liveview/flip" && m === "GET") {
      if (this.liveview === "off") return { status: 503, json: { message: "Live view not started" } };
      const bytes = await this.renderLive(this.liveview === "medium" ? this.scene.w : this.scene.w / 2);
      return { status: 200, bytes, contentType: "image/jpeg" };
    }

    if (p === "/ccapi/ver110/event/polling") {
      if (m === "GET") return this.poll(params.get("timeout"));
      if (m === "DELETE") {
        this.wake();
        return ok();
      }
    }

    if (p === "/ccapi/ver120/contents" && m === "GET") return ok({ path: ["/ccapi/ver120/contents/card1"] });
    if (p === "/ccapi/ver120/contents/card1" && m === "GET") return ok({ path: [DIR] });
    if (p === DIR && m === "GET") {
      if (params.get("kind") === "number") return ok({ contentsnumber: this.shots.length, pagenumber: 1 });
      return ok({ path: this.shots.map((x) => x.path) });
    }
    const file = this.shots.find((x) => x.path === p);
    if (file && m === "GET") {
      const kind = params.get("kind") ?? "main";
      if (kind === "main" || kind === "display") return { status: 200, bytes: file.main, contentType: "image/jpeg" };
      if (kind === "thumbnail") return { status: 200, bytes: file.thumb, contentType: "image/jpeg" };
      if (kind === "info") return ok({ filesize: file.size, protect: "disable", archive: "disable", rotate: "0", rating: "off", lastmodifieddate: file.modified, playtime: null });
      return { status: 400, json: { message: "Illegal query parameter" } };
    }
    if (p.startsWith("/ccapi/")) return NOT_FOUND;
    return NOT_FOUND;
  }
}

/** Box downscale of 8-bit RGBA by an integer factor. */
export function downscale(rgba: Uint8ClampedArray, w: number, h: number, f: number): Uint8ClampedArray {
  const ow = Math.floor(w / f);
  const oh = Math.floor(h / f);
  const out = new Uint8ClampedArray(ow * oh * 4);
  const n = f * f;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += rgba[((y * f + dy) * w + x * f + dx) * 4 + c];
        out[(y * ow + x) * 4 + c] = sum / n;
      }
    }
  }
  return out;
}
