// The agent's camera tools, implemented on the CCAPI client: what
// get_camera_state, look, set_settings and shoot actually do, and what the
// model gets back. Image decoding and resizing are platform-specific and
// injected (canvas in the browser, Bitmap on Android).

import { AGENT_SETTINGS } from "../shared/agent-api.ts";
import { diffLine, prettyValue } from "../shared/settings.ts";
import { CcapiClient, CcapiError, SettingError, type SettingItem, type Settings } from "../ccapi/client.ts";

export interface ImageStats {
  /** Mean luminance, 0-255. */
  mean: number;
  /** Mean luminance of the centre ninth of the frame. */
  center: number;
  /** Percent of pixels at or near white / black. */
  highlights: number;
  shadows: number;
}

export interface PreparedImage {
  dataUrl: string;
  w: number;
  h: number;
  stats: ImageStats;
}

export interface ImageTools {
  /** Downscales a JPEG so its long side is at most `maxSide`, re-encodes it, and measures it. */
  prepare(jpeg: Uint8Array, maxSide: number, quality?: number): Promise<PreparedImage>;
}

export interface ShotResult {
  n: number;
  jpeg: Uint8Array;
  image: PreparedImage;
  thumb: string;
  /** "f/2.8 · 1/1000 s · ISO 1600". */
  exposure: string;
  settings: Settings;
}

/** Long side of images sent to the model. */
export const MODEL_IMAGE_SIDE = 768;
const THUMB_SIDE = 320;

export const statsLine = (s: ImageStats) =>
  `Brightness: mean ${s.mean}/255, centre ${s.center}/255; clipped highlights ${s.highlights}%, crushed shadows ${s.shadows}%.`;

export class CameraTools {
  readonly client: CcapiClient;
  private images: ImageTools;
  /** Values the camera picked in auto modes, from event polling. */
  private effective: Record<string, string> = {};
  private model = "Camera";
  private lensName: string | null = null;
  private lastSettings: Settings = {};

  constructor(client: CcapiClient, images: ImageTools) {
    this.client = client;
    this.images = images;
  }

  async connect(): Promise<string> {
    await this.client.discover();
    try {
      const info = await this.client.deviceInfo();
      this.model = info.productname || this.model;
    } catch {
      // optional
    }
    this.lensName = await this.client.lens();
    await this.drainEvents();
    this.lastSettings = await this.client.settings();
    return this.describe();
  }

  describe() {
    return this.lensName ? `${this.model}, lens ${this.lensName}` : this.model;
  }

  get settings() {
    return this.lastSettings;
  }

  private absorb(ev: Record<string, unknown>) {
    for (const k of ["av", "tv", "iso", "exposure"]) {
      const item = ev[`effective_value_${k}`] as { value?: unknown } | undefined;
      if (item && typeof item.value === "string" && item.value) this.effective[k] = item.value;
    }
  }

  /** Reads pending events so later waits only see new ones. */
  async drainEvents() {
    try {
      this.absorb(await this.client.poll("immediately"));
    } catch {
      // cameras without polling still work, minus effective values
    }
  }

  async refresh(): Promise<Settings> {
    await this.drainEvents();
    this.lastSettings = await this.client.settings();
    return this.lastSettings;
  }

  /** "Av f/2.8 · 1/1000 s · ISO 1600 · +1 EV", using camera-chosen values where the mode picks them. */
  exposureLine(s: Settings = this.lastSettings): string {
    const v = (k: string) => {
      const own = s[k]?.value;
      return typeof own === "string" && own ? own : this.effective[k] ?? "";
    };
    const mode = String(s.shootingmode?.value || s.shootingmodedial?.value || "");
    const parts = [prettyValue("shootingmode", mode), prettyValue("av", v("av")), prettyValue("tv", v("tv"))];
    const iso = s.iso?.value === "auto" && this.effective.iso ? `ISO ${this.effective.iso} (auto)` : prettyValue("iso", v("iso"));
    parts.push(iso);
    const ev = s.exposure?.value;
    if (typeof ev === "string" && ev && ev !== "+0.0") parts.push(prettyValue("exposure", ev));
    return parts.filter((p) => p && p !== "–").join(" · ");
  }

