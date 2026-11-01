import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualCamera } from "../camsim/camera.ts";
import { simTransport } from "../camsim/transport.ts";
import { encodeJpegNode } from "../tools/jpeg-node.ts";
import { loadImageNode } from "../tools/scene-files-node.ts";
import { CcapiClient, CcapiError, checkValue, SettingError, type HttpResponse, type Transport } from "./client.ts";

async function setup(scene = "dog") {
  let now = 0;
  const cam = await VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => now, loadImage: loadImageNode }, scene);
  const client = new CcapiClient(simTransport((r) => cam.handle(r)));
  return { cam, client, advance: (ms: number) => (now += ms) };
}

test("discovery routes each endpoint to its highest version", async () => {
  const { client } = await setup();
  await client.discover();
  assert.equal(client.endpoint("event/polling"), "/ccapi/ver110/event/polling");
  assert.equal(client.endpoint("shooting/settings/av", "put"), "/ccapi/ver100/shooting/settings/av");
  assert.equal(client.endpoint("shooting/settings/shootingmode", "put"), "/ccapi/ver110/shooting/settings/shootingmode");
  assert.equal(client.endpoint("contents"), "/ccapi/ver120/contents");
});

test("discovery accepts the older absolute-URL form and the activation-free fallback", async () => {
  const fake: Transport = async (_m, path): Promise<HttpResponse> => {
    const body =
      path === "/ccapi"
        ? { status: 404, json: { message: "URL not found" } }
        : { status: 200, json: { ver100: [{ url: "http://192.168.1.2:8080/ccapi/ver100/shooting/settings/av", get: true, put: true, post: false, delete: false }] } };
    const bytes = new TextEncoder().encode(JSON.stringify(body.json));
    return { status: body.status, contentType: "application/json", json: async () => body.json, bytes: async () => bytes };
  };
  const client = new CcapiClient(fake);
  await client.discover();
  assert.equal(client.endpoint("shooting/settings/av", "put"), "/ccapi/ver100/shooting/settings/av");
});

test("settings follow the mode: shutter speed is camera-chosen in Av", async () => {
  const { client } = await setup();
  await client.discover();
  const s = await client.settings();
  assert.equal(s.shootingmode.value, "av");
  assert.equal(s.tv.value, "");
  assert.deepEqual(s.tv.ability, []);
  assert.ok(Array.isArray(s.av.ability) && s.av.ability.includes("f2.8"));
});

test("invalid values are rejected with the options", async () => {
  const { client } = await setup();
  await client.discover();
  await assert.rejects(client.set("av", "f1.4"), (e: unknown) => e instanceof SettingError && /Options: f2.8/.test(e.message));
  await assert.rejects(client.set("tv", "1/1000"), (e: unknown) => e instanceof SettingError && /current shooting mode/.test(e.message));
  assert.throws(() => checkValue("colortemperature", 3150, { value: 5200, ability: { min: 2500, max: 10000, step: 100 } }), /steps of 100/);
});

test("changing the mode switches on ignore-dial mode when the dial is physical", async () => {
  const { client } = await setup();
  await client.discover();
  await client.setMode("tv");
  await client.set("tv", "1/1000");
  const s = await client.settings();
  assert.equal(s.shootingmode.value, "tv");
  assert.equal(s.tv.value, "1/1000");
  assert.equal(s.av.value, "");
});

test("shoot, wait for the file in event polling, download it", async () => {
  const { client } = await setup("backlit");
  await client.discover();
  await client.poll(); // first poll returns the full state
  await client.shutter(true);
  const effective: Record<string, unknown>[] = [];
  const path = await client.waitForNewFile(10_000, (e) => effective.push(e));
  assert.match(path, /^\/ccapi\/ver120\/contents\/card1\/100CANON\/IMG_0001\.JPG$/);
  assert.ok(effective.some((e) => "effective_value_tv" in e));
  const jpeg = await client.download(path);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
});

test("live view must be started; the client starts it", async () => {
  const { client } = await setup();
  await client.discover();
  const frame = await client.liveFrame();
  assert.equal(frame[0], 0xff);
});

test("camera errors surface status and message", async () => {
  const { client } = await setup();
  await client.discover();
  await client.shutter(false);
  await assert.rejects(client.shutter(false), (e: unknown) => e instanceof CcapiError && e.status === 503 && e.message === "Device busy");
});
