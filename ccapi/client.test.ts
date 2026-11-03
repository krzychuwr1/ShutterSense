import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualCamera } from "../camsim/camera.ts";
import { simTransport } from "../camsim/transport.ts";
import { encodeJpegNode } from "../tools/jpeg-node.ts";
import { loadImageNode } from "../tools/scene-files-node.ts";
import { CcapiClient, CcapiError, checkValue, parseMultipart, SettingError, type HttpResponse, type Transport } from "./client.ts";

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

test("an empty answer reads as an empty object; a blank error message keeps the status", async () => {
  const answers: Record<string, { status: number; body: string }> = {
    "/ccapi": { status: 200, body: JSON.stringify({ ver100: [{ path: "/ccapi/ver100/deviceinformation", get: true }, { path: "/ccapi/ver100/devicestatus/temperature", get: true }] }) },
    "/ccapi/ver100/deviceinformation": { status: 200, body: "" },
    "/ccapi/ver100/devicestatus/temperature": { status: 503, body: JSON.stringify({ message: "  " }) },
  };
  const fake: Transport = async (_m, path): Promise<HttpResponse> => {
    const bytes = new TextEncoder().encode(answers[path].body);
    return { status: answers[path].status, contentType: "application/json", json: async () => JSON.parse(answers[path].body), bytes: async () => bytes };
  };
  const client = new CcapiClient(fake);
  await client.discover();
  assert.deepEqual(await client.deviceInfo(), {});
  await assert.rejects(client.temperature(), (e: unknown) => e instanceof CcapiError && e.status === 503 && e.message === "HTTP 503");
});

test("multipart streams split on the boundary the content type names", () => {
  const enc = new TextEncoder();
  const body = enc.encode("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n--frame\r\nContent-Length: 2\r\n\r\nde\r\n--frame--\r\n");
  assert.deepEqual(parseMultipart(body, "frame").map((b) => new TextDecoder().decode(b)), ["abc", "de"]);
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
  const { client } = await setup("group");
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
  // Without waiting, a press while the camera writes the last shot fails…
  await assert.rejects(client.shutter(false, 0), (e: unknown) => e instanceof CcapiError && e.status === 503 && e.message === "Device busy");
  // …and by default it waits for the camera and goes through.
  await client.shutter(false);
});

// ------------------------------------------------------------------ the wider API

async function fastSetup(scene = "group") {
  const cam = await VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => 0, loadImage: loadImageNode, delay: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }, scene);
  const client = new CcapiClient(simTransport((r) => cam.handle(r)));
  await client.discover();
  return { cam, client };
}

async function shootAndWait(client: CcapiClient) {
  await client.poll();
  await client.shutter(false);
  return client.waitForNewFile(20_000);
}

test("flipdetail parses into a frame with histogram and AF frames", async () => {
  const { client } = await fastSetup();
  const d = await client.liveDetail("both");
  assert.equal(d.image![0], 0xff);
  const hist = d.info!.liveviewdata!.histogram!;
  assert.equal(hist.length, 4);
  assert.equal(hist[0].length, 256);
  const pixels = hist[0].reduce((a, b) => a + b, 0);
  assert.equal(pixels, 600 * 400);
  assert.ok(d.info!.liveviewdata!.afframe!.length >= 1);
  const frames = await client.liveStream("scrolldetail", "both");
  assert.equal(frames.length, 3);
  assert.ok(frames.every((f) => f.image && f.info));
  assert.equal((await client.liveStream("multipart")).length, 3);
  assert.equal((await client.liveStream("scroll")).length, 3);
});

test("picture style detail and composite settings are validated before sending", async () => {
  const { client } = await fastSetup();
  await assert.rejects(client.setPictureStyleDetail("standard", { sharpness_strength: 9 }), (e: unknown) => e instanceof SettingError && /from 0 to 7/.test(e.message));
  await client.setPictureStyleDetail("standard", { contrast: 2 });
  assert.equal((await client.pictureStyleDetail("standard")).value.contrast, 2);
  assert.equal(((await client.resetSetting("picturestyle_standard")) as Record<string, number>).contrast, 0);
  await assert.rejects(client.setWbShift(12, 0), (e: unknown) => e instanceof SettingError && /wbshift\.ba/.test(e.message));
  await assert.rejects(client.set("wbshift", { ba: 1 }), (e: unknown) => e instanceof SettingError && /mg is missing/.test(e.message));
  await client.setWbShift(-3, 4);
  assert.deepEqual((await client.compositeSetting("wbshift")).value, { ba: -3, mg: 4 });
  await client.setStillImageQuality({ raw: "craw" });
  assert.deepEqual((await client.compositeSetting("stillimagequality")).value, { raw: "craw", jpeg: "large" });
  assert.throws(() => checkValue("stillimagequality", { raw: "huge", jpeg: "large" }, { value: { raw: "none", jpeg: "large" }, ability: { raw: ["none", "raw"], jpeg: ["large"] } }), /Options: none, raw/);
});

