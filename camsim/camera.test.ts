import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeJpegNode } from "../tools/jpeg-node.ts";
import { loadImageNode } from "../tools/scene-files-node.ts";
import { VirtualCamera } from "./camera.ts";
import { blurCircleMm } from "./render.ts";

const cam = (scene: string) => VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => 0, loadImage: loadImageNode }, scene);
const put = (c: VirtualCamera, name: string, value: unknown) => c.handle({ method: "PUT", path: `/ccapi/ver100/shooting/settings/${name}`, body: { value } });

test("Av with a fixed ISO solves the shutter speed from the meter", async () => {
  const c = await cam("dog");
  const e = c.solve(0);
  assert.equal(e.av, "f8.0");
  // Overcast daylight at f/8, ISO 100: a slow-ish shutter the dog will blur at.
  const t = e.t;
  assert.ok(t >= 1 / 125 && t <= 1 / 30, `expected about 1/60 s, got ${e.tv}`);
});

test("exposure compensation brightens by the same number of stops", async () => {
  const c = await cam("backlit");
  const before = c.solve(0);
  await put(c, "exposure", "+1_2/3");
  const after = c.solve(0);
  const stops = Math.log2((after.t * after.iso) / (after.N * after.N)) - Math.log2((before.t * before.iso) / (before.N * before.N));
  assert.ok(Math.abs(stops - 5 / 3) < 0.4, `expected +1⅔ stops, got ${stops.toFixed(2)}`);
});

test("spot metering on a backlit face exposes brighter than evaluative", async () => {
  const c = await cam("backlit");
  const evaluative = c.solve(0);
  await put(c, "metering", "spot");
  const spot = c.solve(0);
  assert.ok(spot.t > evaluative.t * 1.5, `spot ${spot.tv} vs evaluative ${evaluative.tv}`);
});

test("auto ISO in low light keeps a hand-holdable shutter speed", async () => {
  const c = await cam("dinner");
  await put(c, "iso", "auto");
  await put(c, "av", "f1.8");
  const e = c.solve(0);
  assert.ok(e.t <= 1 / 30, `shutter ${e.tv}`);
  assert.ok(e.iso > 100, `ISO ${e.isoValue}`);
});

test("settings unused by the mode are reported empty and refuse changes", async () => {
  const c = await cam("backlit");
  const tv = await c.handle({ method: "GET", path: "/ccapi/ver100/shooting/settings/tv" });
  assert.deepEqual(tv.json, { value: "", ability: [] });
  const res = await put(c, "tv", "1/1000");
  assert.equal(res.status, 400);
});

test("thin-lens blur grows with aperture and distance from the focus plane", () => {
  const wide = blurCircleMm(85, 1.8, 2.6, 35);
  const stopped = blurCircleMm(85, 8, 2.6, 35);
  assert.ok(wide > stopped * 4);
  assert.equal(blurCircleMm(85, 1.8, 2.6, 2.6), 0);
});
