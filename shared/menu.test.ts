import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanMenu, knownSettings, MENU_LIMITS, MENU_MAPS, menuMapFor, menuPath, menuSettingsText, rewriteMenuSteps, type MenuScreen } from "./menu.ts";

const R6II = "Canon EOS R6 Mark II, lens RF24-105mm F4-7.1 IS STM";

/** The path's screens as [tab, page, title, rows, selected]. */
function path(setting: string, value: string, camera = R6II) {
  const p = menuPath(camera, setting, value);
  assert.ok(p, `${setting} should be in the map`);
  return { ...p, shape: p.screens.map((s: MenuScreen) => [s.tab, s.page, s.title, s.items, s.select]) };
}

const SHOOT2 = ["Expo.comp./AEB", "ISO speed settings", "HDR shooting", "HDR Mode", "Auto Lighting Optimizer", "Highlight tone priority"];
const SHOOT3 = ["Anti-flicker shoot.", "HF anti-flicker shooting", "External Speedlite control", "Metering mode"];
const SHOOT5 = ["Lens aberration correction", "Long exp. noise reduction", "High ISO speed NR", "Dust Delete Data"];
const SHOOT7 = ["Drive mode", "Interval timer", "Bulb timer", "Silent shutter function", "Shutter mode", "Release shutter without card"];
const AF1 = ["AF operation", "AF area", "Whole area tracking Servo AF", "Subject to detect", "Eye detection", "Switching tracked subjects", "Focus mode"];

test("camera names pick their map; unknown cameras fall back to the generic mirrorless menus", () => {
  assert.equal(menuMapFor("Canon EOS R6 Mark II").map.model, "mirrorless");
  assert.equal(menuMapFor(R6II).exact, true);
  assert.equal(menuMapFor("Canon EOS R6m2").exact, true);
  const other = menuMapFor("Canon EOS R5");
  assert.equal(other.exact, false);
  assert.equal(other.map, MENU_MAPS[0]);
  assert.equal(menuMapFor("Canon EOS R6 Mark III").exact, false);
});

test("Highlight tone priority: SHOOT2, then Disable / Enable / Enhanced", () => {
  const p = path("Highlight tone priority", "Enable");
  assert.deepEqual(p.shape, [
    ["shoot", 2, undefined, SHOOT2, "Highlight tone priority"],
    ["shoot", undefined, "Highlight tone priority", ["Disable", "Enable", "Enhanced"], "Enable"],
  ]);
  assert.equal(p.screens[0].pages, 10);
  assert.equal(p.screens[0].model, "mirrorless");
  assert.deepEqual(p.screens[0].values, ["-3..2..1..0..1..2..+3", "", "OFF", "Off", "Standard", "OFF"]);
  assert.equal(p.screens[1].current, "Disable");
  assert.deepEqual(p.screens[1].values, ["OFF", "D+", "D+2"]);
  assert.deepEqual(p.steps, ["Press MENU", "Open the Shooting (red) tab, page 2", "Select Highlight tone priority", "Choose Enable and press SET"]);
  // Aliases and codes work too.
  assert.equal(menuPath(R6II, "HTP", "D+")?.value, "Enable");
});

test("Auto Lighting Optimizer: SHOOT2, Disable / Low / Standard / High", () => {
  const p = path("Auto Lighting Optimizer", "Disable");
  assert.deepEqual(p.shape[1], ["shoot", undefined, "Auto Lighting Optimizer", ["Disable", "Low", "Standard", "High"], "Disable"]);
  assert.equal(p.screens[1].current, "Standard");
});

test("Subject to detect and Eye detection: AF1", () => {
  const s = path("Subject to detect", "Animals");
  assert.deepEqual(s.shape, [
    ["af", 1, undefined, AF1, "Subject to detect"],
    ["af", undefined, "Subject to detect", ["Auto", "People", "Animals", "Vehicles", "None"], "Animals"],
  ]);
  assert.equal(s.screens[0].pages, 6);
  const e = path("Eye detection", "Auto");
  assert.deepEqual(e.shape[1], ["af", undefined, "Eye detection", ["Disable", "Auto", "Right eye", "Left eye"], "Auto"]);
  // "on" means the default (Auto) where there's no On option.
  assert.equal(menuPath(R6II, "Eye AF", "on")?.value, "Auto");
});

