// The virtual camera's shooting settings as a table: where each one lives in
// the API, its type, default, what it accepts right now, and when the camera
// refuses it. The camera (camera.ts) serves GET / PUT / DELETE and the bulk
// lists from this table, and reads the values when it shoots.
//
// Availability follows the CCAPI pattern: a setting the current mode doesn't
// let you change is still reported, but "emptied" (value "" or null, empty
// ability), and a change is refused with 400. Still-photo settings answer 503
// "Mode not supported" in movie mode, movie settings outside it.

import { EXPOSURE_SCALE, ISO_SCALE, TV_SCALE } from "../shared/settings.ts";

export interface Range {
  min: number;
  max: number;
  step: number;
}

export type FieldAbility = string[] | Range;
export type Ability = string[] | Range | Record<string, FieldAbility>;

/** What the table needs to know about the camera. */
export interface SettingsContext {
  /** Shooting mode: p, av, tv, m, bulb, a+. */
  mode: string;
  movie: boolean;
  /** Apertures the mounted lens offers. */
  lensAv: string[];
  ignoreDial: boolean;
  /** The camera shows an HF flicker detection result (hfflickertv may be set). */
  hfResult: boolean;
  values: Record<string, unknown>;
}

export interface SettingDef {
  /** Name in the bulk list and in events, e.g. "picturestyle_auto". */
  key: string;
  /** Path after shooting/settings/, e.g. "picturestyle/auto". */
  path: string;
  ver: "ver100" | "ver110";
  kind: "list" | "range" | "object";
  def: unknown;
  /** still: 503 in movie mode; movie: 503 outside it. */
  scope: "still" | "movie" | "any";
  /** Listed in the bulk GET (a few newer items are only reachable one by one). */
  bulk: boolean;
  /** DELETE resets to the default. */
  del: boolean;
  /** GET answers without an ability list. */
  noAbility: boolean;
  /** PUT answers {} instead of echoing the value. */
  quietPut: boolean;
  ability(c: SettingsContext): Ability;
  /** False when the current state doesn't let you change it (reported emptied). */
  available(c: SettingsContext): boolean;
  /** A 503 message for GET and PUT, beyond the movie/still scope. */
  refuse(c: SettingsContext): string | null;
  /** A 503 message for PUT only. */
  refusePut(c: SettingsContext): string | null;
  /** Extra check on a value that fits the ability. */
  check(v: unknown, c: SettingsContext): boolean;
}

const ENABLE = ["enable", "disable"];
const range = (min: number, max: number, step = 1): Range => ({ min, max, step });

export const MODES = ["p", "av", "tv", "m", "bulb", "a+"];
export const AF_METHODS = [
  "face+tracking", "spot", "1point", "expand_cross", "expand_around", "zone", "large_zone_vertical", "large_zone_horizontal",
  "flexible_zone_1", "flexible_zone_2", "flexible_zone_3", "whole_area",
];
export const WB_VALUES = ["auto", "awbwhite", "daylight", "shade", "cloudy", "tungsten", "whitefluorescent", "flash", "custom", "colortemp", "colortemp2", "colortemp3", "colortemp4"];
export const DRIVES = ["single", "cont_super_hi", "highspeed", "lowspeed", "self_10sec", "self_2sec", "self_continuous"];
export const STYLES = ["auto", "standard", "portrait", "landscape", "finedetail", "neutral", "faithful", "monochrome"];
export const USER_STYLES = ["userdef1", "userdef2", "userdef3"];
export const JPEG_SIZES = ["large", "medium1", "medium2", "small"];
export const MICS = ["intmic", "extmic", "acc"];

/** Detail parameters a picture style starts with. */
export function styleDefaults(style: string): Record<string, number | string> {
  const sharp: Record<string, [number, number, number]> = {
    portrait: [2, 2, 4], landscape: [5, 2, 4], finedetail: [4, 1, 1], neutral: [0, 2, 2], faithful: [0, 2, 2],
  };
  const [s, f, t] = sharp[style] ?? [4, 2, 4];
  const base = { sharpness_strength: s, sharpness_fineness: f, sharpness_threshold: t, contrast: 0 };
  return style === "monochrome" ? { ...base, filtereffect: "none", toningeffect: "none" } : { ...base, saturation: 0, colortone: 0 };
}

