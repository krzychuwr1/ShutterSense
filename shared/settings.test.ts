import assert from "node:assert/strict";
import { test } from "node:test";
import { avNumber, diffLine, EXPOSURE_SCALE, evStops, prettyValue, tvSeconds } from "./settings.ts";

test("CCAPI value formats parse", () => {
  assert.equal(tvSeconds("1/125"), 1 / 125);
  assert.equal(tvSeconds('0"5'), 0.5);
  assert.equal(tvSeconds('1"3'), 1.3);
  assert.equal(tvSeconds('30"'), 30);
  assert.equal(avNumber("f5.6"), 5.6);
  assert.equal(avNumber("f22"), 22);
  assert.equal(evStops("+1_1/3"), 4 / 3);
  assert.equal(evStops("-0_2/3"), -2 / 3);
  assert.equal(evStops("+0.0"), 0);
});

test("values read like a photographer writes them", () => {
  assert.equal(prettyValue("exposure", "+1_2/3"), "+1⅔ EV");
  assert.equal(prettyValue("exposure", "-0_1/3"), "-⅓ EV");
  assert.equal(prettyValue("exposure", "+0.0"), "±0 EV");
  assert.equal(prettyValue("tv", '0"5'), "0.5 s");
  assert.equal(diffLine("iso", "3200", "800"), "ISO 3200 → 800");
  assert.equal(diffLine("av", "f5.6", "f2.8"), "Aperture f/5.6 → f/2.8");
});

test("exposure compensation scale runs -3 to +3 in thirds", () => {
  assert.equal(EXPOSURE_SCALE.length, 19);
  assert.equal(EXPOSURE_SCALE[0], "-3.0");
  assert.equal(EXPOSURE_SCALE[9], "+0.0");
  assert.equal(EXPOSURE_SCALE[18], "+3.0");
});