  // ---------------------------------------------------------------- tools

  async getState(): Promise<string> {
    const s = await this.refresh();
    const settings: Record<string, unknown> = {};
    for (const key of AGENT_SETTINGS) {
      const item = key === "shootingmode" ? (s.shootingmode ?? s.shootingmodedial) : s[key];
      if (!item) continue;
      const changeable = key === "shootingmode" ? this.modeChangeable() : isChangeable(item);
      const entry: Record<string, unknown> = { value: item.value };
      if (key === "shootingmode") {
        entry.options = changeable && Array.isArray(item.ability) ? item.ability : [];
        if (!changeable || !Array.isArray(item.ability) || !item.ability.length) entry.note = "set by the mode dial; can't be changed";
      } else if (changeable) entry.options = item.ability;
      else {
        entry.value = this.effective[key] ?? null;
        entry.note = "chosen by the camera in this mode";
      }
      settings[key] = entry;
    }
    const battery = await this.client.battery();
    return JSON.stringify({ camera: this.describe(), battery, exposure_now: this.exposureLine(s), settings });
  }

  private modeChangeable() {
    return this.client.has("shooting/settings/shootingmode", "put") || this.client.has("shooting/settings/shootingmodedial", "put");
  }

  async look(): Promise<{ text: string; image: PreparedImage }> {
    const jpeg = await this.client.liveFrame();
    const image = await this.images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.8);
    await this.drainEvents();
    return { text: `Live view at ${this.exposureLine()}. ${statsLine(image.stats)}`, image };
  }

  /**
   * Applies changes in a safe order (mode first, so the other settings are
   * judged in the new mode). Each change is validated against the camera's
   * current options; failures don't stop the rest.
   */
  async set(changes: Record<string, unknown>): Promise<{ applied: string[]; errors: string[] }> {
    const order = ["shootingmode", "iso", ...AGENT_SETTINGS.filter((k) => k !== "shootingmode" && k !== "iso")];
    const keys = order.filter((k) => k in changes && changes[k] !== undefined && changes[k] !== null);
    const applied: string[] = [];
    const errors: string[] = [];
    let s = await this.refresh();
    for (const key of keys) {
      let value = changes[key] as string | number;
      if (key === "colortemperature") value = Math.round(Number(value));
      else value = String(value).trim();
      const item: SettingItem | undefined = key === "shootingmode" ? (s.shootingmode ?? s.shootingmodedial) : s[key];
      const before = item?.value ?? null;
      if (before === value) continue;
      try {
        await this.client.set(key, value, key === "shootingmode" ? undefined : item);
        applied.push(diffLine(key, before === "" ? this.effective[key] ?? "auto" : before, value));
        // Mode and ISO change which other settings are available.
        if (key === "shootingmode" || key === "iso") s = await this.refresh();
      } catch (e) {
        if (e instanceof SettingError) errors.push(e.message);
        else if (e instanceof CcapiError) errors.push(`${key}: camera error ${e.status} ${e.message}`);
        else throw e;
      }
    }
    await this.refresh();
    return { applied, errors };
  }

  /** Takes a picture, waits for the file, downloads a display-size copy. */
  async shoot(af: boolean, n: number): Promise<ShotResult> {
    await this.drainEvents();
    const settings = this.lastSettings;
    await this.client.shutter(af);
    const path = await this.client.waitForNewFile(20_000, (e) => this.absorb(e));
    const jpeg = await this.client.download(path, "display");
    const image = await this.images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.82);
    const thumb = (await this.images.prepare(jpeg, THUMB_SIDE, 0.6)).dataUrl;
    await this.drainEvents();
    return { n, jpeg, image, thumb, exposure: this.exposureLine(settings), settings };
  }
}

function isChangeable(item: SettingItem): boolean {
  const ab = item.ability;
  return Array.isArray(ab) ? ab.length > 0 : ab.min !== null && ab.max !== null;
}