function styleAbility(mono: boolean): Record<string, FieldAbility> {
  const out: Record<string, FieldAbility> = {
    sharpness_strength: range(0, 7),
    sharpness_fineness: range(1, 5),
    sharpness_threshold: range(1, 5),
    contrast: range(-4, 4),
  };
  if (mono) {
    out.filtereffect = ["none", "yellow", "orange", "red", "green"];
    out.toningeffect = ["none", "sepia", "blue", "purple", "green"];
  } else {
    out.saturation = range(-4, 4);
    out.colortone = range(-4, 4);
  }
  return out;
}

/**
 * Shutter speeds offered with high-frequency anti-flicker: 1/50 s to 1/8192 s
 * in steps of 1/96 stop (under 1 % apart), so an exposure can be matched to
 * the period of an LED's flicker closely enough that no bands remain. Ordered
 * slow to fast, like the normal shutter speed scale; the round mains values
 * are included too.
 */
export const HF_TV: string[] = (() => {
  const denoms = new Set<string>(["50.0", "60.0", "100.0", "120.0", "200.0", "240.0"]);
  for (let k = 0; ; k++) {
    const d = 50 * 2 ** (k / 96);
    if (d > 8192.05) break;
    denoms.add(d.toFixed(1));
  }
  return [...denoms].sort((a, b) => Number(a) - Number(b)).map((d) => `1/${d}`);
})();

const autoLike = (c: SettingsContext) => c.mode === "a+";
const never = () => null;

