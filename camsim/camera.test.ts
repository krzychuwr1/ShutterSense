import assert from "node:assert/strict";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { encodeJpegNode } from "../tools/jpeg-node.ts";
import { loadImageNode } from "../tools/scene-files-node.ts";
import { VirtualCamera } from "./camera.ts";
import { Card } from "./card.ts";
import { handleSim } from "./control.ts";
import { blurCircleMm } from "./render.ts";

/** Real-time waits (self-timer, burst cadence) shortened so tests run quickly. */
const fast = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
const cam = (scene: string) => VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => 0, loadImage: loadImageNode, delay: fast }, scene);
const put = (c: VirtualCamera, name: string, value: unknown, ver = "ver100") => c.handle({ method: "PUT", path: `/ccapi/${ver}/shooting/settings/${name}`, body: { value } });
const post = (c: VirtualCamera, path: string, body: unknown) => c.handle({ method: "POST", path: `/ccapi/${path}`, body });
const get = (c: VirtualCamera, path: string, headers?: Record<string, string>) => c.handle({ method: "GET", path, headers });

async function idle(c: VirtualCamera) {
  for (let i = 0; i < 2000 && c.status().busy; i++) await new Promise((r) => setTimeout(r, 10));
}

/** Presses the shutter and waits until the files are written; returns the new shot records. */
async function shoot(c: VirtualCamera, af = false) {
  const before = c.status().shots.length;
  const res = await post(c, "ver100/shooting/control/shutterbutton", { af });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await new Promise((r) => setTimeout(r, 20));
  await idle(c);
  return c.status().shots.slice(before);
}

async function setMode(c: VirtualCamera, mode: string) {
  await post(c, "ver100/shooting/control/ignoreshootingmodedialmode", { action: "on" });
  assert.equal((await put(c, "shootingmode", mode, "ver110")).status, 200);
}

function decode(bytes: Uint8Array) {
  return jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
}

/** Mean luminance (0..255) of a normalised box of a JPEG. */
function meanLum(bytes: Uint8Array, box: [number, number, number, number]) {
  const img = decode(bytes);
  let sum = 0, n = 0;
  for (let y = Math.floor(box[1] * img.height); y < box[3] * img.height; y++) {
    for (let x = Math.floor(box[0] * img.width); x < box[2] * img.width; x++) {
      const i = (y * img.width + x) * 4;
      sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      n++;
    }
  }
  return sum / n;
}

const fileBytes = async (c: VirtualCamera, path: string, kind = "main") => (await get(c, `${path}?kind=${kind}`)).bytes!;

test("Av with a fixed ISO solves the shutter speed from the meter", async () => {
  const c = await cam("dog");
  const e = c.solve(0);
  assert.equal(e.av, "f8.0");
  // Overcast daylight at f/8, ISO 100: a slow-ish shutter the dog will blur at.
  const t = e.t;
  assert.ok(t >= 1 / 125 && t <= 1 / 30, `expected about 1/60 s, got ${e.tv}`);
});

test("exposure compensation brightens by the same number of stops", async () => {
  const c = await cam("group");
  const before = c.solve(0);
  await put(c, "exposure", "+1_2/3");
  const after = c.solve(0);
  const stops = Math.log2((after.t * after.iso) / (after.N * after.N)) - Math.log2((before.t * before.iso) / (before.N * before.N));
  assert.ok(Math.abs(stops - 5 / 3) < 0.4, `expected +1⅔ stops, got ${stops.toFixed(2)}`);
});

test("with flash, Tv shoots at the sync speed and solves the exposure for it", async () => {
  const c = await cam("gym");
  const e = c.solve(0, { flash: "fill" });
  assert.equal(e.tv, "1/200");
  assert.ok(Math.abs(e.error) < 0.3, `exposure error ${e.error.toFixed(2)} stops at ${e.av} ISO ${e.isoValue}`);
});

test("bulb with auto ISO meters for the ISO it uses", async () => {
  const c = await cam("group");
  await setMode(c, "bulb");
  const e = c.solve(0);
  assert.equal(e.isoValue, "400");
  assert.ok(Math.abs(e.error) < 0.3, `exposure error ${e.error.toFixed(2)} stops`);
});

