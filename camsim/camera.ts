// A virtual mirrorless camera that speaks CCAPI. It keeps settings like a
// real body (what is adjustable depends on the shooting mode), meters the
// scene and solves exposure the way Av / Tv / P / M / bulb / scene-auto with
// auto ISO do, focuses with the selected AF method at the AF point, and
// renders live view, photos and movies of the current scene through the
// physical pipeline in render.ts: flash fill, brackets, bursts, aspect crops,
// picture style detail, white balance shift, colour space, RAW files.
// Under flickering light the shutter type, anti-flicker shooting and the
// high-frequency anti-flicker shutter speeds change what each frame collects
// (flicker.ts), in live view and in stills.
//
// It is transport-free: `handle()` takes a method, path, JSON body and
// headers and returns a status with JSON or bytes. The web demo runs it in a
// Web Worker; tools/sim-server.ts serves it over HTTP so the Android app can
// use it too.
//
// The simulated body: one card slot (card1), Wi-Fi only, a physical mode
// dial (so mode changes need ignore-dial mode), contents under ver120, event
// polling under ver100 (continue) and ver110 (timeout). Simplifications are
// noted where they happen: streams answer with a bounded batch of frames,
// movies are Motion-JPEG at preview size, RAW files use our own container.

import { avNumber, evStops, ISO_SCALE, isoNumber, nearest, TV_SCALE, tvSeconds, AV_SCALE } from "../shared/settings.ts";
import { afArea, autofocus, type AfResult } from "./autofocus.ts";
import { Card, httpDate, type ContentEvent } from "./card.ts";
import { luma } from "./color.ts";
import { CameraFunctions } from "./functions.ts";
import { concat, jsonRecord, multipart, MULTIPART_TYPE, quicktimeMjpeg, record, RECORD_EVENT, RECORD_INFO, RECORD_JPEG, simRaw, type MovieFrame } from "./formats.ts";
import { isMains, matchingTime, peakStart, windowGain, type Flicker } from "./flicker.ts";
import { crop, histogram, resize, type Rect, type Rgba } from "./image.ts";
import { rng, type RGB } from "./paint.ts";
import { composite, meter, motionAt, render, type RenderOpts, type StyleDetail } from "./render.ts";
import { loadScene, SCENE_IDS, type ImageLoader, type Scene } from "./scenes.ts";
import { defaults, HF_TV, MODES, report, SETTING_BY_PATH, SETTINGS, styleDefaults, USER_STYLES, validate, type SettingDef, type SettingsContext } from "./settings.ts";

export interface SimDeps {
  encodeJpeg(rgba: Uint8ClampedArray, w: number, h: number, quality: number): Promise<Uint8Array>;
  /** Milliseconds; drives moving subjects. */
  now(): number;
  /** Scene images, by path under the web root. */
  loadImage: ImageLoader;
  /** Real-time waits (self-timer, burst cadence, movie frames). Defaults to setTimeout; tests shorten it. */
  delay?(ms: number): Promise<void>;
}

export interface SimRequest {
  method: string;
  /** Path with optional query, e.g. "/ccapi/ver110/event/polling?timeout=short". */
  path: string;
  body?: unknown;
  /** Request headers (any case): range, origin, host. */
  headers?: Record<string, string>;
}

export interface SimResponse {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  /** Extra response headers (content-range, accept-ranges, CORS). */
  headers?: Record<string, string>;
  /** The camera has left the network: the transport should drop the connection. */
  closed?: boolean;
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
  /** Focus distance, metres. */
  focus: number;
  flash: boolean;
  time: number;
  /** Every file of this capture still on the card (e.g. the JPEG and the RAW). */
  files: string[];
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
  focus: number;
  focusOn: string;
  moviemode: boolean;
  recording: boolean;
  /** Disconnected or powered off; POST /sim/reconnect brings it back. */
  offline: boolean;
  card: { files: number; free: number };
  /** Settings the photographer set by hand in the camera's menus (POST /sim/menu), as the menu shows them. */
  menu: Record<string, string>;
}

const msg = (status: number, message: string): SimResponse => ({ status, json: { message } });
const ok = (json: unknown = {}): SimResponse => ({ status: 200, json });
const BUSY = msg(503, "Device busy");
const SHOOTING = msg(503, "During shooting or recording");
const MODE = msg(503, "Mode not supported");
const LV_OFF = msg(503, "Live view not started");
const INVALID = msg(400, "Invalid parameter");
const BAD_QUERY = msg(400, "Illegal query parameter");
const NOT_FOUND = msg(404, "URL not found");
const NOT_ALLOWED = msg(405, "Method not allowed");

const AUTO_ISO_MAX = 12800;
/** Auto ISO limit when the flash fires. */
const FLASH_ISO_MAX = 1600;
/** Hand-held shake, degrees per second. */
const SHAKE = 2.5;
/** Speedlite on the hot shoe: guide number in metres at ISO 100, and flash sync speed. */
const GUIDE_NUMBER = 60;
const SYNC = 1 / 200;
/**
 * High-speed sync pulses the flash for the whole curtain travel, so the frame
 * gets only a slice of it: half the power at the sync speed, and one stop less
 * for each stop faster.
 */
const hssPower = (t: number) => Math.min(1, (0.5 * t) / SYNC);

/** "+1", "-2/3", "+1 1/3", "+1⅓ EV", "-0.7" in stops; null if it isn't a number of stops. */
function stopsOf(v: string): number | null {
  const m = v.replace(/[−–]/g, "-").replace(/\s*(ev|stops?)$/, "").trim().match(/^([+-]?)(\d+(?:\.\d+)?)?(?:[ _]?(⅓|⅔|1\/3|2\/3))?$/);
  if (!m || (!m[2] && !m[3])) return null;
  const n = Number(m[2] ?? 0) + (m[3] === "⅓" || m[3] === "1/3" ? 1 / 3 : m[3] ? 2 / 3 : 0);
  return m[1] === "-" ? -n : n;
}
/** Sensor readout with the fully electronic shutter (rolling shutter). */
const READOUT = 1 / 60;
/** Time the mechanical shutter's slit (or the electronic first curtain) takes to cross the frame. */
const CURTAIN = 1 / 320;
/** HF anti-flicker shutter speed steps: one fine step, and a large one of 1/8 stop. */
const HF_STEP = { small: 1, large: 12 };
const DRIVE_FPS: Record<string, number> = { cont_super_hi: 12, highspeed: 8, lowspeed: 3 };
/** A one-call shutter press is a quick press and release: in continuous drive that is this many frames. */
const QUICK_BURST = 3;
/** A held button (shutterbutton/manual) stops after this many frames, as a buffer would. */
const MAX_BURST = 30;
const SIZES: Record<string, [number, string]> = { large: [1, "L"], medium1: [0.7, "M"], medium2: [0.5, "N"], small: [0.3, "S"] };
const DRIVE_FOCUS: Record<string, number> = { near1: 0.005, near2: 0.03, near3: 0.15, far1: -0.005, far2: -0.03, far3: -0.15 };
/** Movie frames: rendered at preview size, as fast as this allows. */
const MOVIE_FRAME_MS = 200;
const MOVIE_MAX_FRAMES = 900;
/** Rough bytes a capture needs, to refuse when the card is full. */
const JPEG_ESTIMATE = 400_000;
const RAW_ESTIMATE = 2_400_000;

interface Capture {
  number: number;
  exposure: Exposure;
  settings: Record<string, string | number>;
  focusOn: string;
  focus: number;
  flash: boolean;
  time: number;
  paths: string[];
}

interface Frame {
  time: number;
  /** Exposure bracket offset, stops (+ = brighter). */
  bias: number;
  /** White balance bracket variants of this one exposure (several JPEGs). */
  wb: Array<{ ba: number; mg: number }>;
  focus: number;
  /** Focus distances to merge into a depth composite (an extra image). */
  stack?: number[];
  bulb?: number;
}

interface Recording {
  frames: Array<{ jpeg: Uint8Array; at: number }>;
  stop: boolean;
  done: Promise<void>;
  w: number;
  h: number;
  exposure: Exposure;
  time: number;
}

type Methods = string; // letters: G get, O post, P put, D delete

