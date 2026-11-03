// Flickering light. Many artificial lights don't shine steadily:
//
// - Fluorescent tubes (and cheap LED bulbs) on AC mains brighten and dim
//   twice per mains cycle: a 100 Hz ripple on 50 Hz mains, 120 Hz on 60 Hz.
//   The phosphors that make the colours don't all glow on for the same time,
//   so the ripple is deeper in some channels than others and the colour of
//   the light shifts a little through the cycle as well.
// - LED fixtures dimmed by pulse-width modulation are switched fully on and
//   off hundreds or thousands of times a second; the duty cycle (fraction of
//   each cycle the LED is on) sets the brightness.
//
// To the eye both are steady. A camera sees them when the exposure is
// shorter than (or not a whole number of) the light's period: what a pixel
// collects depends on where in the cycle its exposure falls. A focal-plane
// shutter (mechanical, or the electronic first curtain) is a slit that
// sweeps down the sensor in a few milliseconds; a fully electronic shutter
// reads the rows out one after another over a much longer time. Either way
// each row's exposure starts a little later than the row above, so the
// frame samples the light at different moments: dark and bright bands, many
// and narrow with the slow electronic readout, a gentle gradient with the
// fast mechanical slit. And since the shot starts at an arbitrary point in
// the cycle, two shots in a row come out differently bright (and tinted).
//
// The fixes, all modelled here: an exposure lasting a whole number of
// periods collects the same light whenever it starts (1/100 s or 1/50 s
// under 100 Hz tubes); the camera's anti-flicker mode measures the mains
// ripple and times the shutter so every frame is centred on the light's
// peak; high-frequency anti-flicker offers shutter speeds in fine steps, so
// the exposure can be matched to an LED's period at speeds the normal scale
// never hits.

import type { RGB } from "./paint.ts";

export interface Flicker {
  /** What it is, for the detection result and logs, e.g. "fluorescent tubes". */
  name: string;
  /** "mains": a smooth ripple; "pwm": an LED switched on and off. */
  kind: "mains" | "pwm";
  /** How many times a second the light output repeats (100 or 120 for mains tubes). */
  hz: number;
  /** mains: ripple depth per channel, as a fraction of the mean (0 = steady, 1 = goes dark). */
  depth?: RGB;
  /** pwm: fraction of each cycle the LED is on. */
  duty?: number;
  /** pwm: light left while "off", as a fraction of the on level (0 = fully off). */
  floor?: number;
}

/** Mains-frequency flicker is what the ordinary anti-flicker mode handles. */
export const isMains = (l: Flicker) => l.kind === "mains";

/** Light the layer collected between `a` and `a + t` seconds, relative to the light's long-run mean (1 = mean). */
export function windowGain(l: Flicker, a: number, t: number): RGB {
  if (t <= 0) return [1, 1, 1];
  const w = 2 * Math.PI * l.hz;
  if (l.kind === "mains") {
    // Output 1 + m·cos(ωs): its mean over the window has a closed form.
    const avg = (Math.sin(w * (a + t)) - Math.sin(w * a)) / (w * t);
    const d = l.depth ?? [0.3, 0.3, 0.3];
    return [1 + d[0] * avg, 1 + d[1] * avg, 1 + d[2] * avg];
  }
  const duty = l.duty ?? 0.5;
  const floor = l.floor ?? 0;
  const period = 1 / l.hz;
  // Time the LED has been on since s = 0 (each cycle starts with the on pulse).
  const onSince = (s: number) => {
    const n = Math.floor(s / period);
    return n * duty * period + Math.min(s - n * period, duty * period);
  };
  const on = onSince(a + t) - onSince(a);
  const level = 1 / (duty + (1 - duty) * floor); // the on level that makes the mean 1
  const g = (level * (floor * t + (1 - floor) * on)) / t;
  return [g, g, g];
}

/** When the light is brightest, in its own timeline (seconds within the first period). */
export function peakTime(l: Flicker): number {
  return l.kind === "mains" ? 0 : ((l.duty ?? 0.5) / l.hz) / 2;
}

/**
 * How the shutter samples flickering light. Row y (of `rows`) starts its
 * exposure at start(light) + travel·(y + ½)/rows and is exposed for t.
 */
export interface ShutterTiming {
  /** Seconds the shutter (slit or readout) takes to cross the frame. */
  travel: number;
  /** When the first row starts, in each light's own timeline. */
  start(l: Flicker): number;
}

/** Per-row gains (3 per row) for a light. */
export function rowGains(l: Flicker, timing: ShutterTiming, t: number, rows: number): Float32Array {
  const out = new Float32Array(rows * 3);
  const s0 = timing.start(l);
  for (let y = 0; y < rows; y++) {
    const g = windowGain(l, s0 + (timing.travel * (y + 0.5)) / rows, t);
    out[y * 3] = g[0];
    out[y * 3 + 1] = g[1];
    out[y * 3 + 2] = g[2];
  }
  return out;
}

/** The start that centres the middle row's exposure on the light's peak (what anti-flicker shooting does). */
export function peakStart(l: Flicker, travel: number, t: number): number {
  return peakTime(l) - travel / 2 - t / 2;
}

/** The exposure time closest to `t` that lasts a whole number of the light's periods. */
export function matchingTime(l: Flicker, t: number): number {
  return Math.max(1, Math.round(t * l.hz)) / l.hz;
}