test("spot metering on a backlit face exposes brighter than evaluative", async () => {
  const c = await cam("group");
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
  const c = await cam("group");
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

test("discovery lists every route with its methods, and unknown routes or methods are refused", async () => {
  const c = await cam("group");
  const d = (await get(c, "/ccapi")).json as Record<string, Array<{ path: string; get: boolean; put: boolean; delete: boolean }>>;
  assert.deepEqual(Object.keys(d).sort(), ["ver100", "ver110", "ver120"]);
  const style = d.ver100.find((e) => e.path === "/ccapi/ver100/shooting/settings/picturestyle/standard")!;
  assert.ok(style.get && style.put && style.delete);
  assert.ok(d.ver110.some((e) => e.path === "/ccapi/ver110/shooting/settings/stillimagequality"));
  assert.equal((await get(c, "/ccapi/ver110/shooting/settings/av")).status, 404);
  assert.equal((await c.handle({ method: "DELETE", path: "/ccapi/ver100/shooting/settings/av" })).status, 405);
});

test("flash lights a dark foreground and falls off with distance", async () => {
  const c = await cam("dinner");
  await setMode(c, "m");
  await put(c, "tv", "1/125");
  await put(c, "av", "f4.0");
  await put(c, "iso", "400");
  const [plain] = await shoot(c);
  assert.equal((await put(c, "flash", "on")).status, 200);
  const [lit] = await shoot(c);
  assert.ok(lit.flash && !plain.flash);
  const near: [number, number, number, number] = [0.3, 0.8, 0.7, 0.98]; // the table, 1.6 m away
  const a = meanLum(await fileBytes(c, plain.path), near);
  const b = meanLum(await fileBytes(c, lit.path), near);
  assert.ok(b > a + 25, `table ${a.toFixed(1)} -> ${b.toFixed(1)} with flash`);
  // The flash can't sync with the electronic shutter: the setting is then unavailable.
  await put(c, "shuttermode", "electronic", "ver110");
  const flash = await get(c, "/ccapi/ver100/shooting/settings/flash");
  assert.deepEqual(flash.json, { value: "", ability: [] });
});

test("HDR Mode, set by hand, lifts the face in the shade and keeps the sunlit meadow", async () => {
  const c = await cam("shade");
  const face: [number, number, number, number] = [0.17, 0.15, 0.26, 0.3];
  const meadow: [number, number, number, number] = [0.45, 0.35, 0.95, 0.42];
  const [plain] = await shoot(c);
  assert.deepEqual(c.status().menu, {});
  assert.ok(!((await handleSim(c, { method: "POST", path: "/sim/menu", body: { setting: "Picture Style", value: "Fine Detail" } })).json as { applied: boolean }).applied);
  const res = await handleSim(c, { method: "POST", path: "/sim/menu", body: { setting: "Adjust dyn range", value: "Auto" } });
  assert.deepEqual(res.json, { applied: true });
  assert.deepEqual(c.status().menu, { "HDR Mode": "Auto" });
  const [hdr] = await shoot(c);
  const before = { face: meanLum(await fileBytes(c, plain.path), face), meadow: meanLum(await fileBytes(c, plain.path), meadow) };
  const after = { face: meanLum(await fileBytes(c, hdr.path), face), meadow: meanLum(await fileBytes(c, hdr.path), meadow) };
  // Five stops apart: one exposure leaves the face dark; the merge brings it up without burning the meadow.
  assert.ok(before.meadow - before.face > 90, `plain: face ${before.face.toFixed(0)}, meadow ${before.meadow.toFixed(0)}`);
  assert.ok(after.face > before.face + 35, `face ${before.face.toFixed(0)} -> ${after.face.toFixed(0)}`);
  assert.ok(after.meadow < 245 && after.meadow <= before.meadow + 5, `meadow ${before.meadow.toFixed(0)} -> ${after.meadow.toFixed(0)}`);
  // Switching it off goes back to single shots.
  await handleSim(c, { method: "POST", path: "/sim/menu", body: { setting: "Adjust dyn range", value: "Disable HDR" } });
  assert.deepEqual(c.status().menu, {});
});

test("the aspect ratio crops the recorded image", async () => {
  const c = await cam("group");
  assert.equal((await put(c, "stillimageaspectratio", "16:9")).status, 200);
  const [wide] = await shoot(c);
  const img = decode(await fileBytes(c, wide.path));
  assert.deepEqual([img.width, img.height], [1200, 675]);
  await put(c, "stillimageaspectratio", "1:1");
  await c.handle({ method: "PUT", path: "/ccapi/ver110/shooting/settings/stillimagequality", body: { value: { raw: "none", jpeg: "medium2" } } });
  const [square] = await shoot(c);
  const sq = decode(await fileBytes(c, square.path));
  assert.deepEqual([sq.width, sq.height], [400, 400]);
});

test("continuous drive and exposure bracketing make several files from one press", async () => {
  const c = await cam("group");
  await put(c, "drive", "highspeed");
  const burst = await shoot(c);
  assert.equal(burst.length, 3);
  await put(c, "drive", "single");
  await put(c, "aeb", "+1.0");
  const bracket = await shoot(c);
  assert.equal(bracket.length, 3);
  // Canon order: metered, under, over. In Av the shutter speed carries the bracket.
  const [m, under, over] = bracket.map((s) => s.exposure.t);
  assert.ok(under < m && m < over, `${under} ${m} ${over}`);
});

test("WB bracketing writes three JPEGs and is not offered with RAW", async () => {
  const c = await cam("group");
  assert.equal((await put(c, "wbbracket", "ba2")).status, 200);
  assert.equal((await shoot(c)).length, 3);
  await c.handle({ method: "PUT", path: "/ccapi/ver110/shooting/settings/stillimagequality", body: { value: { raw: "raw", jpeg: "large" } } });
  assert.deepEqual((await get(c, "/ccapi/ver100/shooting/settings/wbbracket")).json, { value: "", ability: [] });
});

test("the AF frame position decides what spot AF focuses on", async () => {
  const c = await cam("group");
  // Face detection shows the subject's frame; then point spot AF at the head in it, and at the field.
  await post(c, "ver100/shooting/liveview", { liveviewsize: "small", cameradisplay: "on" });
  const info = (await get(c, "/ccapi/ver100/shooting/liveview/flipdetail?kind=info")).bytes!;
  const json = JSON.parse(new TextDecoder().decode(info.subarray(7, info.length - 2)));
  const face = json.liveviewdata.afframe[0];
  await put(c, "afmethod", "spot");
  const at = { positionx: Math.round(face.x + face.width / 2), positiony: Math.round(face.y + face.height * 0.1) };
  assert.equal((await c.handle({ method: "PUT", path: "/ccapi/ver100/shooting/liveview/afframeposition", body: at })).status, 200);
  // Positions are whole sensor pixels.
  assert.equal((await c.handle({ method: "PUT", path: "/ccapi/ver100/shooting/liveview/afframeposition", body: { positionx: 10.5, positiony: 10 } })).status, 400);
  await post(c, "ver100/shooting/control/af", { action: "start" });
  assert.equal((await post(c, "ver100/shooting/control/af", { action: "start" })).status, 503); // Already started
  await post(c, "ver100/shooting/control/af", { action: "stop" });
  // Spot AF locks on the person under the point, at their distance.
  assert.equal(c.status().focusOn, "front");
  assert.ok(Math.abs(c.status().focus - 2.1) < 0.01, `focus ${c.status().focus}`);
  // The lawn near the bottom edge, past the people.
  await c.handle({ method: "PUT", path: "/ccapi/ver100/shooting/liveview/afframeposition", body: { positionx: 100, positiony: 780 } });
  await post(c, "ver100/shooting/control/af", { action: "start" });
  await post(c, "ver100/shooting/control/af", { action: "stop" });
  assert.equal(c.status().focusOn, "park");
  assert.ok(c.status().focus > 3, `focus ${c.status().focus}`);
  // Blank overcast sky has nothing to lock on: one-shot AF refuses to release.
  const dog = await cam("dog");
  await put(dog, "afmethod", "spot");
  await dog.handle({ method: "PUT", path: "/ccapi/ver100/shooting/liveview/afframeposition", body: { positionx: 600, positiony: 10 } });
  assert.deepEqual((await post(dog, "ver100/shooting/control/shutterbutton", { af: true })).json, { message: "Out of focus" });
});

test("focus can be driven by hand and the shot keeps it", async () => {
  const c = await cam("group");
  const start = c.status().focus;
  await post(c, "ver100/shooting/control/drivefocus", { value: "near3" });
  await post(c, "ver100/shooting/control/drivefocus", { value: "near3" });
  assert.equal((await post(c, "ver100/shooting/control/drivefocus", { value: "near4" })).status, 400);
  const near = c.status().focus;
  assert.ok(near < start - 0.5, `${start} -> ${near}`);
  const [shot] = await shoot(c, false);
  assert.equal(shot.focus, near);
  // The lens can't focus closer than its minimum distance.
  for (let i = 0; i < 20; i++) await post(c, "ver100/shooting/control/drivefocus", { value: "near3" });
  assert.ok(Math.abs(c.status().focus - 0.3) < 1e-9, `focus ${c.status().focus}`);
});

test("formatting the card erases every file, protected ones too", async () => {
  const c = await cam("group");
  await get(c, "/ccapi/ver110/event/polling"); // full state first
  const [shot] = await shoot(c);
  await c.handle({ method: "PUT", path: shot.path, body: { action: "protect", value: "enable" } });
  assert.equal((await post(c, "ver100/functions/cardformat", { name: "card2" })).status, 409);
  assert.equal((await post(c, "ver100/functions/cardformat", { name: "card1" })).status, 200);
  const dir = await get(c, "/ccapi/ver120/contents/card1/100CANON");
  assert.deepEqual(dir.json, { path: [] });
  assert.equal(c.status().shots.length, 0);
  const ev = (await get(c, "/ccapi/ver110/event/polling")).json as Record<string, unknown>;
  assert.deepEqual(ev.cardformat, ["/ccapi/ver120/contents/card1"]);
  const storage = (await get(c, "/ccapi/ver110/devicestatus/storage")).json as { storagelist: Array<{ contentsnumber: number; spacesize: number; maxsize: number }> };
  assert.equal(storage.storagelist[0].contentsnumber, 0);
  assert.equal(storage.storagelist[0].spacesize, storage.storagelist[0].maxsize);
});

test("a protected file can't be deleted; changes show in info and events", async () => {
  const c = await cam("group");
  await get(c, "/ccapi/ver110/event/polling");
  const [shot] = await shoot(c);
  await get(c, "/ccapi/ver110/event/polling");
  assert.equal((await c.handle({ method: "PUT", path: shot.path, body: { action: "protect", value: "enable" } })).status, 200);
  assert.equal((await c.handle({ method: "PUT", path: shot.path, body: { action: "rating", value: "6" } })).status, 400);
  await c.handle({ method: "PUT", path: shot.path, body: { action: "rotate", value: "90" } });
  const info = (await get(c, `${shot.path}?kind=info`)).json as Record<string, unknown>;
  assert.equal(info.protect, "enable");
  assert.equal(info.rotate, "90");
  const del = await c.handle({ method: "DELETE", path: shot.path });
  assert.deepEqual([del.status, del.json], [409, { message: "File protected" }]);
  const ev = (await get(c, "/ccapi/ver110/event/polling")).json as Record<string, unknown>;
  assert.deepEqual(ev.updatedcontents, [shot.path]);
  await c.handle({ method: "PUT", path: shot.path, body: { action: "protect", value: "disable" } });
  assert.equal((await c.handle({ method: "DELETE", path: shot.path })).status, 200);
  assert.equal((await get(c, `${shot.path}?kind=info`)).status, 404);
  // ver100 polling reports content changes as absolute URLs (deletions as the parent folder).
  const ev100 = (await get(c, "/ccapi/ver100/event/polling", { host: "10.0.0.5:8080" })).json as Record<string, unknown>;
  assert.deepEqual(ev100.deletedcontents, ["http://10.0.0.5:8080/ccapi/ver120/contents/card1/100CANON"]);
});

test("RAW shots are .CR3 files with an embedded JPEG; downloads honour ranges", async () => {
  const c = await cam("group");
  const q = await c.handle({ method: "PUT", path: "/ccapi/ver110/shooting/settings/stillimagequality", body: { value: { raw: "raw", jpeg: "none" } } });
  assert.equal(q.status, 200);
  assert.equal((await c.handle({ method: "PUT", path: "/ccapi/ver110/shooting/settings/stillimagequality", body: { value: { raw: "none", jpeg: "none" } } })).status, 400);
  const [shot] = await shoot(c);
  assert.match(shot.path, /\/IMG_\d{4}\.CR3$/);
  const main = await get(c, shot.path);
  assert.equal(main.contentType, "application/octet-stream");
  assert.equal(new TextDecoder().decode(main.bytes!.subarray(0, 8)), "SIMRAW01");
  const embedded = await get(c, `${shot.path}?kind=embedded`);
  assert.deepEqual([embedded.bytes![0], embedded.bytes![1]], [0xff, 0xd8]);
  const part = await get(c, shot.path, { range: "bytes=0-7" });
  assert.equal(part.status, 206);
  assert.equal(part.headers!["content-range"], `bytes 0-7/${main.bytes!.length}`);
  assert.equal(part.bytes!.length, 8);
  assert.equal((await get(c, shot.path, { range: `bytes=${main.bytes!.length}-` })).status, 416);
  // Only RAW files have an embedded JPEG; unknown kinds are refused.
  await c.handle({ method: "PUT", path: "/ccapi/ver110/shooting/settings/stillimagequality", body: { value: { raw: "none", jpeg: "small" } } });
  const [small] = await shoot(c);
  assert.equal((await get(c, `${small.path}?kind=embedded`)).status, 400);
  assert.equal((await get(c, `${small.path}?kind=display`)).status, 400); // small JPEGs have no display image
});

test("picture style detail and white balance shift validate every field", async () => {
  const c = await cam("group");
  const path = "/ccapi/ver100/shooting/settings/picturestyle/standard";
  const before = (await get(c, path)).json as { value: Record<string, number> };
  assert.equal((await c.handle({ method: "PUT", path, body: { value: { ...before.value, sharpness_strength: 8 } } })).status, 400);
  assert.equal((await c.handle({ method: "PUT", path, body: { value: { sharpness_strength: 2 } } })).status, 400);
  const ok = await c.handle({ method: "PUT", path, body: { value: { ...before.value, contrast: 3, saturation: -2 } } });
  assert.equal(ok.status, 200);
  assert.equal((ok.json as { value: Record<string, number> }).value.contrast, 3);
  const reset = await c.handle({ method: "DELETE", path });
  assert.deepEqual((reset.json as { value: unknown }).value, before.value);
  // A user style follows its base: monochrome has filter and toning instead of colour.
  await put(c, "picturestyle/userdef1/basepicturestyle", "monochrome");
  const user = (await get(c, "/ccapi/ver100/shooting/settings/picturestyle/userdef1")).json as { value: Record<string, unknown> };
  assert.equal(user.value.basepicturestyle, "monochrome");
  assert.equal(user.value.filtereffect, "none");
  assert.equal((await put(c, "wbshift", { ba: 10, mg: 0 })).status, 400);
  assert.equal((await put(c, "wbshift", { ba: 1 })).status, 400);
  assert.equal((await put(c, "wbshift", "1")).status, 400);
  assert.deepEqual((await put(c, "wbshift", { ba: 3, mg: -2 })).json, { value: { ba: 3, mg: -2 } });
});

test("monochrome renders grey; a WB shift towards amber warms the picture", async () => {
  const c = await cam("group");
  await put(c, "picturestyle", "monochrome");
  const [mono] = await shoot(c);
  const img = decode(await fileBytes(c, mono.path));
  let spread = 0;
  for (let i = 0; i < img.data.length; i += 4 * 97) spread = Math.max(spread, Math.abs(img.data[i] - img.data[i + 2]));
  assert.ok(spread <= 3, `channel spread ${spread}`);
  await put(c, "picturestyle", "standard");
  const [plain] = await shoot(c);
  await put(c, "wbshift", { ba: 9, mg: 0 });
  const [warm] = await shoot(c);
  const rb = (bytes: Uint8Array) => {
    const d = decode(bytes);
    let r = 0, b = 0;
    // Mid-tones only: clipped highlights stay white whatever the white balance.
    for (let i = 0; i < d.data.length; i += 4) {
      if (Math.max(d.data[i], d.data[i + 1], d.data[i + 2]) > 200) continue;
      r += d.data[i];
      b += d.data[i + 2];
    }
    return r / b;
  };
  assert.ok(rb(await fileBytes(c, warm.path)) > rb(await fileBytes(c, plain.path)) * 1.05);
});

test("click white balance sets a custom white balance from the live view", async () => {
  const c = await cam("dinner");
  assert.equal((await post(c, "ver110/shooting/liveview/clickwb", { positionx: 600, positiony: 300 })).status, 503);
  await post(c, "ver100/shooting/liveview", { liveviewsize: "small", cameradisplay: "on" });
  assert.equal((await post(c, "ver110/shooting/liveview/clickwb", { positionx: 600, positiony: 300 })).status, 200);
  assert.equal(c.status().settings.wb, "custom");
});

test("live view magnification zooms around the AF point", async () => {
  const c = await cam("group");
  await post(c, "ver100/shooting/liveview", { liveviewsize: "small", cameradisplay: "on" });
  assert.deepEqual((await put(c, "lvzoom", "5", "ver110")).json, {});
  await c.handle({ method: "PUT", path: "/ccapi/ver100/shooting/liveview/afframeposition", body: { positionx: 1100, positiony: 100 } });
  const info = (await get(c, "/ccapi/ver100/shooting/liveview/flipdetail?kind=info")).bytes!;
  const json = JSON.parse(new TextDecoder().decode(info.subarray(7, info.length - 2)));
  assert.equal(json.liveviewdata.zoom.magnification, 5);
  assert.deepEqual([json.liveviewdata.image.positionx, json.liveviewdata.image.positionwidth], [960, 240]);
});

test("movie mode records a Motion-JPEG .MOV and blocks still settings", async () => {
  const c = await cam("group");
  assert.equal((await post(c, "ver100/shooting/control/recbutton", { action: "start" })).status, 503);
  assert.equal((await post(c, "ver100/shooting/control/moviemode", { action: "on" })).status, 200);
  assert.equal((await get(c, "/ccapi/ver100/shooting/settings/av")).status, 503);
  assert.equal((await get(c, "/ccapi/ver100/shooting/settings/moviequality")).status, 200);
  assert.equal((await post(c, "ver100/shooting/control/recbutton", { action: "start" })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post(c, "ver100/shooting/control/moviemode", { action: "off" })).status, 503);
  assert.equal((await post(c, "ver100/shooting/control/recbutton", { action: "stop" })).status, 200);
  assert.equal((await post(c, "ver100/shooting/control/recbutton", { action: "stop" })).status, 400);
  assert.equal((await get(c, "/ccapi/ver120/contents/card1/100CANON")).status, 503);
  await post(c, "ver100/shooting/control/moviemode", { action: "off" });
  const list = (await get(c, "/ccapi/ver120/contents/card1/100CANON?type=mov")).json as { path: string[] };
  assert.equal(list.path.length, 1);
  assert.match(list.path[0], /MVI_\d{4}\.MOV$/);
  const mov = await get(c, list.path[0]);
  assert.equal(mov.contentType, "video/quicktime");
  assert.equal(new TextDecoder().decode(mov.bytes!.subarray(4, 8)), "ftyp");
  const info = (await get(c, `${list.path[0]}?kind=info`)).json as { playtime: number };
  assert.ok(info.playtime >= 1);
  assert.equal((await get(c, `${list.path[0]}?kind=display`)).status, 400);
});

test("self-timer, the clock and leaving the network", async () => {
  const c = await cam("group");
  await put(c, "drive", "self_2sec");
  assert.equal((await shoot(c)).length, 1);
  const t = await c.handle({ method: "PUT", path: "/ccapi/ver100/functions/datetime", body: { datetime: "Tue, 01 Jan 2019 01:23:45 +0900", dst: false } });
  assert.equal(t.status, 200);
  assert.equal((await c.handle({ method: "PUT", path: "/ccapi/ver100/functions/datetime", body: { datetime: "Wed, 01 Jan 2019 01:23:45 +0900", dst: false } })).status, 400);
  const now = (await get(c, "/ccapi/ver100/functions/datetime")).json as { datetime: string };
  assert.match(now.datetime, /^Tue, 01 Jan 2019 01:2\d:\d\d \+0900$/);
  // Files are dated by the camera clock, when written and when changed.
  const [shot] = await shoot(c);
  assert.match(((await get(c, `${shot.path}?kind=info`)).json as { lastmodifieddate: string }).lastmodifieddate, /31 Dec 2018/);
  await c.handle({ method: "PUT", path: shot.path, body: { action: "rating", value: "3" } });
  assert.match(((await get(c, `${shot.path}?kind=info`)).json as { lastmodifieddate: string }).lastmodifieddate, /31 Dec 2018/);
  assert.equal((await post(c, "ver100/functions/wificonnection", { action: "disconnect" })).status, 202);
  assert.equal((await get(c, "/ccapi")).closed, true);
  c.reconnect();
  assert.equal((await get(c, "/ccapi")).status, 200);
});

test("event polling reports changes once, in both versions", async () => {
  const c = await cam("group");
  const first = (await get(c, "/ccapi/ver110/event/polling")).json as Record<string, unknown>;
  assert.ok("av" in first && "storage" in first && "beep" in first);
  assert.deepEqual(Object.keys((await get(c, "/ccapi/ver100/event/polling?continue=off")).json as object), []);
  await c.handle({ method: "PUT", path: "/ccapi/ver100/functions/beep", body: { value: "disable" } });
  await put(c, "wbshift", { ba: 2, mg: 0 });
  const ev = (await get(c, "/ccapi/ver110/event/polling")).json as Record<string, unknown>;
  assert.deepEqual(Object.keys(ev).sort(), ["beep", "wbshift"]);
  assert.equal((await get(c, "/ccapi/ver110/event/polling?timeout=forever")).status, 400);
});

test("event polling reports the exposure the last shot used, even when the live pick changed", async () => {
  const c = await cam("group");
  await get(c, "/ccapi/ver110/event/polling");
  await put(c, "exposure", "+1.0");
  await put(c, "aeb", "+1.0");
  const shots = await shoot(c);
  const last = shots[shots.length - 1].exposure.tv;
  assert.notEqual(last, c.solve(0).tv);
  const ev = (await get(c, "/ccapi/ver110/event/polling")).json as Record<string, { value: string }>;
  assert.equal(ev.effective_value_tv.value, last);
});

test("the contents API pages by 100, counts, filters and streams chunks", () => {
  const card = new Card(() => {});
  for (let i = 1; i <= 150; i++) {
    const kind = i % 3 === 0 ? "cr3" : "jpeg";
    card.add({ name: `IMG_${String(i).padStart(4, "0")}.${kind === "cr3" ? "CR3" : "JPG"}`, kind, main: new Uint8Array(10), thumb: new Uint8Array(1), modified: "", playtime: null, capture: i });
  }
  const q = (s: string) => card.handle("GET", "/card1/100CANON", new URLSearchParams(s), {}, undefined);
  assert.deepEqual(q("kind=number").json, { contentsnumber: 150, pagenumber: 2 });
  assert.equal((q("").json as { path: string[] }).path.length, 100);
  const page2 = (q("page=2").json as { path: string[] }).path;
  assert.equal(page2.length, 50);
  assert.equal(page2[0], "/ccapi/ver120/contents/card1/100CANON/IMG_0101.JPG");
  assert.deepEqual(q("kind=number&type=cr3").json, { contentsnumber: 50, pagenumber: 1 });
  assert.equal(q("page=0").status, 400);
  assert.equal(q("kind=chunked&page=2").status, 400);
  assert.equal(q("type=gif").status, 400);
  const chunked = new TextDecoder().decode(q("kind=chunked&order=desc").bytes!);
  const parts = chunked.split("}{");
  assert.equal(parts.length, 2);
  assert.ok(chunked.startsWith('{"path":["/ccapi/ver120/contents/card1/100CANON/IMG_0150.CR3"'));
});

// ------------------------------------------------------------------ flicker and group depth of field

/** Mean luminance of each row of a JPEG, averaged across the width. */
function rowMeans(bytes: Uint8Array): number[] {
  const img = decode(bytes);
  const out: number[] = [];
  for (let y = 0; y < img.height; y++) {
    let sum = 0;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    }
    out.push(sum / img.width);
  }
  return out;
}

/** How much two shots of the same scene differ row by row (bands that moved), relative to their brightness. */
function bandDiff(a: Uint8Array, b: Uint8Array): number {
  const ra = rowMeans(a), rb = rowMeans(b);
  let diff = 0, sum = 0;
  for (let y = 0; y < ra.length; y++) {
    diff += Math.abs(ra[y] - rb[y]);
    sum += (ra[y] + rb[y]) / 2;
  }
  return diff / sum;
}

test("under 50 Hz tubes, 1/1000 s varies shot to shot; anti-flicker shooting keeps it steady", async () => {
  const c = await cam("gym");
  await put(c, "shuttermode", "mechanical", "ver110");
  await put(c, "drive", "single");
  const wall: [number, number, number, number] = [0.05, 0.08, 0.95, 0.5];
  const series = async () => {
    const lums: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [s] = await shoot(c);
      assert.equal(s.exposure.tv, "1/1000");
      lums.push(meanLum(await fileBytes(c, s.path), wall));
    }
    return Math.max(...lums) - Math.min(...lums);
  };
  const free = await series();
  assert.ok(free > 12, `exposure should swing between shots, range ${free.toFixed(1)}`);
  assert.equal((await put(c, "antiflickershoot", "enable", "ver110")).status, 200);
  const timed = await series();
  assert.ok(timed < 2, `anti-flicker shots should match, range ${timed.toFixed(1)}`);
  // Anti-flicker can't time the slow electronic readout: the camera offers it only with a curtain shutter.
  await put(c, "shuttermode", "electronic", "ver110");
  assert.equal((await put(c, "antiflickershoot", "enable", "ver110")).status, 400);
});