test("Servo AF characteristics: the cases are the rows of AF2", () => {
  const p = path("Servo AF characteristics", "Case 2");
  assert.deepEqual(p.shape, [["af", 2, "Servo AF", ["Case 1", "Case 2", "Case 3", "Case 4", "Case A", "Tracking sensitivity", "Accel./decel. tracking"], "Case 2"]]);
  assert.equal(p.screens[0].current, "Case A");
  assert.deepEqual(p.screens[0].dim, ["Tracking sensitivity", "Accel./decel. tracking"]);
  assert.equal(menuPath(R6II, "AF case", "case 4")?.value, "Case 4");
});

test("Min. shutter spd.: SHOOT2 > ISO speed settings > Manual > a speed", () => {
  const p = path("Min. shutter spd.", "1/250");
  assert.deepEqual(
    p.shape.map((s) => s.slice(0, 3).concat([s[4]])),
    [
      ["shoot", 2, undefined, "ISO speed settings"],
      ["shoot", undefined, "ISO speed settings", "Min. shutter spd."],
      ["shoot", undefined, "Min. shutter spd.", "Manual"],
      ["shoot", undefined, "Min. shutter spd.", "1/250"],
    ],
  );
  assert.deepEqual(p.screens[1].items, ["ISO speed", "ISO speed range", "Auto range", "Min. shutter spd."]);
  assert.deepEqual(p.screens[2].items, ["Auto", "Manual"]);
  // The speed list scrolls to keep the choice in view.
  assert.ok(p.screens[3].items.length <= MENU_LIMITS.items && p.screens[3].items.includes("1/250"));
  assert.deepEqual(p.steps.slice(-2), ["Choose Manual", "Choose 1/250 and press SET"]);
  assert.equal(menuPath(R6II, "Minimum shutter speed", "Auto")?.screens.length, 3);
});

test("noise reduction: SHOOT5", () => {
  const h = path("High ISO speed NR", "High");
  assert.deepEqual(h.shape[0], ["shoot", 5, undefined, SHOOT5, "High ISO speed NR"]);
  assert.deepEqual(h.screens[1].items, ["Disable", "Low", "Standard", "High", "Multi Shot Noise Reduction"]);
  const l = path("Long exposure noise reduction", "Auto");
  assert.deepEqual(l.shape[1], ["shoot", undefined, "Long exp. noise reduction", ["Disable", "Auto", "Enable"], "Auto"]);
});

test("Lens aberration correction: SHOOT5 > its sub-items", () => {
  const p = path("Peripheral illum corr", "Disable");
  assert.deepEqual(p.shape, [
    ["shoot", 5, undefined, SHOOT5, "Lens aberration correction"],
    ["shoot", undefined, "Lens aberration correction", ["Peripheral illum corr", "Distortion correction", "Digital Lens Optimizer"], "Peripheral illum corr"],
    ["shoot", undefined, "Peripheral illum corr", ["Enable", "Disable"], "Disable"],
  ]);
  assert.deepEqual(path("Digital Lens Optimizer", "High").screens[2].items, ["Disable", "Standard", "High"]);
  // Hidden while Digital Lens Optimizer is on: the row appears for the path, with a note.
  const c = path("Chromatic aberration correction", "Enable");
  assert.ok(c.screens[1].items.includes("Chromatic aberr corr"));
  assert.ok(!c.screens[1].items.includes("Diffraction correction"));
  assert.match(c.steps.at(-1)!, /Digital Lens Optimizer is Disable/);
});

