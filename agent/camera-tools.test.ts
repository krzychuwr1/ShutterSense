import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualCamera } from "../camsim/camera.ts";
import { simTransport } from "../camsim/transport.ts";
import { encodeJpegNode } from "../tools/jpeg-node.ts";
import { loadImageNode } from "../tools/scene-files-node.ts";
import { CcapiClient } from "../ccapi/client.ts";
import { CameraTools, type ImageTools } from "./camera-tools.ts";

async function setup() {
  const cam = await VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => 0, loadImage: loadImageNode }, "group");
  const images: ImageTools = { prepare: async () => ({ dataUrl: "", w: 0, h: 0, stats: { mean: 0, center: 0, highlights: 0, shadows: 0 } }) };
  const tools = new CameraTools(new CcapiClient(simTransport((r) => cam.handle(r))), images);
  await tools.connect();
  return tools;
}

test("style_detail fine-tunes the picture style chosen in the same call", async () => {
  const tools = await setup();
  const { applied, errors } = await tools.set({ picturestyle: "landscape", style_detail: { saturation: 2 } });
  assert.deepEqual(errors, []);
  assert.ok(applied.includes("Saturation 0 → 2"), applied.join("; "));
  assert.equal((await tools.client.pictureStyleDetail("landscape")).value.saturation, 2);
});

test("malformed values come back as errors, the rest still applies", async () => {
  const tools = await setup();
  const { applied, errors } = await tools.set({ wbshift: "2", metering: { value: "spot" }, drive: "highspeed" });
  assert.deepEqual(errors, ['metering = {"value":"spot"} is not accepted.', "wbshift takes an object with ba and mg."]);
  assert.equal(applied.length, 1);
  assert.equal(tools.settings.drive.value, "highspeed");
});

test("the shutter type is set before the settings that depend on it", async () => {
  const tools = await setup();
  await tools.set({ shuttermode: "electronic" });
  const { errors } = await tools.set({ flash: "on", shuttermode: "mechanical" });
  assert.deepEqual(errors, []);
  assert.equal(tools.settings.flash.value, "on");
});

test("a shot reports the exposure it was taken at, not the one dialled in", async () => {
  const tools = await setup();
  const { errors } = await tools.set({ shootingmode: "tv", tv: "1/1000", flash: "on" });
  assert.deepEqual(errors, []);
  // Flash holds the shutter to the sync speed.
  const shot = await tools.shoot(true, 1);
  assert.match(shot.exposure, /1\/200/, shot.exposure);
});