test("LED stage lights band the electronic shutter until the HF anti-flicker speed matches them", async () => {
  const c = await cam("concert");
  assert.equal(((await get(c, "/ccapi/ver110/shooting/settings/shuttermode")).json as { value: string }).value, "electronic");
  const pair = async () => {
    const [a] = await shoot(c);
    const [b] = await shoot(c);
    return { tv: a.exposure.tv, d: bandDiff(await fileBytes(c, a.path), await fileBytes(c, b.path)) };
  };
  const banded = await pair();
  assert.equal(banded.tv, "1/2000");
  assert.ok(banded.d > 0.05, `bands should move between shots, diff ${banded.d.toFixed(3)}`);

  // HF anti-flicker: detection needs live view, then applies a speed lasting whole LED periods.
  assert.equal((await put(c, "hfantiflickershoot", "enable", "ver110")).status, 200);
  assert.equal((await post(c, "ver110/shooting/control/hfflickerdetection", { action: "start", apply_result: true })).status, 503);
  await post(c, "ver100/shooting/liveview", { liveviewsize: "small", cameradisplay: "on" });
  const det = (await post(c, "ver110/shooting/control/hfflickerdetection", { action: "start", apply_result: true })).json as { result: string; frequency: string; tv: string };
  assert.equal(det.result, "ok");
  assert.equal(det.frequency, "1310.0Hz");
  const periods = (1 / Number(det.tv.slice(2))) * 1310;
  assert.ok(Math.abs(periods - Math.round(periods)) < 0.01, `${det.tv} should last whole periods (${periods.toFixed(3)})`);
  assert.equal(c.status().settings.hfflickertv, det.tv);
  const clean = await pair();
  assert.equal(clean.tv, det.tv);
  assert.ok(clean.d < banded.d / 4 && clean.d < 0.02, `no bands at ${det.tv}, diff ${clean.d.toFixed(3)}`);

  // Fine steps move off the matching speed, and the bands come back.
  assert.equal((await post(c, "ver110/shooting/control/hfflickertv", { value: "increment_large" })).status, 200);
  assert.notEqual(c.status().settings.hfflickertv, det.tv);
});