test("contents: browse, count, page, chunked list, info, range download, protect and delete", async () => {
  const { client } = await fastSetup();
  const path = await shootAndWait(client);
  const [storage] = await client.storages();
  assert.equal(storage, "/ccapi/ver120/contents/card1");
  const [dir] = await client.directories(storage);
  assert.deepEqual(await client.allFiles(dir), [path]);
  assert.deepEqual(await client.filesChunked(dir, { order: "desc" }), [path]);
  assert.deepEqual(await client.contentsCount(dir), { contentsnumber: 1, pagenumber: 1 });
  const info = await client.fileInfo(path);
  const part = await client.downloadRange(path, 2, 9);
  assert.deepEqual([part.start, part.end, part.total, part.bytes.length], [2, 9, info.filesize, 8]);
  await assert.rejects(client.downloadRange(path, info.filesize + 10), (e: unknown) => e instanceof CcapiError && e.status === 416);
  await client.protectFile(path, true);
  await client.rateFile(path, 4);
  assert.equal((await client.fileInfo(path)).rating, "4");
  await assert.rejects(client.deleteFile(path), (e: unknown) => e instanceof CcapiError && e.status === 409 && e.message === "File protected");
  await assert.rejects(client.deleteDirectory(dir), (e: unknown) => e instanceof CcapiError && e.message === "Partial deletion");
  await sleep(300); // the camera is still writing the file
  await client.formatCard("card1");
  assert.deepEqual(await client.files(dir), []);
  assert.equal((await client.storage())[0].contentsnumber, 0);
});

test("functions, device status and events through the client", async () => {
  const { client } = await fastSetup();
  await client.setDatetime(new Date(Date.UTC(2024, 5, 1, 12, 0, 0)), false, 120);
  assert.match((await client.datetime()).datetime, /^Sat, 01 Jun 2024 14:0\d:\d\d \+0200$/);
  await client.setFunction("beep", "disable");
  await assert.rejects(client.setFunction("beep", "loud"), (e: unknown) => e instanceof SettingError);
  await client.setRegisteredName("author", "Test Author");
  assert.equal(await client.registeredName("author"), "Test Author");
  assert.equal((await client.batteries())[0].position, "camera");
  assert.equal(await client.temperature(), "normal");
  assert.deepEqual(await client.increments(), { av: "1/3", tv: "1/3", exposure: "1/3", flashexposure: "1/3", iso: "1/3" });
  assert.equal((await client.currentDirectory()).name, "100CANON");
  await client.createDirectory("TESTS");
  assert.equal((await client.currentDirectory()).name, "101TESTS");
  assert.equal((await client.recordable()).remainingtime, null);
  // Old-style polling holds with continue=on; immediately returns at once.
  await client.poll("immediately", "ver100");
  await client.setFunction("displayoff", "30");
  const ev = await client.poll("immediately", "ver100");
  assert.deepEqual(ev.displayoff, { value: "30", ability: ["10", "20", "30", "60", "120", "180"] });
  await client.setFunction("autopoweroff", "300");
  const [mon] = await client.monitor();
  assert.ok("autopoweroff" in mon);
  await assert.rejects(client.stopMonitoring(), (e: unknown) => e instanceof CcapiError && e.message === "Not started");
});

test("shooting control: manual focus, AF frame, movie, bursts held on the manual button", async () => {
  const { client, cam } = await fastSetup();
  await client.setAfFramePosition(100, 780);
  await client.set("afmethod", "1point");
  await client.autofocus("start");
  await client.autofocus("stop");
  assert.equal(cam.status().focusOn, "park");
  await client.driveFocus("near3");
  assert.equal(cam.status().focusOn, "manual");
  await client.set("drive", "highspeed");
  await client.poll();
  await client.shutterButton("full_press", false);
  await sleep(150);
  await client.shutterButton("release");
  for (let i = 0; i < 500 && cam.status().busy; i++) await sleep(10);
  assert.ok(cam.status().shots.length >= 1);
  await client.setMovieMode(true);
  assert.equal(await client.movieMode(), true);
  await client.record("start");
  await sleep(250);
  await client.record("stop");
  await client.setMovieMode(false);
  const [dir] = await client.directories((await client.storages())[0]);
  assert.equal((await client.files(dir, { type: "mov" })).length, 1);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("flicker: detection results and the HF anti-flicker shutter speed through the client", async () => {
  const { client } = await setup("concert");
  await client.discover();
  assert.equal(await client.flickerDetection(), "ng"); // LED dimming, not mains ripple
  await client.set("hfantiflickershoot", "enable");
  await client.startLiveView();
  const hf = await client.hfFlickerDetection("start", true);
  assert.equal(hf.result, "ok");
  assert.equal(hf.frequency, "1310.0Hz");
  assert.equal((await client.settings()).hfflickertv.value, hf.tv);
  await client.stepHfFlickerTv("decrement_small");
  assert.notEqual((await client.settings()).hfflickertv.value, hf.tv);

  const gym = await setup("gym");
  await gym.client.discover();
  assert.equal(await gym.client.flickerDetection(), "ok");
});