function def(d: Pick<SettingDef, "path" | "ver" | "kind" | "def"> & Partial<SettingDef>): SettingDef {
  return {
    key: d.path.replace(/\//g, "_"),
    scope: "still",
    bulk: true,
    del: false,
    noAbility: false,
    quietPut: false,
    ability: () => [],
    available: () => true,
    refuse: never,
    refusePut: never,
    check: () => true,
    ...d,
  };
}

const list = (path: string, ver: SettingDef["ver"], dflt: string, values: string[] | ((c: SettingsContext) => string[]), more: Partial<SettingDef> = {}) =>
  def({ path, ver, kind: "list", def: dflt, ability: typeof values === "function" ? values : () => values, ...more });

const ranged = (path: string, ver: SettingDef["ver"], dflt: number, r: Range, more: Partial<SettingDef> = {}) =>
  def({ path, ver, kind: "range", def: dflt, ability: () => r, ...more });

const soundOn = (c: SettingsContext) => (c.values.soundrecording === "enable" ? null : "Mode not supported");

export const SETTINGS: SettingDef[] = [
  // Exposure
  list("av", "ver100", "f5.6", (c) => c.lensAv, { available: (c) => ["av", "m", "bulb"].includes(c.mode) }),
  list("tv", "ver100", "1/125", TV_SCALE, { available: (c) => c.mode === "tv" || c.mode === "m" }),
  list("iso", "ver100", "auto", ["auto", ...ISO_SCALE], { available: (c) => !autoLike(c) }),
  list("exposure", "ver100", "+0.0", EXPOSURE_SCALE, {
    scope: "any",
    available: (c) => ["p", "av", "tv"].includes(c.mode) || (c.mode === "m" && c.values.iso === "auto"),
  }),
  list("metering", "ver100", "evaluative", ["evaluative", "partial", "spot", "center_weighted_average"], { available: (c) => !autoLike(c) }),
  list("aeb", "ver100", "+0.0", EXPOSURE_SCALE.slice(EXPOSURE_SCALE.indexOf("+0.0")), { available: (c) => ["p", "av", "tv", "m"].includes(c.mode) }),

  // White balance
  list("wb", "ver100", "auto", WB_VALUES, { scope: "any", available: (c) => !autoLike(c) }),
  ...["colortemperature", "colortemperature2", "colortemperature3", "colortemperature4"].map((p) =>
    ranged(p, "ver100", 5200, range(2500, 10000, 100), { bulk: p === "colortemperature", available: (c) => !autoLike(c) }),
  ),
  def({
    path: "wbshift", ver: "ver100", kind: "object", def: { ba: 0, mg: 0 }, scope: "any",
    ability: () => ({ ba: range(-9, 9), mg: range(-9, 9) }),
    available: (c) => !autoLike(c),
  }),
  list("wbbracket", "ver100", "0", ["0", "ba1", "ba2", "ba3", "mg1", "mg2", "mg3"], {
    // WB bracketing writes several JPEGs from one exposure, so not with RAW.
    available: (c) => !autoLike(c) && (c.values.stillimagequality as { raw?: string } | undefined)?.raw === "none",
  }),

  // Focus
  list("afoperation", "ver100", "oneshot", ["oneshot", "servo", "aifocus", "manual"], { scope: "any" }),
  list("afmethod", "ver100", "face+tracking", AF_METHODS, { scope: "any" }),
  list("trackingsetting", "ver110", "enable", ENABLE, { scope: "any" }),

  // Capture
  list("shuttermode", "ver110", "elec_1st_curtain", ["mechanical", "elec_1st_curtain", "electronic"]),
  list("drive", "ver100", "single", DRIVES),
  list("flash", "ver100", "off", ["auto", "on", "slowsynchro", "off"], {
    // A flash can't sync with the fully electronic shutter.
    available: (c) => c.values.shuttermode !== "electronic",
  }),
  list("stillimageaspectratio", "ver100", "3:2", ["3:2", "4:3", "16:9", "1:1", "x1.6"]),
  def({
    path: "stillimagequality", ver: "ver110", kind: "object", def: { raw: "none", jpeg: "large" },
    ability: () => ({ raw: ["none", "raw", "craw"], jpeg: ["none", ...JPEG_SIZES] }),
    check: (v) => (v as { raw: string; jpeg: string }).raw !== "none" || (v as { jpeg: string }).jpeg !== "none",
  }),
  ...JPEG_SIZES.map((s) => ranged(`stillimagecompression/${s}`, "ver110", 8, range(1, 10))),
  // HDR PQ stills are HEIF files, which the simulator can't encode; only "off" is offered.
  list("hdr", "ver110", "off", ["off"]),
  list("colorspace", "ver100", "srgb", ["srgb", "adobe_rgb"], { available: (c) => !autoLike(c) }),
  list("antiflickershoot", "ver110", "disable", ENABLE, {
    // Timing the shot to the light's peak needs a shutter that crosses the
    // frame quickly; the slow electronic readout spans more than a flicker cycle.
    available: (c) => c.values.shuttermode !== "electronic",
  }),
  list("hfantiflickershoot", "ver110", "disable", ENABLE, { refuse: (c) => (c.mode === "m" || c.mode === "tv" ? null : "Mode not supported") }),
  def({
    path: "hfflickertv", ver: "ver110", kind: "list", def: "1/100.0", noAbility: true,
    ability: () => HF_TV,
    refuse: (c) => (c.values.hfantiflickershoot === "enable" ? null : "Mode not supported"),
    refusePut: (c) => (c.hfResult ? null : "Device busy"),
  }),

  // Picture style
  list("picturestyle", "ver100", "auto", [...STYLES, ...USER_STYLES], { available: (c) => !autoLike(c) }),
  ...[...STYLES, ...USER_STYLES].map((style) =>
    def({
      path: `picturestyle/${style}`, ver: "ver100", kind: "object", del: true,
      def: styleDefaults(USER_STYLES.includes(style) ? "auto" : style),
      ability: (c) => {
        if (!USER_STYLES.includes(style)) return styleAbility(style === "monochrome");
        const base = String(c.values[`picturestyle_${style}_basepicturestyle`]);
        // The base is changed on its own endpoint; here it is read-only.
        return { basepicturestyle: [], ...styleAbility(base === "monochrome") };
      },
    }),
  ),
  ...USER_STYLES.map((style) => list(`picturestyle/${style}/basepicturestyle`, "ver100", "auto", STYLES)),

  // Focus bracketing
  list("focusbracketing", "ver100", "disable", ENABLE, { bulk: false }),
  ranged("focusbracketing/numberofshots", "ver100", 10, range(2, 999), { bulk: false }),
  ranged("focusbracketing/focusincrement", "ver100", 4, range(1, 10), { bulk: false }),
  list("focusbracketing/exposuresmoothing", "ver100", "disable", ENABLE, { bulk: false }),
  list("focusbracketing/depthcomposite", "ver100", "disable", ENABLE, { bulk: false }),
  list("focusbracketing/cropdepthcomp", "ver100", "disable", ENABLE, {
    bulk: false,
    refusePut: (c) => (c.values.focusbracketing_depthcomposite === "enable" ? null : "Mode not supported"),
  }),

  // Live view magnification (moves with afframeposition)
  list("lvzoom", "ver110", "1", ["1", "5", "10"], { bulk: false, quietPut: true }),

  // Movie
  list("shootingmodedial/movie", "ver100", "auto", ["auto", "manual"], {
    scope: "movie",
    // Like the mode dial, software may only override it in ignore-dial mode.
    refusePut: (c) => (c.ignoreDial ? null : "Mode not supported"),
  }),
  list("moviequality", "ver100", "1920x1080_2997_ipb_standard", ["3840x2160_2997_ipb_standard", "1920x1080_5994_ipb_standard", "1920x1080_2997_ipb_standard", "1920x1080_2997_ipb_light"], { scope: "movie" }),
  // Only meaningful in slow & fast motion, which this body doesn't simulate.
  list("moviequality/framerate", "ver100", "100", ["10000", "5000", "2500", "1200", "600", "300", "200", "100"], { scope: "movie", bulk: false, refuse: () => "Mode not supported" }),
  list("highframerate", "ver110", "disable", ENABLE, { scope: "movie" }),
  list("moviecropping", "ver110", "disable", ENABLE, { scope: "movie" }),
  list("soundrecording", "ver110", "enable", ENABLE, { scope: "movie" }),
  ...MICS.map((m) => list(`soundrecording/mode/${m}`, "ver100", "auto", ["auto", "manual"], { scope: "movie", refuse: soundOn })),
  ...MICS.map((m) =>
    ranged(`soundrecording/level/${m}`, "ver100", 40, range(0, 63), {
      scope: "movie",
      refuse: (c) => soundOn(c) ?? (c.values[`soundrecording_mode_${m}`] === "manual" ? null : "Mode not supported"),
    }),
  ),
  ...["intmic", "acc"].map((m) => list(`soundrecording/windfilter/${m}`, "ver100", "disable", ENABLE, { scope: "movie", refuse: soundOn })),
  list("soundrecording/attenuator/acc", "ver100", "disable", ENABLE, { scope: "movie", refuse: soundOn }),

  // Power zoom: no power zoom lens or adapter is attached, so always emptied.
  def({
    path: "powerzoom", ver: "ver100", kind: "object", def: { speed: "slow", level: 7 }, scope: "any", bulk: false,
    ability: () => ({ speed: ["slow", "fast"], level: range(1, 15) }),
    available: () => false,
  }),
];

export const SETTING_BY_PATH = new Map(SETTINGS.map((s) => [s.path, s]));

export function defaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of SETTINGS) out[s.key] = structuredClone(s.def);
  return out;
}