test("flicker detection reports what lights each scene", async () => {
  const detect = async (scene: string) => {
    const c = await cam(scene);
    return (await post(c, "ver110/shooting/control/flickerdetection", { action: "start" })).json;
  };
  assert.deepEqual(await detect("gym"), { result: "ok", frequency: "100Hz" });
  // LED dimming far above mains frequency isn't what the ordinary detector looks for.
  assert.deepEqual(await detect("concert"), { result: "ng" });
  assert.deepEqual(await detect("group"), { result: "ng" });
  const gym = await cam("gym");
  await setMode(gym, "tv");
  await put(gym, "hfantiflickershoot", "enable", "ver110");
  await post(gym, "ver100/shooting/liveview", { liveviewsize: "small", cameradisplay: "on" });
  const hf = (await post(gym, "ver110/shooting/control/hfflickerdetection", { action: "start", apply_result: false })).json as { frequency: string; tv: string };
  assert.equal(hf.frequency, "100.0Hz");
  assert.equal(hf.tv, "1/100.0"); // the closest whole number of 100 Hz periods to 1/1000 is one
});

/** Detail in a box: mean absolute difference between horizontal neighbours. */
function detail(bytes: Uint8Array, box: [number, number, number, number]) {
  const img = decode(bytes);
  let sum = 0, n = 0;
  for (let y = Math.floor(box[1] * img.height); y < box[3] * img.height; y++) {
    for (let x = Math.floor(box[0] * img.width) + 1; x < box[2] * img.width; x++) {
      const i = (y * img.width + x) * 4;
      sum += Math.abs(img.data[i + 1] - img.data[i - 3]);
      n++;
    }
  }
  return sum / n;
}