export class VirtualCamera {
  private scene!: Scene;
  private settings: Record<string, unknown> = {};
  private ignoreDial = false;
  private lv = { size: "off" as "off" | "small" | "medium", display: "on" };
  private focus = 3;
  private focusOn = "subject";
  /** Last AF result for the live view frame: 0 standby, 1 in focus, 2 failed. */
  private afState = 0;
  private afRunning = false;
  /** AF point, sensor pixels (also the centre of the live view magnification). */
  private afPoint = { x: 600, y: 400 };
  private customWb: RGB | null = null;
  private angleInfo = false;
  private hfResult = false;
  /** HDR Mode, set by hand in the menus (the control API can't): null when off. */
  private hdr: "auto" | number | null = null;
  /** High-speed sync, set on the flash or in the camera's flash menu (the control API can't). */
  private hss = false;
  /** Flash exposure compensation in stops, likewise only in the menus. */
  private fec = 0;
  private movie = false;
  private recording: Recording | null = null;
  /** Busy = the camera can't take another picture yet; shooting = frames are still being exposed. */
  private busy = false;
  private shooting = false;
  private held: { stop: boolean } | null = null;
  private bulbStart: number | null = null;
  private offline = false;
  private battery = 100;
  private seq = 0;
  private liveFrames = 0;
  private card: Card;
  private functions = new CameraFunctions();
  private captures = new Map<number, Capture>();
  private streams = new Set<string>();
  private monitoring = false;
  /** Event polling: the last value reported per key (empty = report everything). */
  private reported = new Map<string, string>();
  private pushed: Record<string, unknown> = {};
  private contentEvents: ContentEvent[] = [];
  private lastEffective = "";
  private waiters: Array<() => void> = [];
  private stopSeq = 0;
  private baseUrl = "http://localhost:8080";
  private start: number;
  private deps: SimDeps;

  private constructor(deps: SimDeps) {
    this.deps = deps;
    this.start = deps.now();
    this.card = new Card(
      (e) => {
        this.contentEvents.push(e);
        this.wake();
      },
      () => this.functions.now(),
    );
  }

