// CCAPI setting values: parsing, formatting for people, and the standard
// third-stop scales. Shared by the TypeScript client, the simulator and the
// web app; the Android app mirrors these rules in Kotlin (CameraValues.kt).
//
// Formats used by the camera:
//   tv        "1/125", 0"5 (0.5 s), 1"3 (1.3 s), 30" (30 s)
//   av        "f2.8", "f5.6", "f11", "f22"
//   iso       "auto", "100", "6400"
//   exposure  "+0.0", "+1_1/3", "-0_2/3", "+2.0"

/** Shutter speed in seconds, or null if not a shutter speed. */
export function tvSeconds(v: string): number | null {
  const s = v.trim();
  let m = s.match(/^1\/(\d+(?:\.\d+)?)$/);
  if (m) return 1 / Number(m[1]);
  m = s.match(/^(\d+)"(\d*)$/);
  if (m) return Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0);
  return null;
}

/** f-number, or null. */
export function avNumber(v: string): number | null {
  const m = v.trim().match(/^f(\d+(?:\.\d+)?)$/i);
  return m ? Number(m[1]) : null;
}

/** ISO number, or null for "auto" and anything else. */
export function isoNumber(v: string): number | null {
  const m = v.trim().match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Exposure compensation in stops, or null. */
export function evStops(v: string): number | null {
  const s = v.trim();
  let m = s.match(/^([+-]?)(\d+)\.(\d+)$/);
  if (m) return (m[1] === "-" ? -1 : 1) * Number(`${m[2]}.${m[3]}`);
  m = s.match(/^([+-]?)(\d+)_(\d)\/(\d)$/);
  if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3]) / Number(m[4]));
  return null;
}

const FRACTIONS: Record<string, string> = { "1/3": "⅓", "2/3": "⅔", "1/2": "½" };

/** A setting value as a photographer would write it: "f/2.8", "1/1000 s", "0.5 s", "+1⅔ EV", "ISO 800". */
export function prettyValue(setting: string, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  const s = String(v);
  switch (setting) {
    case "av": {
      const n = avNumber(s);
      return n === null ? s : `f/${n}`;
    }
    case "tv": {
      if (/^1\//.test(s)) return `${s} s`;
      const t = tvSeconds(s);
      return t === null ? s : `${t} s`;
    }
    case "iso":
      return s === "auto" ? "ISO auto" : `ISO ${s}`;
    case "exposure": {
      const m = s.match(/^([+-]?)(\d+)(?:\.0|_(\d\/\d))$/);
      if (!m) return s;
      const whole = m[2] === "0" && m[3] ? "" : m[2];
      const frac = m[3] ? FRACTIONS[m[3]] ?? `_${m[3]}` : "";
      if (whole === "0" && !frac) return "±0 EV";
      return `${m[1] || "+"}${whole}${frac} EV`;
    }
    case "colortemperature":
      return `${s} K`;
    case "shootingmode":
    case "shootingmodedial":
      return MODE_NAMES[s] ?? s;
    default:
      return s;
  }
}

const MODE_NAMES: Record<string, string> = { m: "M", av: "Av", tv: "Tv", p: "P", fv: "Fv", "a+": "A+", auto: "Auto", bulb: "Bulb" };

/** Short labels for the settings diff: "Tv 1/60 s → 1/1000 s". */
export const SETTING_LABELS: Record<string, string> = {
  shootingmode: "Mode",
  shootingmodedial: "Mode",
  av: "Aperture",
  tv: "Shutter",
  iso: "ISO",
  exposure: "Exp. comp.",
  wb: "WB",
  colortemperature: "Colour temp.",
  metering: "Metering",
  afoperation: "AF",
  afmethod: "AF area",
  drive: "Drive",
  picturestyle: "Picture style",
  flash: "Flash",
  shuttermode: "Shutter type",
  trackingsetting: "Tracking",
  stillimageaspectratio: "Aspect ratio",
  wbshift: "WB shift",
  antiflickershoot: "Anti-flicker",
  hfantiflickershoot: "HF anti-flicker",
  hfflickertv: "HF flicker shutter",
  contrast: "Contrast",
  saturation: "Saturation",
  sharpness_strength: "Sharpness",
  colortone: "Colour tone",
};

export function diffLine(setting: string, from: unknown, to: unknown): string {
  const label = SETTING_LABELS[setting] ?? setting;
  const p = (v: unknown) => {
    // Composite values such as the WB shift: "BA +2 MG 0".
    if (v && typeof v === "object") return Object.entries(v).map(([k, n]) => `${k.toUpperCase()} ${typeof n === "number" && n > 0 ? "+" : ""}${n}`).join(" ");
    return setting === "iso" ? String(v ?? "–") : prettyValue(setting, v as string);
  };
  return `${label} ${p(from)} → ${p(to)}`;
}

// ------------------------------------------------------------------ standard scales (third stops)

export const TV_SCALE = [
  '30"', '25"', '20"', '15"', '13"', '10"', '8"', '6"', '5"', '4"', '3"2', '2"5', '2"', '1"6', '1"3', '1"', '0"8', '0"6', '0"5', '0"4', '0"3',
  "1/4", "1/5", "1/6", "1/8", "1/10", "1/13", "1/15", "1/20", "1/25", "1/30", "1/40", "1/50", "1/60", "1/80", "1/100", "1/125", "1/160",
  "1/200", "1/250", "1/320", "1/400", "1/500", "1/640", "1/800", "1/1000", "1/1250", "1/1600", "1/2000", "1/2500", "1/3200", "1/4000",
  "1/5000", "1/6400", "1/8000",
];

export const AV_SCALE = [
  "f1.0", "f1.1", "f1.2", "f1.4", "f1.6", "f1.8", "f2.0", "f2.2", "f2.5", "f2.8", "f3.2", "f3.5", "f4.0", "f4.5", "f5.0", "f5.6", "f6.3",
  "f7.1", "f8.0", "f9.0", "f10", "f11", "f13", "f14", "f16", "f18", "f20", "f22", "f25", "f29", "f32",
];

export const ISO_SCALE = [
  "100", "125", "160", "200", "250", "320", "400", "500", "640", "800", "1000", "1250", "1600", "2000", "2500", "3200", "4000", "5000",
  "6400", "8000", "10000", "12800", "16000", "20000", "25600",
];

export const EXPOSURE_SCALE = (() => {
  const out: string[] = [];
  for (let thirds = -9; thirds <= 9; thirds++) {
    const sign = thirds < 0 ? "-" : "+";
    const a = Math.abs(thirds);
    const whole = Math.floor(a / 3);
    const rest = a % 3;
    out.push(rest ? `${sign}${whole}_${rest}/3` : `${sign}${whole}.0`);
  }
  return out;
})();

/** The entry of `scale` nearest to `value` on a log scale, using `parse` to read entries. */
export function nearest(scale: string[], value: number, parse: (v: string) => number | null): string {
  let best = scale[0];
  let bestD = Infinity;
  for (const s of scale) {
    const n = parse(s);
    if (n === null || n <= 0) continue;
    const d = Math.abs(Math.log2(n) - Math.log2(value));
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
