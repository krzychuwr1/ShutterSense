import assert from "node:assert/strict";
import { test } from "node:test";
import { speakable } from "./speech.ts";

test("shutter speeds are said, not spelled", () => {
  assert.equal(speakable("Anti-flicker off, back to 1/1307.1 s"), "Anti-flicker off, back to about a thirteen hundredth of a second");
  assert.equal(speakable("Shutter 1/250 s → 1/1000 s"), "Shutter a two hundred fiftieth of a second to a thousandth of a second");
  assert.equal(speakable("Tv 1/1600: dog frozen"), "Tv a sixteen hundredth of a second: dog frozen");
  assert.equal(speakable("1/8000s"), "an eight thousandth of a second");
  assert.equal(speakable("1/125 s"), "a hundred twenty-fifth of a second");
  assert.equal(speakable("1/60 s"), "a sixtieth of a second");
  assert.equal(speakable("1/2 s"), "half a second");
  assert.equal(speakable('0"5 and 30"'), "0.5 seconds and 30 seconds");
  assert.equal(speakable("1 s, 2.5 s"), "1 second, 2.5 seconds");
});

test("the rest of an exposure reads naturally", () => {
  assert.equal(speakable("Av · f/2.8 · ISO 400"), "Av, f 2.8, ISO 400");
  assert.equal(speakable("+1⅔ EV, -⅓ EV, ±0 EV"), "plus 1 and two thirds E V, minus a third E V, 0 E V");
  assert.equal(speakable("HF flicker at 1310 Hz, WB 3200 K"), "HF flicker at 1310 hertz, WB 3200 kelvin");
  assert.equal(speakable("✓ Done. 5 shots, 1/3 stop darker"), "Done. 5 shots, 1/3 stop darker");
});
