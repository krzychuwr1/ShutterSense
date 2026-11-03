// The agent's camera tools, implemented on the CCAPI client: what
// get_camera_state, look, set_settings and shoot actually do, and what the
// model gets back. Image decoding and resizing are platform-specific and
// injected (canvas in the browser, Bitmap on Android).

import { AGENT_SETTINGS, STYLE_DETAIL_FIELDS } from "../shared/agent-api.ts";
import { diffLine, prettyValue } from "../shared/settings.ts";
import { CcapiClient, CcapiError, isComposite, SettingError, type AnySettingItem, type SettingItem, type Settings } from "../ccapi/client.ts";

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
    // With high-frequency anti-flicker on, Tv and M shoot at its matched speed, not the Tv setting.
    const hfTv = s.hfantiflickershoot?.value === "enable" && (mode === "tv" || mode === "m") ? String(s.hfflickertv?.value ?? "") : "";
    const parts = [prettyValue("shootingmode", mode), prettyValue("av", v("av")), prettyValue("tv", hfTv || v("tv"))];
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
      else if (key === "hfflickertv") entry.note = "set by detect_flicker with kind high_frequency";
      else if (EXPOSURE_KEYS.includes(key)) {
        entry.value = this.effective[key] ?? null;
        entry.note = "chosen by the camera in this mode";
      } else entry.note = "not available with the current settings (another setting rules it out)";
      settings[key] = entry;
    }
    const style = String(s.picturestyle?.value ?? "");
    let styleDetail: unknown;
    if (style) {
      try {
        const d = await this.client.pictureStyleDetail(style);
        const value = d.value as Record<string, unknown> | null;
        const ability = d.ability as Record<string, unknown>;
        if (value) styleDetail = Object.fromEntries(STYLE_DETAIL_FIELDS.filter((f) => f in value).map((f) => [f, { value: value[f], range: ability[f] }]));
      } catch {
        // not every style or camera exposes fine-tuning
      }
    }
    const battery = await this.client.battery();
    return JSON.stringify({ camera: this.describe(), battery, exposure_now: this.exposureLine(s), settings, style_detail: styleDetail });
  }

  private modeChangeable() {
    return this.client.has("shooting/settings/shootingmode", "put") || this.client.has("shooting/settings/shootingmodedial", "put");
  }

  /** A live-view frame; `zoom` (5 or 10) magnifies around the AF point to check focus, then zooms back out. */
  async look(zoom?: number): Promise<{ text: string; image: PreparedImage }> {
    let zoomed = false;
    if (zoom === 5 || zoom === 10) {
      try {
        await this.client.set("lvzoom", String(zoom));
        zoomed = true;
      } catch {
        // no magnified live view on this camera: plain frame
      }
    }
    let jpeg: Uint8Array;
    try {
      jpeg = await this.client.liveFrame();
    } finally {
      if (zoomed) await this.client.set("lvzoom", "1").catch(() => undefined);
    }
    const image = await this.images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.8);
    await this.drainEvents();
    const what = zoomed ? `Live view magnified ${zoom}x around the AF point` : zoom ? "Live view (this camera can't magnify)" : "Live view";
    return { text: `${what} at ${this.exposureLine()}. ${statsLine(image.stats)}`, image };
  }

  /**
   * Runs the camera's flicker detection. Mains: reports 100/120 Hz flicker.
   * High frequency (LED panels): switches on HF anti-flicker if needed, runs
   * the detection with live view on, and lets the camera take the shutter
   * speed that spans whole flicker periods.
   */
  async detectFlicker(kind: "mains" | "high_frequency"): Promise<{ applied: string[]; text: string }> {
    const applied: string[] = [];
    if (kind === "mains") {
      const r = await this.client.detectFlicker();
      return {
        applied,
        text:
          r.result === "ok"
            ? `Flicker detected${r.frequency ? ` at ${r.frequency}` : ""}. Anti-flicker shooting (antiflickershoot "enable", not with the electronic shutter) or a shutter speed of whole flicker periods removes it.`
            : "No mains flicker detected.",
      };
    }
    const hf = this.lastSettings.hfantiflickershoot;
    if (hf && hf.value !== "enable") {
      await this.client.set("hfantiflickershoot", "enable", hf);
      applied.push(diffLine("hfantiflickershoot", hf.value, "enable"));
    }
    await this.client.liveFrame(); // detection needs live view running
    const r = await this.client.hfFlickerDetection("start", true);
    await this.refresh();
    if (r.tv) applied.push(diffLine("hfflickertv", "–", r.tv));
    const found = r.result === "ok" || !!r.frequency;
    return {
      applied,
      text: found
        ? `High-frequency flicker at ${r.frequency ?? "an unknown frequency"}; the camera set the HF anti-flicker shutter speed to ${r.tv ?? "its recommendation"}, which spans whole flicker periods. Shoot in Tv or M to use it.`
        : `No high-frequency flicker found (${r.result ?? "no result"}).`,
    };
  }

  /**
   * Puts the AF point at (x, y), as fractions of the frame from the top left.
   * Tracking AF ignores the point, so it switches to 1-point AF first.
   */
  async focusAt(x: number, y: number): Promise<{ applied: string[]; text: string }> {
    const fx = Math.min(1, Math.max(0, x));
    const fy = Math.min(1, Math.max(0, y));
    const info = (await this.client.liveDetail("info")).info?.liveviewdata?.image;
    if (!info?.sizex || !info.sizey) throw new Error("the camera doesn't report its image size, so the AF point can't be placed.");
    const applied: string[] = [];
    const method = String(this.lastSettings.afmethod?.value ?? "");
    if (method === "face+tracking" || method === "whole_area") {
      const options = this.lastSettings.afmethod?.ability;
      const to = Array.isArray(options) ? ["1point", "spot", "expand_cross"].find((o) => options.includes(o)) : undefined;
      if (!to) throw new Error(`AF area ${method} ignores the AF point and can't be changed now.`);
      await this.client.set("afmethod", to, this.lastSettings.afmethod);
      applied.push(diffLine("afmethod", method, to));
    }
    await this.client.setAfFramePosition(fx * info.sizex, fy * info.sizey);
    const where = `${Math.round(fx * 100)}% across, ${Math.round(fy * 100)}% down`;
    applied.push(`AF point → ${where}`);
    await this.refresh();
    return { applied, text: `AF point moved to ${where}${applied.length > 1 ? ` (${applied[0]})` : ""}. The next shot with af true focuses there.` };
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
      let value: string | number | Record<string, number>;
      if (key === "colortemperature") value = Math.round(Number(changes[key]));
      else if (key === "wbshift") {
        const v = (changes[key] ?? {}) as Record<string, unknown>;
        const cur = (s.wbshift?.value ?? {}) as unknown as Record<string, number>;
        value = { ba: Math.round(Number(v.ba ?? cur.ba ?? 0)), mg: Math.round(Number(v.mg ?? cur.mg ?? 0)) };
      } else value = String(changes[key]).trim();
      const item: SettingItem | undefined = key === "shootingmode" ? (s.shootingmode ?? s.shootingmodedial) : s[key];
      const before = item?.value ?? null;
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      try {
        await this.client.set(key, value, key === "shootingmode" ? undefined : item);
        applied.push(diffLine(key, before === "" ? this.effective[key] ?? "auto" : before, value));
        // Mode, ISO and the shutter type change which other settings are available.
        if (key === "shootingmode" || key === "iso" || key === "shuttermode") s = await this.refresh();
      } catch (e) {
        if (e instanceof SettingError) errors.push(e.message);
        else if (e instanceof CcapiError) errors.push(`${key}: camera error ${e.status} ${e.message}`);
        else throw e;
      }
    }
    const detail = changes.style_detail as Record<string, unknown> | undefined;
    if (detail && typeof detail === "object") await this.setStyleDetail(detail, applied, errors);
    await this.refresh();
    return { applied, errors };
  }

  /** Fine-tunes the current picture style (contrast, saturation, sharpness, colour tone). */
  private async setStyleDetail(detail: Record<string, unknown>, applied: string[], errors: string[]) {
    const style = String(this.lastSettings.picturestyle?.value ?? "");
    const fields = STYLE_DETAIL_FIELDS.filter((f) => typeof detail[f] === "number" || (typeof detail[f] === "string" && detail[f] !== ""));
    if (!style || !fields.length) return;
    try {
      const before = (await this.client.pictureStyleDetail(style)).value as Record<string, number> | null;
      const changes = Object.fromEntries(fields.map((f) => [f, Math.round(Number(detail[f]))]));
      await this.client.setPictureStyleDetail(style, changes);
      for (const f of fields) if (before?.[f] !== changes[f]) applied.push(diffLine(f, before?.[f] ?? "-", changes[f]));
    } catch (e) {
      if (e instanceof SettingError) errors.push(e.message);
      else if (e instanceof CcapiError) errors.push(`picture style ${style}: camera error ${e.status} ${e.message}`);
      else throw e;
    }
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

/** Settings a mode can hand over to the camera, so "unchangeable" means "the camera picks it". */
const EXPOSURE_KEYS: string[] = ["av", "tv", "iso", "exposure"];

function isChangeable(item: SettingItem): boolean {
  const ab = item.ability;
  if (!ab) return false;
  if (Array.isArray(ab)) return ab.length > 0;
  if (isComposite(item as AnySettingItem)) {
    return Object.values(ab as Record<string, unknown>).some((f) => (Array.isArray(f) ? f.length > 0 : (f as { min?: number | null })?.min != null));
  }
  return ab.min !== null && ab.max !== null;
}