test("group portrait: the back row is sharper stopped down to f/8 than wide open", async () => {
  const c = await cam("group");
  const back: [number, number, number, number] = [0.785, 0.27, 0.845, 0.45];
  const at = async (av: string) => {
    assert.equal((await put(c, "av", av)).status, 200);
    const [s] = await shoot(c);
    assert.ok(Math.abs(s.focus - 2.1) < 0.01, "focus stays on the front person");
    return detail(await fileBytes(c, s.path), back);
  };
  const open = await at("f1.8");
  const closed = await at("f8.0");
  assert.ok(closed > open * 1.3, `back person detail f/8 ${closed.toFixed(2)} vs f/1.8 ${open.toFixed(2)}`);
});

test("downloads hand out copies, so a host that transfers the buffer (Web Worker postMessage) can download again", async () => {
  const c = await cam("dog");
  const [s] = await shoot(c);
  for (const kind of ["main", "display", "thumbnail", "main", "display"]) {
    const res = await get(c, `${s.path}?kind=${kind}`);
    assert.equal(res.status, 200, kind);
    assert.ok(res.bytes!.length > 1000, `${kind}: ${res.bytes!.length} bytes`);
    decode(res.bytes!);
    // What the browser worker does with every answer: move the bytes to the page.
    structuredClone(res.bytes, { transfer: [res.bytes!.buffer as ArrayBuffer] });
    assert.equal(res.bytes!.length, 0, "the transferred buffer is gone for the sender");
  }
  const part = await get(c, s.path, { range: "bytes=0-99" });
  assert.equal(part.status, 206);
  structuredClone(part.bytes, { transfer: [part.bytes!.buffer as ArrayBuffer] });
  assert.ok((await get(c, s.path)).bytes!.length > 1000);
});
