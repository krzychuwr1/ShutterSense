// The agent's lines as the glasses should say them. Text to speech reads
// "1/1307.1 s" digit by digit and "f/2.8" as "f slash two point eight"; a
// photographer would say "about a thirteen-hundredth of a second" and "f 2.8".

import { TV_SCALE } from "./settings.ts";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number in words, the way shutter speeds are said ("thirteen hundred", not "one thousand three hundred"). */
function words(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n > 1000 && n < 10_000 && n % 100 === 0 && n % 1000 !== 0) return `${words(n / 100)} hundred`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
  return `${words(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${words(n % 1000)}` : ""}`;
}

const IRREGULAR: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

const ordinal = (w: string) => w.replace(/[a-z]+$/, (last) => IRREGULAR[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`));

/** "1/1000" as "a thousandth of a second"; off-scale speeds (high-frequency anti-flicker) rounded, with "about". */
function shutter(denominator: string): string {
  const d = Number(denominator);
  if (d === 2) return "half a second";
  if (d === 4) return "a quarter of a second";
  const step = TV_SCALE.includes(`1/${denominator}`) || d < 100 ? 1 : d < 1000 ? 10 : 100;
  const n = Math.max(1, Math.round(d / step) * step);
  const w = ordinal(words(n)).replace(/^one /, "");
  return `${n !== d ? "about " : ""}${/^(eight|eleven|eighteen|eighty)/.test(w) ? "an" : "a"} ${w} of a second`;
}

const FRACTION: Record<string, string> = { "⅓": "a third", "⅔": "two thirds" };
const SIGN: Record<string, string> = { "+": "plus ", "-": "minus ", "−": "minus ", "±": "" };

/** `text` ready for text to speech: units, fractions and symbols in words. */
export function speakable(text: string): string {
  return (
    text
      // Shutter speeds: "1/1000 s", "Tv 1/1600", "shutter 1/1307.1".
      .replace(/\b1\/(\d+(?:\.\d+)?)\s?(?:s|sec|seconds?)\b/g, (_, d) => shutter(d))
      .replace(/\b(Tv|shutter(?: speed)?)\s+1\/(\d+(?:\.\d+)?)\b/gi, (_, w, d) => `${w} ${shutter(d)}`)
      // The camera's own notation for long exposures: 0"5, 30".
      .replace(/\b(\d+)"(\d)/g, "$1.$2 seconds")
      .replace(/\b(\d+)"/g, "$1 seconds")
      .replace(/\b1\s?s\b/g, "1 second")
      .replace(/\b(\d+(?:\.\d+)?)\s?s\b/g, "$1 seconds")
      // Apertures: "f/2.8", "f2.8".
      .replace(/\bf\/?(\d+(?:\.\d+)?)\b/g, "f $1")
      // Exposure compensation: "+1⅔ EV", "-⅓ EV", "±0 EV".
      .replace(/([+\-−±]?)(\d*)([⅓⅔]?)\s?EV\b/g, (m, sign: string, whole: string, frac: string) => {
        if (!whole && !frac) return m;
        const amount = whole && frac ? `${whole} and ${FRACTION[frac]}` : whole || FRACTION[frac];
        return `${whole === "0" && !frac ? "" : SIGN[sign] ?? ""}${amount} E V`;
      })
      .replace(/\bHz\b/g, "hertz")
      .replace(/\b(\d+)\s?K\b/g, "$1 kelvin")
      .replace(/\s*→\s*/g, " to ")
      .replace(/\s*[·|]\s*/g, ", ")
      // Ticks, dots and other symbols are for the eye.
      .replace(/[^\p{L}\p{N}\p{P}\s+%]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