// ------------------------------------------------------------------ reading and validating

const isRange = (a: unknown): a is Range => !!a && typeof a === "object" && !Array.isArray(a) && "min" in a;
const EMPTY_RANGE = { min: null, step: null, max: null };

function emptiedField(a: FieldAbility) {
  return isRange(a) ? { value: null, ability: EMPTY_RANGE } : { value: "", ability: [] };
}

/** The setting as GET reports it: emptied when not changeable now (or when the caller says so). */
export function report(s: SettingDef, c: SettingsContext, empty = !s.available(c)): Record<string, unknown> {
  const ab = s.ability(c);
  const value = USER_STYLES.some((u) => s.key === `picturestyle_${u}`)
    ? { basepicturestyle: c.values[`${s.key}_basepicturestyle`], ...(c.values[s.key] as object) }
    : c.values[s.key];
  if (s.noAbility) return { value: empty ? "" : value };
  if (!empty) return { value, ability: ab };
  if (s.kind === "list") return { value: "", ability: [] };
  if (s.kind === "range") return { value: null, ability: EMPTY_RANGE };
  const fields = Object.entries(ab as Record<string, FieldAbility>).map(([k, a]) => [k, emptiedField(a)] as const);
  return { value: Object.fromEntries(fields.map(([k, f]) => [k, f.value])), ability: Object.fromEntries(fields.map(([k, f]) => [k, f.ability])) };
}

function fits(v: unknown, a: FieldAbility): boolean {
  if (Array.isArray(a)) return typeof v === "string" && a.includes(v);
  return typeof v === "number" && Number.isInteger(v) && v >= a.min && v <= a.max && (v - a.min) % a.step === 0;
}

/** The value to store if `v` is acceptable now, else null (400 Invalid parameter). */
export function validate(s: SettingDef, v: unknown, c: SettingsContext): unknown {
  if (!s.available(c)) return null;
  const ab = s.ability(c);
  let out: unknown = v;
  if (s.kind === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const obj: Record<string, unknown> = {};
    for (const [k, a] of Object.entries(ab as Record<string, FieldAbility>)) {
      if (k === "basepicturestyle") continue; // read-only here
      const fv = (v as Record<string, unknown>)[k];
      if (!fits(fv, a)) return null;
      obj[k] = fv;
    }
    out = obj;
  } else if (!fits(v, ab as FieldAbility)) return null;
  return s.check(out, c) ? out : null;
}