test("IS mode: SHOOT8 > IS (Image Stabilizer) mode > IS mode drop-down; digital IS is movie-only", () => {
  const p = path("IS mode", "On");
  assert.deepEqual(p.shape, [
    ["shoot", 8, undefined, ["IS (Image Stabilizer) mode", "Customize Quick Controls", "Touch Shutter", "Image review", "High speed display", "Metering timer"], "IS (Image Stabilizer) mode"],
    ["shoot", undefined, "IS (Image Stabilizer) mode", ["IS mode", "Digital IS", "Still photo IS"], "IS mode"],
    ["shoot", undefined, "IS mode", ["Off", "On"], "On"],
  ]);
  assert.equal(p.screens[2].popup, true);
  assert.deepEqual(p.screens[1].dim, ["Digital IS"]);
  assert.equal(menuPath(R6II, "Digital IS", "On"), null);
});

test("flicker: SHOOT3, and HF anti-flicker's own sub-menu", () => {
  const a = path("Anti-flicker shooting", "Enable");
  assert.deepEqual(a.shape, [
    ["shoot", 3, undefined, SHOOT3, "Anti-flicker shoot."],
    ["shoot", undefined, "Anti-flicker shoot.", ["Disable", "Enable"], "Enable"],
  ]);
  const h = path("HF anti-flicker shooting", "Enable");
  assert.deepEqual(h.shape[1], ["shoot", undefined, "HF anti-flicker shooting", ["HF anti-flicker shooting", "Manual setting", "Auto detecting"], "HF anti-flicker shooting"]);
  assert.deepEqual(h.shape[2], ["shoot", undefined, "HF anti-flicker shooting", ["Disable", "Enable"], "Enable"]);
  assert.equal(h.steps.at(-1), "Tv or M mode only.");
});

test("SHOOT7: shutter mode and releasing the shutter without a card", () => {
  const s = path("Shutter mode", "Electronic");
  assert.deepEqual(s.shape, [
    ["shoot", 7, undefined, SHOOT7, "Shutter mode"],
    ["shoot", undefined, "Shutter mode", ["Mechanical", "Elec. 1st-curtain", "Electronic"], "Electronic"],
  ]);
  assert.equal(s.screens[1].current, "Elec. 1st-curtain");
  const r = path("Shutter release w/o card", "Disable");
  assert.deepEqual(r.shape[1], ["shoot", undefined, "Release shutter without card", ["Enable", "Disable"], "Disable"]);
});

test("AF3 and AF4: release priority, touch & drag AF", () => {
  const r = path("Release priority", "Release");
  assert.deepEqual(r.shape, [
    ["af", 3, undefined, ["One-Shot AF release prior.", "Preview AF", "Lens drive when AF impossible", "AF-assist beam firing"], "One-Shot AF release prior."],
    ["af", undefined, "One-Shot AF release prior.", ["Release", "Focus"], "Release"],
  ]);
  const t = path("Touch & drag AF", "Enable");
  assert.deepEqual(t.shape, [
    ["af", 4, undefined, ["Touch & drag AF settings", "Limit AF areas", "AF area selection control", "Multi-ctrl sensitivity- AF pt select", "Orientation linked AF point", "Limit subject to detect", "L/R eye detection"], "Touch & drag AF settings"],
    ["af", undefined, "Touch & drag AF settings", ["Touch & drag AF", "Positioning method", "Active touch area", "Rel. sensitivity"], "Touch & drag AF"],
    ["af", undefined, "Touch & drag AF", ["Disable", "Enable"], "Enable"],
  ]);
});

test("an unknown value stops at the option list on the default; unknown settings aren't invented", () => {
  const p = path("Highlight tone priority", "maximum please");
  assert.equal(p.value, undefined);
  assert.equal(p.screens[1].select, "Disable");
  assert.match(p.steps.at(-1)!, /Choose the option you need/);
  assert.equal(menuPath(R6II, "Teleport mode", "On"), null);
});