  /** A camera pointed at `sceneId` (its images are loaded first). */
  static async create(deps: SimDeps, sceneId = "concert"): Promise<VirtualCamera> {
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
      ...defaults(),
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
      drive: i.drive ?? "single",
      picturestyle: i.picturestyle ?? "auto",
      ...(i.shuttermode ? { shuttermode: i.shuttermode } : {}),
    };
    this.clampAv();
    this.focus = this.subjectDepth();
    this.focusOn = "subject";
    this.afPoint = { x: this.scene.w / 2, y: this.scene.h / 2 };
    this.afState = 0;
    this.afRunning = false;
    this.customWb = null;
    this.hfResult = false;
    this.hdr = null;
    this.hss = false;
    this.fec = 0;
    this.movie = false;
    if (this.recording) this.recording.stop = true;
    this.recording = null;
    this.offline = false;
    this.reported.clear();
    this.lastEffective = "";
    this.wake();
  }

  /**
   * The photographer changes a menu setting on the body by hand, one the
   * control API can't reach (the demo calls this when they confirm a
   * menu_steps guide). Only HDR Mode, high-speed sync and flash exposure
   * compensation change the pictures; false for anything else.
   */
  handSet(setting: string, value: string): boolean {
    const name = setting.toLowerCase();
    const v = value.toLowerCase().trim();
    const off = /disable|^off$/.test(v);
    if (/shutter sync|high.?speed|\bhss\b|\bfp\b/.test(name)) {
      // 1st or 2nd curtain: normal sync.
      if (off || /curtain|first|second|rear|front/.test(v)) this.hss = false;
      else if (/enable|^on$|high.?speed|\bhss\b/.test(v)) this.hss = true;
      else return false;
    } else if (/flash (exp|comp)|\bfec\b/.test(name)) {
      const stops = off ? 0 : stopsOf(v);
      if (stops === null) return false;
      this.fec = Math.min(3, Math.max(-3, stops));
    } else if (/hdr|dyn(amic)?\.? ?range/.test(name)) {
      const stops = v.match(/([123])\s*ev/);
      if (off) this.hdr = null;
      else if (v === "auto") this.hdr = "auto";
      else if (stops) this.hdr = Number(stops[1]);
      else return false;
    } else return false;
    this.wake();
    return true;
  }

  /** The user reconnects from the camera's menu (after a Wi-Fi disconnect or power-off). */
  reconnect() {
    this.offline = false;
    this.reported.clear();
  }

  status(): SimStatus {
    return {
      scene: this.scene.id,
      sceneTitle: this.scene.title,
      lens: this.scene.lens.name,
      settings: scalars(this.settings),
      exposure: this.solve(this.clock(), { movie: this.movie }),
      meterEv: meter(this.scene, String(this.eff("metering")), this.clock()),
      liveview: this.lv.size,
      busy: this.busy,
      shots: this.shotRecords(),
      focus: this.focus,
      focusOn: this.focusOn,
      moviemode: this.movie,
      recording: !!this.recording,
      offline: this.offline,
      card: { files: this.card.files.length, free: this.card.free() },
      menu: {
        ...(this.hdr === null ? {} : { "HDR Mode": this.hdr === "auto" ? "Auto" : `±${this.hdr} EV` }),
        ...(this.hss ? { "High-speed sync": "On" } : {}),
        ...(this.fec ? { "Flash exp. comp.": `${this.fec > 0 ? "+" : ""}${Number(this.fec.toFixed(1))} EV` } : {}),
      },
    };
  }

  /** What the camera's rear screen shows right now (exposure simulation), at width `w`. */
  async frame(w = 600): Promise<Uint8Array> {
    const img = this.renderLive(w);
    return this.deps.encodeJpeg(img.rgba, img.w, img.h, 0.75);
  }

  private clock() {
    return (this.deps.now() - this.start) / 1000;
  }

  private wait(ms: number) {
    return this.deps.delay ? this.deps.delay(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private shotRecords(): ShotRecord[] {
    const out: ShotRecord[] = [];
    for (const c of this.captures.values()) {
      const files = c.paths.filter((p) => this.card.find(p));
      if (!files.length) continue;
      const path = files.find((p) => /\.JPG$/i.test(p)) ?? files[0];
      out.push({ path, name: path.split("/").pop()!, exposure: c.exposure, settings: c.settings, focusOn: c.focusOn, focus: c.focus, flash: c.flash, time: c.time, files });
    }
    return out;
  }

  // ---------------------------------------------------------------- exposure

  private mode() {
    return String(this.settings.shootingmode);
  }

  /** A setting as the camera applies it: scene-auto (A+) decides most things itself. */
  private eff(key: string): unknown {
    if (this.mode() === "a+") {
      const forced: Record<string, unknown> = {
        metering: "evaluative", wb: "auto", picturestyle: "auto", colorspace: "srgb", exposure: "+0.0", iso: "auto",
        aeb: "+0.0", wbbracket: "0", wbshift: { ba: 0, mg: 0 }, afmethod: "face+tracking", flash: this.settings.flash === "off" ? "off" : "auto",
      };
      if (key in forced) return forced[key];
    }
    return this.settings[key];
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

  /**
   * Exposure the camera would use now, from the meter and the mode.
   * `bias`: bracket offset in stops; `flash`: the flash fires (fill, or slow
   * sync), which limits the shutter speed; `movie`: movie auto exposure;
   * `bulb`: how long the shutter is held open in bulb mode.
   */
  solve(time: number, o: { bias?: number; flash?: "fill" | "slow" | null; movie?: boolean; bulb?: number } = {}): Exposure {
    const mode = o.movie ? "movie" : this.mode();
    const lens = this.scene.lens;
    const ev = meter(this.scene, String(this.eff("metering")), time);
    const autoIso = this.eff("iso") === "auto" || mode === "movie" || mode === "a+";
    const fixedM = mode === "m" && !autoIso;
    // No compensation in M with a fixed ISO or in bulb (the setting is emptied there), nor in movie auto.
    const comp = fixedM || mode === "bulb" || mode === "movie" ? 0 : evStops(String(this.eff("exposure"))) ?? 0;
    const bias = o.bias ?? 0;
    const target = ev - comp - (fixedM ? 0 : bias); // EV at ISO 100 the camera aims for
    const minT = 1 / 8000;
    const maxT = 30;
    const handheldT = 1 / Math.max(lens.focal, 30);
    const isoMax = o.flash ? FLASH_ISO_MAX : AUTO_ISO_MAX;
    // The fastest shutter speed the flash works at: any, with high-speed sync.
    const sync = this.hss ? minT : SYNC;
    const clampIso = (v: number) => Math.min(isoMax, Math.max(100, v));
    const isoFor = (n: number, t: number) => clampIso((n * n * 100) / (t * 2 ** target));
    const needT = (n: number, i: number) => (n * n * 100) / (i * 2 ** target);

    // High-frequency anti-flicker replaces the shutter speed with its own fine-step one.
    const hf = mode === "tv" || mode === "m" ? this.hfTv() : null;
    let N = avNumber(String(this.settings.av)) ?? lens.maxAperture;
    let t = hf ?? tvSeconds(String(this.settings.tv)) ?? 1 / 125;
    // With flash, Tv and M shoot at the sync speed at most (and solve the rest for it).
    if (o.flash && (mode === "tv" || mode === "m")) t = Math.max(t, sync);
    let iso = autoIso ? 100 : isoNumber(String(this.settings.iso)) ?? 100;

    switch (mode) {
      case "m":
        if (autoIso) iso = isoFor(N, t);
        else if (!hf) t *= 2 ** bias;
        break;
      case "bulb":
        if (autoIso) iso = 400;
        t = o.bulb ?? needT(N, iso);
        break;
      case "movie":
        // Movie auto: a 180° shutter at 30p, program aperture, then ISO.
        t = 1 / 60;
        N = Math.min(Math.max(lens.maxAperture, Math.sqrt(t * 2 ** target)), lens.minAperture);
        iso = isoFor(N, t);
        break;
      case "tv": {
        // Aperture first; with auto ISO, raise ISO once the lens is wide open.
        N = Math.sqrt((t * iso * 2 ** target) / 100);
        if (N < lens.maxAperture) {
          N = lens.maxAperture;
          if (autoIso) iso = isoFor(N, t);
        }
        N = Math.min(Math.max(N, lens.maxAperture), lens.minAperture);
        break;
      }
      case "p":
      case "a+":
        // Program line: stop down as light allows, between wide open and f/8.
        N = Math.min(8, Math.max(lens.maxAperture, Math.sqrt(2 ** target / 250)));
      // falls through: then behave like Av at that aperture
      default: {
        t = needT(N, iso);
        if (autoIso && t > handheldT) {
          iso = isoFor(N, handheldT);
          t = needT(N, iso);
        }
        t = Math.min(maxT, Math.max(minT, t));
      }
    }

    // With flash the shutter can't be faster than the sync speed; in P, Av
    // and A+ it also stays at 1/60 or faster unless slow sync is chosen.
    if (o.flash && mode !== "bulb") {
      if (mode === "tv" || mode === "m") t = Math.max(t, sync);
      else {
        t = Math.min(o.flash === "slow" ? maxT : 1 / 60, Math.max(sync, t));
        if (autoIso) iso = isoFor(N, t);
      }
    }

    // Snap to what the camera can actually set.
    const lensList = this.lensAv();
    const av = nearest(lensList, N, avNumber);
    const tv = hf !== null && t === hf ? String(this.settings.hfflickertv) : nearest(TV_SCALE, t, tvSeconds);
    const isoValue = nearest(ISO_SCALE, iso, isoNumber);
    const Nq = avNumber(av)!;
    const tq = mode === "bulb" ? t : tvSeconds(tv)!;
    const isoq = isoNumber(isoValue)!;
    const used = Math.log2((Nq * Nq) / tq) - Math.log2(isoq / 100);
    return { N: Nq, t: tq, iso: isoq, av, tv, isoValue, error: target - used };
  }

  /** The HF anti-flicker shutter speed in seconds, when that mode is on (Tv and M only). */
  private hfTv(): number | null {
    if (this.movie || this.settings.hfantiflickershoot !== "enable") return null;
    return tvSeconds(String(this.settings.hfflickertv));
  }

  // ---------------------------------------------------------------- flicker

  /** The scene's flickering lights, the one lighting the most first. */
  private lights(): Flicker[] {
    const share = new Map<Flicker, number>();
    for (const l of this.scene.layers) if (l.flicker) share.set(l.flicker.light, Math.max(share.get(l.flicker.light) ?? 0, l.flicker.share));
    return [...share.keys()].sort((a, b) => share.get(b)! - share.get(a)!);
  }

  /**
   * How a frame exposed for `t` seconds samples the scene's flickering
   * lights. The shutter opens at a random moment of each light's cycle
   * (seeded per frame); with anti-flicker shooting the camera waits for the
   * mains ripple's peak and exposes for that brighter light instead.
   */
  private flickerTiming(t: number, seed: number): RenderOpts["flicker"] {
    const lights = this.lights();
    if (!lights.length) return undefined;
    const electronic = this.settings.shuttermode === "electronic" || this.movie;
    const travel = electronic ? READOUT : CURTAIN;
    const timed = !electronic && this.settings.antiflickershoot === "enable";
    const random = rng(Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995);
    const phase = new Map(lights.map((l) => [l, timed && isMains(l) ? peakStart(l, travel, t) : random() / l.hz]));
    let gain = 1;
    const mains = lights.find(isMains);
    if (timed && mains) {
      const g = windowGain(mains, peakStart(mains, travel, t) + travel / 2, t);
      const subject = this.subjectLayer();
      const share = subject?.flicker?.light === mains ? subject.flicker.share : 1;
      gain = 1 / (1 - share + share * luma(g));
    }
    return { travel, start: (l) => phase.get(l) ?? 0, gain };
  }

  private subjectLayer() {
    return this.scene.layers.find((l) => l.name === this.scene.subject.layer);
  }

  private subjectDepth() {
    return this.subjectLayer()?.depth ?? 3;
  }

  /** Whether (and how) the flash fires for a still. */
  private flashMode(time: number): "fill" | "slow" | null {
    if (this.movie || this.settings.shuttermode === "electronic") return null;
    const f = this.eff("flash");
    if (f === "on") return "fill";
    if (f === "slowsynchro") return "slow";
    if (f === "auto") return meter(this.scene, String(this.eff("metering")), time) < 8 ? "fill" : null;
    return null;
  }

  /**
   * E-TTL style power control: enough light to expose the subject at the
   * focus distance about two thirds of a stop under, as fill, moved by flash
   * exposure compensation. High-speed sync scales its whole range down.
   */
  private flashGn(e: Exposure): number {
    const d = Math.max(0.3, this.focus);
    const max = this.hss && e.t < SYNC ? hssPower(e.t) : 1;
    const p = Math.min(max, Math.max(max / 128, (0.63 * 2 ** this.fec * (d * e.N) ** 2 * 100) / (e.iso * GUIDE_NUMBER ** 2)));
    return GUIDE_NUMBER * Math.sqrt(p);
  }

  // ---------------------------------------------------------------- focus

  /** Runs AF with the current method at the AF point. */
  private runAf(time: number): AfResult {
    if (this.settings.afoperation === "manual") return { ok: true, depth: this.focus, on: this.focusOn };
    const method = String(this.eff("afmethod"));
    const r = autofocus(this.scene, method, afArea(method, this.afPoint, this.scene.w, this.scene.h), time, this.tracks(method));
    if (r.ok) {
      let depth = r.depth;
      // One-shot AF locks before the shutter fires: a moving subject has moved on.
      const subject = this.subjectLayer();
      if (subject?.motion && r.on === subject.name && this.settings.afoperation === "oneshot") depth *= 1.07;
      this.focus = depth;
      this.focusOn = r.on;
    }
    this.afState = r.ok ? 1 : 2;
    return r;
  }

  /** Whether the AF method follows a detected subject: face+tracking, or whole-area AF with tracking on. */
  private tracks(method: string) {
    return method === "face+tracking" || (method === "whole_area" && this.settings.trackingsetting === "enable");
  }

  // ---------------------------------------------------------------- images

  /** The recorded area of the sensor for the aspect ratio (sensor pixels); 16:9 in movie mode. */
  private aspectRect(): Rect {
    const { w, h } = this.scene;
    const ratio = this.movie ? "16:9" : String(this.settings.stillimageaspectratio);
    const centred = (cw: number, ch: number): Rect => ({ x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: Math.round(cw), h: Math.round(ch) });
    switch (ratio) {
      case "4:3": return centred((h * 4) / 3, h);
      case "16:9": return centred(w, (w * 9) / 16);
      case "1:1": return centred(h, h);
      case "x1.6": return centred(w / 1.6, h / 1.6);
      default: return { x: 0, y: 0, w, h };
    }
  }

  /** The part of the sensor the live view shows: the recorded area, magnified around the AF point. */
  private viewRect(): Rect {
    const a = this.aspectRect();
    const mag = Number(this.settings.lvzoom) || 1;
    if (mag <= 1 || this.movie) return a;
    const w = a.w / mag;
    const h = a.h / mag;
    const x = Math.min(a.x + a.w - w, Math.max(a.x, this.afPoint.x - w / 2));
    const y = Math.min(a.y + a.h - h, Math.max(a.y, this.afPoint.y - h / 2));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  private wbKelvin(): number {
    const wb = String(this.eff("wb"));
    if (wb === "colortemp") return Number(this.settings.colortemperature);
    const ct = wb.match(/^colortemp([234])$/);
    if (ct) return Number(this.settings[`colortemperature${ct[1]}`]);
    if (wb === "auto" || wb === "awbwhite") {
      // White priority corrects warm light more fully than ambience priority.
      return wb === "awbwhite" && this.scene.awbK < 4000 ? (this.scene.awbK + this.scene.lightK) / 2 : this.scene.awbK;
    }
    return WB_KELVIN[wb] ?? 5200;
  }

  /** Colour options shared by live view, stills and movies. */
  private look(): Pick<RenderOpts, "wbK" | "wbRgb" | "wbShift" | "pictureStyle" | "styleDetail"> {
    const style = String(this.eff("picturestyle"));
    const user = USER_STYLES.includes(style);
    const base = user ? String(this.settings[`picturestyle_${style}_basepicturestyle`]) : style;
    const custom = this.eff("wb") === "custom" ? this.customWb : null;
    return {
      wbK: this.wbKelvin(),
      ...(custom ? { wbRgb: custom } : {}),
      wbShift: this.eff("wbshift") as { ba: number; mg: number },
      pictureStyle: base,
      styleDetail: (this.settings[`picturestyle_${style}`] ?? styleDefaults(base)) as unknown as StyleDetail,
    };
  }

  /** The live view picture at width `w`: exposure simulation, previewed at the shooting aperture. */
  private renderLive(w: number): Rgba {
    const time = this.clock();
    if (this.afRunning && this.settings.afoperation === "servo") this.runAf(time);
    const e = this.movie ? this.solve(time, { movie: true }) : this.solve(time);
    const view = this.viewRect();
    // Render at a size where the viewed part still has about `w` pixels across.
    const full = Math.min(this.scene.w, Math.max(w, (w * this.scene.w) / view.w));
    const r = render(this.scene, {
      ...this.look(),
      w: full,
      N: e.N,
      t: e.t,
      iso: e.iso,
      // Previews the depth of field the shot will have, as mirrorless bodies that stop down for live view do.
      dofN: e.N,
      focus: this.focus,
      // Exposure simulation includes the flicker the still would catch.
      flicker: this.flickerTiming(e.t, Math.floor(time * 1000) + this.liveFrames++),
      time,
      motionBlur: false,
      shake: 0,
      seed: Math.floor(time * 1000),
    });
    const k = r.w / this.scene.w;
    const img = crop({ w: r.w, h: r.h, rgba: r.rgba }, { x: view.x * k, y: view.y * k, w: view.w * k, h: view.h * k });
    return img.w > w * 1.05 || img.w < w * 0.95 ? resize(img, w, (w * img.h) / img.w) : img;
  }

  private async liveJpeg(): Promise<{ img: Rgba; jpeg: Uint8Array }> {
    const img = this.renderLive(this.lv.size === "medium" ? this.scene.w : this.scene.w / 2);
    return { img, jpeg: await this.deps.encodeJpeg(img.rgba, img.w, img.h, 0.75) };
  }

  /** Live view incidental information (coordinates in sensor pixels). */
  private incidental(img: Rgba): Record<string, unknown> {
    const rect = (r: Rect) => ({ positionx: r.x, positiony: r.y, positionwidth: r.w, positionheight: r.h });
    const view = this.viewRect();
    const method = String(this.eff("afmethod"));
    let frame: Rect;
    let status = this.afState;
    if (this.tracks(method)) {
      const s = this.scene.subject;
      const layer = this.subjectLayer();
      const dx = layer ? motionAt(layer, this.clock()).dx : 0;
      frame = { x: Math.round(s.x * this.scene.w + dx), y: Math.round(s.y * this.scene.h), w: Math.round(s.w * this.scene.w), h: Math.round(s.h * this.scene.h) };
      if (!status) status = s.face ? 0x20 : 0x30;
    } else frame = afArea(method, this.afPoint, this.scene.w, this.scene.h);
    const now = this.functions.now();
    const t = this.clock();
    const out: Record<string, unknown> = {
      liveviewdata: {
        histogram: histogram(img),
        afframe: [{ status, select: 1, x: frame.x, y: frame.y, width: frame.w, height: frame.h }],
        image: { ...rect(view), sizex: this.scene.w, sizey: this.scene.h },
        visible: rect(this.aspectRect()),
        zoom: { magnification: Number(this.settings.lvzoom) || 1, ...rect(view) },
        systemtime: { sec: Math.floor(now / 1000), subsec: now % 1000 },
      },
    };
    if (this.angleInfo) {
      // Hand-held: the level wobbles by a few hundredths of a degree around level.
      const wob = this.scene.handheld ? 1 : 0;
      const deg = (v: number) => (Math.round(v * 100) + 36000) % 36000;
      out.angleinformation = { cameraposture: 0, rolling: deg(wob * 0.3 * Math.sin(t * 1.3)), pitching: deg(wob * 0.2 * Math.sin(t * 0.9 + 1)) };
    }
    return out;
  }

  // ---------------------------------------------------------------- shooting

  private shutterRefusal(): SimResponse | null {
    if (this.movie) return MODE;
    if (this.recording || this.shooting) return SHOOTING;
    if (this.busy) return BUSY;
    const raw = (this.settings.stillimagequality as { raw: string }).raw !== "none";
    if (this.card.free() < JPEG_ESTIMATE + (raw ? RAW_ESTIMATE : 0)) return msg(503, "Can not write to card");
    return null;
  }

  /** The frames one press produces: bursts, self-timer, exposure / WB / focus brackets. */
  private plan(t0: number, burst: number): Frame[] {
    // AEB is emptied in bulb (the shutter time is how long the button is held).
    const aeb = this.mode() === "bulb" ? 0 : evStops(String(this.eff("aeb"))) ?? 0;
    const biases = aeb ? [0, -aeb, aeb] : [0];
    const wbb = String(this.eff("wbbracket")).match(/^(ba|mg)(\d)$/);
    const shift = this.eff("wbshift") as { ba: number; mg: number };
    const wb = wbb
      ? [0, -Number(wbb[2]), Number(wbb[2])].map((n) => (wbb[1] === "ba" ? { ba: shift.ba + n, mg: shift.mg } : { ba: shift.ba, mg: shift.mg + n }))
      : [shift];
    let focuses = [this.focus];
    let stack: number[] | undefined;
    if (this.settings.focusbracketing === "enable") {
      // From the current focus towards infinity, in steps of the focus increment.
      const n = Number(this.settings.focusbracketing_numberofshots);
      const step = 0.01 * Number(this.settings.focusbracketing_focusincrement);
      const d0 = 1 / this.focus;
      focuses = Array.from({ length: n }, (_, i) => d0 - i * step).filter((d, i) => i === 0 || d > -step).map((d) => (d <= 1e-4 ? 10_000 : 1 / d));
      if (this.settings.focusbracketing_depthcomposite === "enable") stack = focuses;
    }
    const fps = DRIVE_FPS[String(this.settings.drive)] ?? 5;
    const frames: Frame[] = [];
    let i = 0;
    for (let b = 0; b < burst; b++) {
      for (const focus of focuses) for (const bias of biases) frames.push({ time: t0 + i++ / fps, bias, wb, focus });
    }
    if (stack) frames.push({ time: t0, bias: 0, wb: [shift], focus: this.focus, stack });
    return frames;
  }

  /** Self-timer delay in ms for the drive mode. */
  private timer() {
    const d = String(this.settings.drive);
    return d === "self_2sec" ? 2000 : d === "self_10sec" || d === "self_continuous" ? 10_000 : 0;
  }

  /** Full press and release (shutterbutton), or a full press of the manual button. */
  private press(af: boolean, manual: boolean): SimResponse {
    const refused = this.shutterRefusal();
    if (refused) return refused;
    const time = this.clock();
    if (af && this.settings.afoperation !== "manual") {
      const r = this.runAf(time);
      // One-shot AF has focus priority: no picture without focus.
      if (!r.ok && this.settings.afoperation === "oneshot") return msg(503, "Out of focus");
    }
    const drive = String(this.settings.drive);
    const continuous = drive in DRIVE_FPS;
    if (this.mode() === "bulb") {
      if (manual) {
        this.bulbStart = Date.now();
        this.busy = true;
        return ok();
      }
      // A one-call press holds the shutter open for one second.
      this.capture(this.plan(time, 1).map((f) => ({ ...f, bulb: 1 })), 0);
      return ok();
    }
    if (manual && continuous) {
      this.holdBurst();
      return ok();
    }
    const burst = continuous ? QUICK_BURST : drive === "self_continuous" ? 2 : 1;
    // With the self-timer the frames are exposed (and moving subjects caught) when it runs out.
    const delay = this.timer();
    this.capture(this.plan(time + delay / 1000, burst), delay);
    return ok();
  }

  /** Keeps shooting at the drive's frame rate (as fast as rendering allows) until release. */
  private holdBurst() {
    const fps = DRIVE_FPS[String(this.settings.drive)];
    const hold = { stop: false };
    this.busy = this.shooting = true;
    void (async () => {
      try {
        await this.wait(0);
        // Stops at release, at the buffer limit, or when the card is full.
        let room = true;
        for (let n = 0; n < MAX_BURST && room && !hold.stop; n++) {
          const t0 = Date.now();
          for (const f of this.plan(this.clock(), 1)) if (!(room = await this.writeFrame(f))) break;
          await this.wait(Math.max(0, 1000 / fps - (Date.now() - t0)));
        }
      } finally {
        this.busy = this.shooting = false;
        this.held = null;
        this.wake();
      }
    })();
    this.held = hold;
  }

  private release(): SimResponse {
    if (this.held) this.held.stop = true;
    if (this.bulbStart !== null) {
      const held = Math.max(1 / 30, (Date.now() - this.bulbStart) / 1000);
      this.bulbStart = null;
      this.busy = false;
      this.capture(this.plan(this.clock(), 1).map((f) => ({ ...f, bulb: held })), 0);
    }
    return ok();
  }

  /** Takes the planned frames in the background; the camera stays busy until they are written. */
  private capture(frames: Frame[], delayMs: number) {
    this.busy = true;
    this.shooting = frames.length > 1 || delayMs > 0;
    void (async () => {
      try {
        // Let the response go out first.
        await new Promise((r) => setTimeout(r, 0));
        if (delayMs) await this.wait(delayMs);
        const done = this.wait(250); // "writing to the card"
        for (const f of frames) {
          if (!(await this.writeFrame(f))) break;
        }
        this.shooting = false;
        await done;
      } finally {
        this.busy = this.shooting = false;
        this.wake();
      }
    })();
  }

  /** Renders one exposure and writes its files. False when the card is full. */
  private async writeFrame(f: Frame): Promise<boolean> {
    const q = this.settings.stillimagequality as { raw: string; jpeg: string };
    if (this.card.free() < (q.jpeg !== "none" ? JPEG_ESTIMATE * f.wb.length : 0) + (q.raw !== "none" ? RAW_ESTIMATE : 0)) return false;
    const flash = this.flashMode(f.time);
    const exposure = this.solve(f.time, { bias: f.bias, flash, bulb: f.bulb });
    const settings = scalars(this.settings);
    const seed = ++this.seq * 7919;
    const raw = q.raw !== "none";
    const base: RenderOpts = {
      ...this.look(),
      w: this.scene.w,
      N: exposure.N,
      t: exposure.t,
      iso: exposure.iso,
      dofN: exposure.N,
      focus: f.focus,
      ...(f.stack ? { focusStack: f.stack } : {}),
      colorSpace: this.eff("colorspace") === "adobe_rgb" ? "adobe_rgb" : "srgb",
      ...(flash ? { flash: { gn: this.flashGn(exposure) } } : {}),
      readout: this.settings.shuttermode === "electronic" ? READOUT : 0,
      flicker: this.flickerTiming(exposure.t, seed),
      time: f.time,
      motionBlur: true,
      shake: this.scene.handheld ? SHAKE : 0,
      seed,
      ...(this.hdr !== null ? { hdr: this.hdr } : {}),
    };
    const aspect = this.aspectRect();
    const modified = httpDate(this.functions.now());
    const sizeKey = q.jpeg === "none" ? "large" : q.jpeg;
    const [factor, letter] = SIZES[sizeKey] ?? SIZES.large;
    const prefix = this.functions.stillPrefix(letter, base.colorSpace === "adobe_rgb");
    const quality = 0.45 + 0.05 * Number(this.settings[`stillimagecompression_${sizeKey}`] ?? 8);
    // A depth composite is one extra JPEG, cropped a little if asked.
    const cropComp = f.stack && this.settings.focusbracketing_cropdepthcomp === "enable" ? 0.95 : 1;
    const variants = f.stack ? [f.wb[0]] : f.wb;
    for (let v = 0; v < variants.length; v++) {
      const r = render(this.scene, { ...base, wbShift: variants[v], linear: raw && v === 0 && !f.stack });
      const k = r.w / this.scene.w;
      let img = crop({ w: r.w, h: r.h, rgba: r.rgba }, { x: aspect.x * k, y: aspect.y * k, w: aspect.w * k, h: aspect.h * k });
      if (cropComp < 1) img = crop(img, { x: (img.w * (1 - cropComp)) / 2, y: (img.h * (1 - cropComp)) / 2, w: img.w * cropComp, h: img.h * cropComp });
      const thumbImg = resize(img, 160, Math.round((160 * img.h) / img.w));
      const thumb = await this.deps.encodeJpeg(thumbImg.rgba, thumbImg.w, thumbImg.h, 0.8);
      const number = this.card.takeNumber();
      const name = `${prefix}${String(number).padStart(4, "0")}`;
      const paths: string[] = [];
      if (q.jpeg !== "none" || f.stack) {
        const sized = factor < 1 ? resize(img, img.w * factor, img.h * factor) : img;
        const main = await this.deps.encodeJpeg(sized.rgba, sized.w, sized.h, quality);
        const file = this.card.add({ name: `${name}.JPG`, kind: "jpeg", main, thumb, display: sizeKey === "small" ? undefined : main, modified, playtime: null, capture: number });
        paths.push(this.card.path(file));
      }
      if (raw && r.linear) {
        let linear = r.linear;
        let rw = r.w;
        let rh = r.h;
        if (this.settings.stillimageaspectratio === "x1.6") {
          // The 1.6x crop is the only aspect that also crops the RAW.
          ({ linear, w: rw, h: rh } = cropLinear(linear, r.w, aspect));
        }
        const embedded = await this.deps.encodeJpeg(img.rgba, img.w, img.h, 0.9);
        const main = simRaw(linear, rw, rh, r.wbGains, embedded, q.raw === "craw");
        const file = this.card.add({ name: `${name}.CR3`, kind: "cr3", main, thumb, display: embedded, embedded, modified, playtime: null, capture: number });
        paths.push(this.card.path(file));
      }
      this.captures.set(number, { number, exposure, settings, focusOn: this.focusOn, focus: f.focus, flash: !!flash, time: f.time, paths });
      this.battery = Math.max(1, this.battery - 0.2);
    }
    this.pushed.effective_value_av = { value: exposure.av };
    this.pushed.effective_value_tv = { value: exposure.tv };
    this.pushed.effective_value_iso = { value: exposure.isoValue };
    this.wake();
    return true;
  }

  // ---------------------------------------------------------------- movie

  private startRecording(): SimResponse {
    if (!this.movie) return MODE;
    if (this.recording || this.busy) return SHOOTING;
    if (this.card.free() < 4 * JPEG_ESTIMATE) return msg(503, "Can not write to card");
    const time = this.clock();
    const rec: Recording = { frames: [], stop: false, done: Promise.resolve(), w: 0, h: 0, exposure: this.solve(time, { movie: true }), time };
    rec.done = (async () => {
      // Frames at preview size (the live view is 16:9 in movie mode), one at a
      // time and each with its real duration.
      do {
        const t0 = Date.now();
        let img = this.renderLive(600);
        if (this.settings.moviecropping === "enable") {
          const c = crop(img, { x: img.w * 0.1875, y: img.h * 0.1875, w: img.w / 1.6, h: img.h / 1.6 });
          img = resize(c, img.w, img.h);
        }
        rec.w = img.w;
        rec.h = img.h;
        rec.frames.push({ jpeg: await this.deps.encodeJpeg(img.rgba, img.w, img.h, 0.7), at: t0 });
        if (rec.stop) break;
        await this.wait(Math.max(0, MOVIE_FRAME_MS - (Date.now() - t0)));
      } while (!rec.stop && rec.frames.length < MOVIE_MAX_FRAMES);
    })();
    this.recording = rec;
    return ok();
  }

  private async stopRecording(): Promise<SimResponse> {
    const rec = this.recording;
    if (!rec) return INVALID;
    rec.stop = true;
    await rec.done;
    this.recording = null;
    const end = Date.now();
    const frames: MovieFrame[] = rec.frames.map((f, i) => ({ jpeg: f.jpeg, ms: Math.max(1, (rec.frames[i + 1]?.at ?? end) - f.at) }));
    const ms = frames.reduce((n, f) => n + f.ms, 0);
    const main = quicktimeMjpeg(frames, rec.w, rec.h);
    const number = this.card.takeNumber();
    const file = this.card.add({
      name: `MVI_${String(number).padStart(4, "0")}.MOV`, kind: "mov", main, thumb: rec.frames[0].jpeg,
      modified: httpDate(this.functions.now()), playtime: Math.max(1, Math.round(ms / 1000)), capture: number,
    });
    this.captures.set(number, { number, exposure: rec.exposure, settings: scalars(this.settings), focusOn: this.focusOn, focus: this.focus, flash: false, time: rec.time, paths: [this.card.path(file)] });
    this.battery = Math.max(1, this.battery - ms / 60_000);
    return ok();
  }

  // ---------------------------------------------------------------- CCAPI state

  private ctx(): SettingsContext {
    return { mode: this.mode(), movie: this.movie, lensAv: this.lensAv(), ignoreDial: this.ignoreDial, hfResult: this.hfResult, values: this.settings };
  }

  /** A 503 for this setting in the current state, or null. */
  private refusal(s: SettingDef, c: SettingsContext): string | null {
    if (s.scope === "still" && c.movie) return "Mode not supported";
    if (s.scope === "movie" && !c.movie) return "Mode not supported";
    return s.refuse(c);
  }

  /** As the bulk list and events show it: emptied when it can't be used now. */
  private reportFor(s: SettingDef, c: SettingsContext) {
    return report(s, c, this.refusal(s, c) !== null || !s.available(c));
  }

  private dial() {
    return { value: this.mode(), ability: [] };
  }

  private putSetting(s: SettingDef, value: unknown): SimResponse {
    const c = this.ctx();
    const refused = this.refusal(s, c);
    if (refused) return msg(503, refused);
    if (this.shooting || this.recording) return SHOOTING;
    const refusedPut = s.refusePut(c);
    if (refusedPut) return msg(503, refusedPut);
    const v = validate(s, value, c);
    if (v === null) return INVALID;
    this.settings[s.key] = v;
    // Knock-on effects of the change.
    const base = s.key.match(/^picturestyle_(userdef\d)_basepicturestyle$/);
    if (base) this.settings[`picturestyle_${base[1]}`] = styleDefaults(String(v));
    if (s.key === "stillimagequality" && (v as { raw: string }).raw !== "none") this.settings.wbbracket = "0";
    if (s.key === "afoperation" && v === "manual") this.afRunning = false;
    if (s.key === "afmethod" || s.key === "lvzoom") this.afState = 0;
    if (s.key === "hfflickertv") this.hfResult = false;
    if (s.quietPut) return ok();
    return ok({ value: report(s, this.ctx()).value });
  }

  private setMode(value: unknown): SimResponse {
    // The mode dial is physical: software may only override it in "ignore dial" mode.
    if (!this.ignoreDial) return MODE;
    if (this.shooting || this.recording) return SHOOTING;
    if (typeof value !== "string" || !MODES.includes(value)) return INVALID;
    this.settings.shootingmode = value;
    this.clampAv();
    return ok({ value });
  }

  private devicestatus(name: string): unknown {
    const pct = Math.round(this.battery);
    switch (name) {
      case "battery": {
        const level = pct >= 90 ? "full" : pct >= 60 ? "high" : pct >= 35 ? "half" : pct >= 15 ? "quarter" : "low";
        return { name: "LP-E6NH", kind: "battery", level, quality: "good" };
      }
      case "batterylist":
        return { batterylist: [{ position: "camera", kind: "battery", name: "LP-E6NH", quality: "good", level: String(pct) }] };
      case "lens":
        return { mount: true, name: this.scene.lens.name };
      case "temperature":
        return { status: "normal" };
      case "powerzoomstatus":
        return { status: false, sw: "none", moving: false, location: "none", equip: false, battery: false, lock: false, limit: false, temperature: "none" };
      case "storage":
        return { storagelist: [this.card.storageInfo()] };
      case "currentstorage":
        return { name: "card1", path: this.card.storagePath() };
      case "currentdirectory":
        return { name: this.card.current, path: this.card.dirPath(this.card.current) };
    }
    return null;
  }

  private recordable() {
    const raw = (this.settings.stillimagequality as { raw: string }).raw !== "none";
    const free = this.card.free();
    return this.movie
      ? { recordableshots: null, remainingtime: Math.floor(free / 250_000) }
      : { recordableshots: Math.max(0, Math.floor(free / (JPEG_ESTIMATE + (raw ? RAW_ESTIMATE : 0)))), remainingtime: null };
  }

  // ---------------------------------------------------------------- events

  /** Everything event polling can report, keyed as the camera reports it. */
  private eventState(): Record<string, unknown> {
    const c = this.ctx();
    const out: Record<string, unknown> = { shootingmodedial: this.dial(), shootingmode: { value: this.mode(), ability: MODES } };
    for (const s of SETTINGS) out[s.key] = this.reportFor(s, c);
    Object.assign(out, this.functions.eventItems());
    for (const k of ["storage", "currentstorage", "currentdirectory", "battery", "batterylist", "lens", "temperature"]) out[k] = this.devicestatus(k);
    out.moviemode = { status: this.movie ? "on" : "off" };
    out.recbutton = { status: this.recording ? "start" : "stop" };
    out.recordable = this.recordable();
    out.liveview = { liveviewsize: this.lv.size, cameradisplay: this.lv.display };
    return out;
  }

  private effectiveChanges(): Record<string, unknown> {
    if (this.movie) return {};
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

  /** Changes since the last report. ver100 gives content as absolute URLs (deletions as the parent). */
  private takeEvents(v100: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.eventState())) {
      const j = JSON.stringify(v);
      if (this.reported.get(k) !== j) {
        out[k] = v;
        this.reported.set(k, j);
      }
    }
    // What the last shot really used wins over the live meter's current pick,
    // which then comes again on the next poll.
    const shot = "effective_value_av" in this.pushed;
    Object.assign(out, this.effectiveChanges(), this.pushed);
    if (shot) this.lastEffective = "";
    this.pushed = {};
    const keys: Record<ContentEvent["type"], string> = { added: "addedcontents", deleted: "deletedcontents", updated: "updatedcontents", cardformat: "cardformat" };
    for (const e of this.contentEvents.splice(0)) {
      const where = v100 ? this.baseUrl + (e.type === "deleted" ? e.path.slice(0, e.path.lastIndexOf("/")) : e.path) : e.path;
      const list = (out[keys[e.type]] ??= []) as string[];
      if (!list.includes(where)) list.push(where);
    }
    return out;
  }

  /** Waits up to `ms` for something to report (returns early on DELETE of the poll). */
  private async waitEvents(v100: boolean, ms: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    const seq = this.stopSeq;
    let out = this.takeEvents(v100);
    while (!Object.keys(out).length && Date.now() < deadline && seq === this.stopSeq) {
      await new Promise<void>((resolve) => {
        // Woken early or timed out, either way it leaves the waiting list.
        const done = () => {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.waiters.push(done);
      });
      out = this.takeEvents(v100);
    }
    return out;
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  private discovery() {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const [ver, path, m] of ROUTES) {
      (out[ver] ??= []).push({ path: `/ccapi/${ver}/${path}`, get: m.includes("G"), post: m.includes("O"), put: m.includes("P"), delete: m.includes("D") });
    }
    return out;
  }

  // ---------------------------------------------------------------- CCAPI routing

  async handle(req: SimRequest): Promise<SimResponse> {
    if (this.offline) return { status: 0, closed: true };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    if (headers.host) this.baseUrl = `http://${headers.host}`;
    // CORS: when the camera's CORS setting is on, only the allowed origin may call.
    const allowed = this.functions.corsOrigin();
    if (headers.origin && allowed !== null && allowed !== "*" && allowed !== headers.origin) return msg(403, "Forbidden");
    const res = await this.route(req, headers);
    if (req.method.toUpperCase() !== "GET") this.wake();
    if (headers.origin && allowed !== null) res.headers = { ...res.headers, "access-control-allow-origin": allowed === "*" ? "*" : headers.origin };
    return res;
  }

  private async route(req: SimRequest, headers: Record<string, string>): Promise<SimResponse> {
    const [pathname, query = ""] = req.path.split("?");
    const params = new URLSearchParams(query);
    const p = pathname.replace(/\/+$/, "");
    const m = req.method.toUpperCase();
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;

    if (p === "/ccapi") return m === "GET" ? ok(this.discovery()) : NOT_ALLOWED;
    const mm = p.match(/^\/ccapi\/(ver\d{3})\/(.+)$/);
    if (!mm) return NOT_FOUND;
    const [, ver, rest] = mm;

    if (ver === "ver120" && (rest === "contents" || rest.startsWith("contents/"))) {
      // Browsing waits while pictures are taken, a movie records, or movie mode is on.
      if (this.shooting || this.recording) return SHOOTING;
      if (this.movie) return BUSY;
      return this.card.handle(m, rest.slice("contents".length), params, headers, req.body);
    }
    const methods = ROUTE_METHODS.get(`${ver}/${rest}`);
    if (!methods) return NOT_FOUND;
    if (!methods.includes(METHOD_LETTER[m] ?? "?")) return NOT_ALLOWED;

    if (rest === "deviceinformation") {
      return ok({ manufacturer: "Simulator", productname: "Canon EOS R6 Mark II", guid: "00000000-0000-0000-0000-000000000000", serialnumber: "000000000001", macaddress: "00:00:00:00:00:01", firmwareversion: "1.0.0" });
    }
    if (rest.startsWith("devicestatus/")) return ok(this.devicestatus(rest.slice("devicestatus/".length)));
    if (rest.startsWith("customfunction/")) return ok({ value: "1/3" });
    if (rest.startsWith("functions/")) {
      const res = this.functions.handle(m, rest.slice("functions/".length), body, {
        card: this.card,
        busy: () => (this.shooting || this.recording ? "During shooting or recording" : this.busy ? "Device busy" : null),
        changed: (key, value) => {
          if (key === "datetime") this.pushed.datetime = value;
          this.wake();
        },
        goOffline: () => {
          this.offline = true;
          this.lv.size = "off";
        },
      });
      return res ?? NOT_FOUND;
    }

    // ------------------------------------------------ settings
    if (rest === "shooting/settings") {
      const c = this.ctx();
      const out: Record<string, unknown> = ver === "ver100" ? { shootingmodedial: this.dial() } : {};
      for (const s of SETTINGS) if (s.ver === ver && s.bulk) out[s.key] = this.reportFor(s, c);
      return ok(out);
    }
    if (rest === "shooting/settings/shootingmodedial") return m === "GET" ? ok(this.dial()) : this.setMode(body.value);
    if (rest === "shooting/settings/shootingmode") return m === "GET" ? ok({ value: this.mode(), ability: MODES }) : this.setMode(body.value);
    if (rest.startsWith("shooting/settings/")) {
      const s = SETTING_BY_PATH.get(rest.slice("shooting/settings/".length));
      if (!s) return NOT_FOUND;
      const c = this.ctx();
      if (m === "GET") {
        const refused = this.refusal(s, c);
        return refused ? msg(503, refused) : ok(report(s, c));
      }
      if (m === "PUT") return "value" in body ? this.putSetting(s, body.value) : INVALID;
      // DELETE: back to the default detail parameters.
      const refused = this.refusal(s, c);
      if (refused) return msg(503, refused);
      if (this.shooting || this.recording) return SHOOTING;
      const userBase = USER_STYLES.includes(s.path.split("/")[1]) ? String(this.settings[`${s.key}_basepicturestyle`]) : null;
      this.settings[s.key] = userBase ? styleDefaults(userBase) : structuredClone(s.def);
      return ok({ value: report(s, this.ctx()).value });
    }
    if (rest === "shooting/information/recordable") return ok(this.recordable());

    // ------------------------------------------------ shooting control
    if (rest === "shooting/control/ignoreshootingmodedialmode") {
      if (m === "GET") return ok({ status: this.ignoreDial ? "on" : "off" });
      if (body.action !== "on" && body.action !== "off") return INVALID;
      if (this.movie && body.action === "on") return MODE;
      this.ignoreDial = body.action === "on";
      return ok();
    }
    if (rest === "shooting/control/shutterbutton") {
      if (typeof body.af !== "boolean") return INVALID;
      return this.press(body.af, false);
    }
    if (rest === "shooting/control/shutterbutton/manual") {
      const action = body.action;
      if (typeof body.af !== "boolean" && body.af !== undefined) return INVALID;
      if (action === "half_press") {
        if (this.movie) return MODE;
        if (body.af === true && this.settings.afoperation !== "manual") this.runAf(this.clock());
        return ok();
      }
      if (action === "full_press") return this.press(body.af === true, true);
      if (action === "release") return this.release();
      return INVALID;
    }
    if (rest === "shooting/control/moviemode") {
      if (m === "GET") return ok({ status: this.movie ? "on" : "off" });
      if (body.action !== "on" && body.action !== "off") return INVALID;
      if (this.busy || this.shooting) return SHOOTING;
      if (body.action === "off" && this.recording) return MODE;
      if (body.action === "on" && this.lv.size === "off" && this.lv.display === "off") return LV_OFF;
      this.movie = body.action === "on";
      if (this.movie) this.ignoreDial = false;
      return ok();
    }
    if (rest === "shooting/control/recbutton") {
      if (body.action === "start") return this.startRecording();
      if (body.action === "stop") return this.stopRecording();
      return INVALID;
    }
    if (rest === "shooting/control/drivefocus") {
      const step = typeof body.value === "string" ? DRIVE_FOCUS[body.value] : undefined;
      if (step === undefined) return INVALID;
      if (this.shooting || this.recording) return SHOOTING;
      // With the lens on MF the focus motor is disengaged: no effect.
      if (this.settings.afoperation === "manual") return ok();
      const d = Math.min(1 / this.scene.lens.minFocus, Math.max(0, 1 / this.focus + step));
      this.focus = d <= 1e-4 ? 10_000 : 1 / d;
      this.focusOn = "manual";
      this.afState = 0;
      return ok();
    }
    if (rest === "shooting/control/af") {
      if (body.action === "start") {
        if (this.afRunning) return msg(503, "Already started");
        if (this.shooting || this.recording) return SHOOTING;
        this.runAf(this.clock());
        this.afRunning = true;
        return ok();
      }
      if (body.action === "stop") {
        this.afRunning = false;
        return ok();
      }
      return INVALID;
    }
    if (rest === "shooting/control/powerzoom") {
      // No power zoom lens or adapter: nothing can be driven.
      if (m === "GET") return ok({ value: "stop", ability: [] });
      return INVALID;
    }
    if (rest === "shooting/control/flickerdetection") {
      if (body.action !== "start") return INVALID;
      if (this.movie) return BUSY;
      // Mains flicker only: the ripple of lights on a 50 or 60 Hz supply.
      const mains = this.lights().find(isMains);
      return ok(mains ? { result: "ok", frequency: `${mains.hz}Hz` } : { result: "ng" });
    }
    if (rest === "shooting/control/hfflickerdetection") {
      if ((body.action !== "start" && body.action !== "cancel") || (body.action === "start" && typeof body.apply_result !== "boolean")) return INVALID;
      if (this.settings.hfantiflickershoot !== "enable" || this.recording) return MODE;
      if (body.action === "cancel") {
        this.hfResult = false;
        return ok();
      }
      if (this.lv.size === "off") return BUSY;
      // Any flicker, from mains ripple to fast LED dimming; the one lighting the most is reported.
      const light = this.lights()[0];
      if (!light) {
        this.hfResult = false;
        return ok({ result: "ng" });
      }
      // The recommended speed: as close to the set shutter speed as possible
      // while lasting a whole number of the light's periods.
      const want = Math.min(1 / 50, Math.max(1 / 8192, tvSeconds(String(this.settings.tv)) ?? 1 / 250));
      const tv = nearest(HF_TV, matchingTime(light, want), tvSeconds);
      this.hfResult = true;
      if (body.apply_result) this.settings.hfflickertv = tv;
      this.wake();
      return ok({ result: "ok", frequency: `${light.hz.toFixed(1)}Hz`, tv });
    }
    if (rest === "shooting/control/hfflickertv") {
      if (!["decrement_large", "decrement_small", "increment_small", "increment_large"].includes(String(body.value))) return INVALID;
      if (this.settings.hfantiflickershoot !== "enable" || this.recording) return MODE;
      if (!this.hfResult) return BUSY;
      const [dir, size] = String(body.value).split("_") as ["increment" | "decrement", "small" | "large"];
      // The list runs slow to fast: incrementing picks a faster speed.
      const i = Math.max(0, HF_TV.indexOf(String(this.settings.hfflickertv)));
      const j = Math.min(HF_TV.length - 1, Math.max(0, i + (dir === "increment" ? 1 : -1) * HF_STEP[size]));
      this.settings.hfflickertv = HF_TV[j];
      this.wake();
      return ok();
    }

    // ------------------------------------------------ live view
    if (rest === "shooting/liveview") {
      const size = body.liveviewsize;
      const display = body.cameradisplay;
      if (size !== "off" && size !== "small" && size !== "medium") return INVALID;
      if (display !== "on" && display !== "off" && display !== "keep") return INVALID;
      if (this.shooting || this.recording) return SHOOTING;
      if (display === "off" && this.movie) return MODE;
      this.lv.size = size;
      if (display !== "keep") this.lv.display = display;
      return ok();
    }
    if (rest === "shooting/liveview/flip") {
      if (this.lv.size === "off") return LV_OFF;
      return { status: 200, bytes: (await this.liveJpeg()).jpeg, contentType: "image/jpeg" };
    }
    if (rest === "shooting/liveview/flipdetail") {
      const kind = params.get("kind") ?? "image";
      if (!["image", "info", "both"].includes(kind)) return BAD_QUERY;
      if (this.lv.size === "off") return LV_OFF;
      return { status: 200, bytes: await this.detailRecords(kind), contentType: "application/octet-stream" };
    }
    const stream = rest.match(/^shooting\/liveview\/(scroll|scrolldetail|multipart)$/)?.[1];
    if (stream) {
      if (this.lv.size === "off") return LV_OFF;
      if (m === "DELETE") return ok();
      const kind = params.get("kind") ?? "image";
      if (stream === "scrolldetail" && !["image", "info", "both"].includes(kind)) return BAD_QUERY;
      return this.liveStream(stream, kind);
    }
    if (rest === "shooting/liveview/angleinformation") {
      if (body.action !== "start" && body.action !== "stop") return INVALID;
      this.angleInfo = body.action === "start";
      return ok();
    }
    if (rest === "shooting/liveview/afframeposition" || rest === "shooting/liveview/clickwb") {
      const x = body.positionx;
      const y = body.positiony;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return INVALID;
      const px = Math.min(this.scene.w - 1, Math.max(0, x as number));
      const py = Math.min(this.scene.h - 1, Math.max(0, y as number));
      if (rest.endsWith("afframeposition")) {
        if (this.shooting) return BUSY;
        this.afPoint = { x: px, y: py };
        this.afState = 0;
        return ok();
      }
      if (this.lv.size === "off") return LV_OFF;
      if (this.shooting || this.recording) return BUSY;
      this.customWb = this.sampleLight(px, py);
      this.settings.wb = "custom";
      return ok();
    }

    // ------------------------------------------------ events
    if (rest === "event/polling") {
      if (m === "DELETE") {
        this.stopSeq++;
        this.wake();
        return ok();
      }
      if (ver === "ver100") {
        const c = params.get("continue") ?? "off";
        if (c !== "on" && c !== "off") return BAD_QUERY;
        // continue=on holds the request (a real camera sends 100 Continue meanwhile) until something happens.
        return ok(await this.waitEvents(true, c === "on" ? 30_000 : 0));
      }
      const timeout = params.get("timeout") ?? "immediately";
      const ms: Record<string, number> = { immediately: 0, short: 10_000, long: 30_000 };
      if (!(timeout in ms)) return BAD_QUERY;
      return ok(await this.waitEvents(false, ms[timeout]));
    }
    if (rest === "event/monitoring") {
      // The stream is answered as one batch of event records, after which it ends.
      if (m === "DELETE") {
        if (!this.monitoring) return msg(503, "Not started");
        this.stopSeq++;
        this.wake();
        return ok();
      }
      if (this.monitoring) return msg(503, "Already started");
      this.monitoring = true;
      try {
        const ev = await this.waitEvents(true, 10_000);
        return { status: 200, bytes: Object.keys(ev).length ? jsonRecord(RECORD_EVENT, ev) : new Uint8Array(0), contentType: "application/octet-stream" };
      } finally {
        this.monitoring = false;
      }
    }
    return NOT_FOUND;
  }

  private async detailRecords(kind: string): Promise<Uint8Array> {
    const { img, jpeg } = await this.liveJpeg();
    const parts: Uint8Array[] = [];
    if (kind !== "image") parts.push(jsonRecord(RECORD_INFO, this.incidental(img)));
    if (kind !== "info") parts.push(record(RECORD_JPEG, jpeg));
    return concat(parts);
  }

  /**
   * The continuous live-view streams, simplified: the transport returns one
   * response, so a stream answers with a short run of frames and then ends,
   * as if stopped. A second request while one is being produced gets
   * "Already started".
   */
  private async liveStream(kind: string, detail: string): Promise<SimResponse> {
    if (this.streams.has(kind)) return msg(503, "Already started");
    this.streams.add(kind);
    try {
      const frames: Uint8Array[] = [];
      for (let i = 0; i < STREAM_FRAMES; i++) {
        if (i) await this.wait(100);
        frames.push(kind === "scrolldetail" ? await this.detailRecords(detail) : (await this.liveJpeg()).jpeg);
      }
      if (kind === "multipart") return { status: 200, bytes: multipart(frames), contentType: MULTIPART_TYPE };
      return { status: 200, bytes: concat(frames), contentType: kind === "scroll" ? "image/octet-stream" : "application/octet-stream" };
    } finally {
      this.streams.delete(kind);
    }
  }

  /** Colour of the light at a sensor point, for a custom white balance (as a grey card reading). */
  private sampleLight(x: number, y: number): RGB {
    const f = 4;
    const { rgb, w, h } = composite(this.scene, { w: this.scene.w / f, dofN: this.scene.lens.maxAperture, focus: this.focus, time: this.clock(), motionBlur: false, t: 0 });
    const sum: RGB = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const sx = Math.min(w - 1, Math.max(0, Math.floor(x / f) + dx));
        const sy = Math.min(h - 1, Math.max(0, Math.floor(y / f) + dy));
        const i = (sy * w + sx) * 3;
        for (let c = 0; c < 3; c++) sum[c] += rgb[i + c];
      }
    }
    const lum = luma(sum) || 1;
    return sum.map((v) => Math.max(1e-3, v / lum)) as RGB;
  }
}

const WB_KELVIN: Record<string, number> = { daylight: 5200, shade: 7000, cloudy: 6000, tungsten: 3200, whitefluorescent: 4000, flash: 6000, custom: 5200 };
const METHOD_LETTER: Record<string, string> = { GET: "G", POST: "O", PUT: "P", DELETE: "D" };
const STREAM_FRAMES = 3;

/** The API of the simulated body: version, path after the version, methods (G get, O post, P put, D delete). */
const ROUTES: Array<[string, string, Methods]> = [
  ["ver100", "deviceinformation", "G"],
  ["ver100", "devicestatus/battery", "G"],
  ["ver100", "devicestatus/lens", "G"],
  ["ver100", "devicestatus/temperature", "G"],
  ["ver100", "devicestatus/powerzoomstatus", "G"],
  ...CameraFunctions.endpoints().map(([v, p, m]) => [v, `functions/${p}`, m] as [string, string, Methods]),
  ["ver100", "shooting/control/shutterbutton", "O"],
  ["ver100", "shooting/control/shutterbutton/manual", "O"],
  ["ver100", "shooting/control/ignoreshootingmodedialmode", "GO"],
  ["ver100", "shooting/control/moviemode", "GO"],
  ["ver100", "shooting/control/recbutton", "O"],
  ["ver100", "shooting/control/drivefocus", "O"],
  ["ver100", "shooting/control/af", "O"],
  ["ver100", "shooting/control/powerzoom", "GO"],
  ["ver100", "shooting/settings", "G"],
  ["ver100", "shooting/settings/shootingmodedial", "GP"],
  ...SETTINGS.filter((s) => s.ver === "ver100").map((s) => [s.ver, `shooting/settings/${s.path}`, s.del ? "GPD" : "GP"] as [string, string, Methods]),
  ["ver100", "shooting/information/recordable", "G"],
  ["ver100", "shooting/liveview", "O"],
  ["ver100", "shooting/liveview/flip", "G"],
  ["ver100", "shooting/liveview/flipdetail", "G"],
  ["ver100", "shooting/liveview/scroll", "GD"],
  ["ver100", "shooting/liveview/scrolldetail", "GD"],
  ["ver100", "shooting/liveview/multipart", "GD"],
  ["ver100", "shooting/liveview/angleinformation", "O"],
  ["ver100", "shooting/liveview/afframeposition", "P"],
  ["ver100", "event/polling", "GD"],
  ["ver100", "event/monitoring", "GD"],
  ["ver110", "devicestatus/storage", "G"],
  ["ver110", "devicestatus/currentstorage", "G"],
  ["ver110", "devicestatus/currentdirectory", "G"],
  ["ver110", "devicestatus/batterylist", "G"],
  ["ver110", "shooting/settings", "G"],
  ["ver110", "shooting/settings/shootingmode", "GP"],
  ...SETTINGS.filter((s) => s.ver === "ver110").map((s) => [s.ver, `shooting/settings/${s.path}`, s.del ? "GPD" : "GP"] as [string, string, Methods]),
  ["ver110", "shooting/liveview/clickwb", "O"],
  ["ver110", "shooting/control/flickerdetection", "O"],
  ["ver110", "shooting/control/hfflickerdetection", "O"],
  ["ver110", "shooting/control/hfflickertv", "O"],
  ["ver110", "event/polling", "GD"],
  ["ver110", "customfunction/exposureincrements/av", "G"],
  ["ver110", "customfunction/exposureincrements/tv", "G"],
  ["ver110", "customfunction/exposureincrements/exposure", "G"],
  ["ver110", "customfunction/exposureincrements/flashexposure", "G"],
  ["ver110", "customfunction/isoincrements", "G"],
  ["ver120", "contents", "GPD"],
];
const ROUTE_METHODS = new Map(ROUTES.map(([ver, path, methods]) => [`${ver}/${path}`, methods]));

/** Just the plain values (for status and shot records). */
function scalars(o: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  return out;
}

/** Crops 3-channel linear data to a sensor rectangle. */
function cropLinear(lin: Float32Array, w: number, r: Rect): { linear: Float32Array; w: number; h: number } {
  const out = new Float32Array(r.w * r.h * 3);
  for (let y = 0; y < r.h; y++) out.set(lin.subarray(((r.y + y) * w + r.x) * 3, ((r.y + y) * w + r.x + r.w) * 3), y * r.w * 3);
  return { linear: out, w: r.w, h: r.h };
}