test("every path fits the screen limits and cleans to itself", () => {
  const map = menuMapFor(R6II).map;
  for (const s of knownSettings(map)) {
    const p = menuPath(R6II, s.name, s.options.at(-1)!);
    assert.ok(p, s.name);
    assert.ok(p.screens.length <= MENU_LIMITS.screens && p.steps.length <= 8, s.name);
    for (const screen of p.screens) {
      assert.ok(screen.items.length <= MENU_LIMITS.items && screen.items.includes(screen.select), `${s.name}: ${screen.select}`);
      assert.ok(screen.items.every((i) => i.length <= MENU_LIMITS.text), s.name);
    }
    assert.deepEqual(cleanMenu(JSON.parse(JSON.stringify(p.screens))), p.screens, s.name);
  }
  // Page row counts match the camera (at most 7 rows a page).
  for (const page of map.menu) assert.ok(page.items.length <= 7 && page.page <= map.pages[page.tab], `${page.tab}${page.page}`);
});

test("the prompt lists the known settings with their values", () => {
  const t = menuSettingsText(R6II);
  assert.match(t, /^Menu paths on this camera:/);
  assert.match(t, /- Highlight tone priority \[SHOOT2\]: .* Values: Disable \| Enable \| Enhanced \(default Disable\)\./);
  assert.match(t, /- Servo AF characteristics \[AF2\]/);
  assert.match(t, /Min\. shutter spd\. \[SHOOT2\].*Manual \(then a value from 1\/8000 to 1"\)/);
  assert.match(menuSettingsText("Canon EOS R8"), /aren't mapped; these paths are typical of recent mirrorless bodies/);
});

test("menu_steps calls get their screens and steps from the map", () => {
  const out = JSON.parse(rewriteMenuSteps(JSON.stringify({ setting: "Subject to detect", value: "animals", why: "Dog's eye" }), R6II));
  assert.equal(out.setting, "Subject to detect");
  assert.equal(out.value, "Animals");
  assert.equal(out.why, "Dog's eye");
  assert.equal(out.verified, true);
  assert.equal(out.menu_model, "mirrorless");
  assert.deepEqual(out.screens[0].items, AF1);
  assert.equal(out.screens[1].select, "Animals");
  assert.deepEqual(out.steps, ["Press MENU", "Open the AF (pink) tab, page 1", "Select Subject to detect", "Choose Animals and press SET"]);
  // Screens the model made up are replaced, not merged.
  const forged = JSON.parse(rewriteMenuSteps(JSON.stringify({ setting: "Highlight tone priority", value: "Enable", why: "sky", screens: [{ tab: "play", items: ["x"], select: "x" }] }), R6II));
  assert.equal(forged.screens[0].tab, "shoot");
});

test("menu_steps for a setting the map doesn't know keeps the model's steps, unverified and without screens", () => {
  const raw = { setting: "Teleport mode", value: "On", why: "fun", steps: ["MENU", "Teleport", "On"], screens: [{ tab: "shoot", items: ["Teleport"], select: "Teleport" }] };
  const out = JSON.parse(rewriteMenuSteps(JSON.stringify(raw), R6II));
  assert.equal(out.verified, false);
  assert.deepEqual(out.steps, ["MENU", "Teleport", "On"]);
  assert.equal(out.screens, undefined);
  // Not JSON: passed through untouched.
  assert.equal(rewriteMenuSteps("{oops", R6II), "{oops");
});

test("cleanMenu keeps the new fields within bounds", () => {
  const out = cleanMenu([
    { tab: "shoot", page: 2, pages: 10, items: ["A", " B ", 3, "C"], values: ["1", "2", "x", "y".repeat(80)], dim: ["C", "Z", "B"], select: "B", current: "nope", model: "EOS R6 Mark II" },
    { tab: "af", title: "Eye detection", items: ["Disable", "Auto"], select: "Auto", current: "Auto", popup: true, pages: 4 },
    { tab: "af", page: 1, items: ["One"], select: "Two" },
  ]);
  assert.deepEqual(out[0], { tab: "shoot", page: 2, pages: 10, items: ["A", "B", "C"], values: ["1", "2", "y".repeat(MENU_LIMITS.value)], dim: ["C"], select: "B", model: "EOS R6 Mark II" });
  assert.deepEqual(out[1], { tab: "af", title: "Eye detection", items: ["Disable", "Auto"], select: "Auto", current: "Auto", popup: true });
  assert.deepEqual(out[2].items, ["One", "Two"]);
});
