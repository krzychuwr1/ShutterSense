import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRequest, AgentResponse, FunctionCall, Idea, Preset } from "../shared/agent-api.ts";
import type { CameraTools } from "./camera-tools.ts";
import { AgentRun, lensLine, repeatsNote, withoutOldRounds, withRecentImages, type RunUi } from "./loop.ts";

const img = (i: number) => ({ type: "function_call_output", call_id: `c${i}`, output: [{ type: "input_text", text: `shot ${i}` }, { type: "input_image", image_url: "data:image/jpeg;base64,AA" }] });

test("only the latest three images stay attached", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "Goal" }] }, img(1), img(2), img(3), img(4)];
  const out = withRecentImages(input);
  const images = out.flatMap((i) => (Array.isArray((i as { output?: unknown }).output) ? ((i as { output: Array<{ type: string }> }).output) : [])).filter((p) => p.type === "input_image");
  assert.equal(images.length, 3);
  assert.deepEqual((out[1] as { output: unknown[] }).output[1], { type: "input_text", text: "[older image removed]" });
  assert.equal(img(1).output[1].type, "input_image");
  assert.equal((input[1] as ReturnType<typeof img>).output[1].type, "input_image", "the original transcript is not modified");
});

test("long transcripts drop whole old rounds but keep the goal and the photographer's messages", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
  const input: Record<string, unknown>[] = [user("Goal: x")];
  for (let r = 0; r < 40; r++) {
    if (r === 2) input.push(user("[Photographer] warmer"));
    // Two parallel calls per round, then their outputs.
    input.push({ type: "function_call", call_id: `a${r}` }, { type: "function_call", call_id: `b${r}` });
    input.push({ type: "function_call_output", call_id: `a${r}` }, { type: "function_call_output", call_id: `b${r}` });
  }
  assert.equal(withoutOldRounds(input, 200), input);
  const out = withoutOldRounds(input, 50);
  assert.ok(out.length <= 50, String(out.length));
  assert.equal(out[0], input[0]);
  assert.ok(out.includes(input[9]), "the photographer's message stays");
  assert.deepEqual(out.at(-1), input.at(-1));
  const calls = out.filter((i) => i.type === "function_call").map((i) => i.call_id);
  const outputs = out.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
  assert.deepEqual(calls.sort(), outputs.sort(), "every kept call keeps its output");
});

test("the lens gets one short line", () => {
  assert.equal(lensLine("Long summary.", "Tv 1/1600 s: dog frozen"), "Tv 1/1600 s: dog frozen");
  const long =
    "Focus was missing because the camera was on One-Shot AF with a tiny spot point, single drive, and 1/80s in Av at f/8. I changed to Tv.";
  const line = lensLine(long);
  assert.ok(line.length <= 90, line);
  assert.ok(line.endsWith("…"));
  assert.ok(!line.includes("I changed"));
});

const SHADE = "Her face is in deep tree shade against a sunlit meadow — too wide a brightness range for one exposure, and flash is off the table. I'll use HDR to hold both.";
const SHADE_AGAIN = "Her face is in deep tree shade against a sunlit meadow — lifting exposure would blow out the grass, and flash is off as requested. I'll have you enable HDR so the camera merges exposures and holds both her face and the meadow.";

test("a note reworded from the last one is a repeat, a new thought is not", () => {
  assert.ok(repeatsNote(SHADE_AGAIN, SHADE));
  assert.ok(!repeatsNote("Silent electronic shutter + fast LED panels = banding. I'll run HF flicker detection to match the shutter to the LEDs.", "Silently but band-free — checking the shutter and light first."));
  assert.ok(!repeatsNote(SHADE, ""));
  assert.ok(!repeatsNote("ok", SHADE));
});

// ------------------------------------------------------------------ the run

test("when even the photographer's messages don't fit, the latest of them stay", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
  const input: Record<string, unknown>[] = [user("Goal: x")];
  for (let i = 0; i < 121; i++) input.push(user(`[Photographer] note ${i}`));
  input.push({ type: "function_call", call_id: "a" }, { type: "function_call_output", call_id: "a" });
  const out = withoutOldRounds(input, 110);
  assert.equal(out.length, 110);
  assert.equal(out[0], input[0]);
  assert.equal(out.at(-4), input.at(-3), "the latest message stays");
  assert.deepEqual(out.slice(-2), input.slice(-2));
});

const call = (name: string, args: unknown = {}): FunctionCall => ({ type: "function_call", call_id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args) });
const reply = (...calls: FunctionCall[]): AgentResponse => ({ calls, text: "", commentary: "" });

const camera = { describe: () => "Test camera", exposureLine: () => "Av f/2.8", getState: async () => "{}" } as unknown as CameraTools;

function fakeUi(over: Partial<RunUi> = {}) {
  const ended: string[] = [];
  const ui: RunUi = {
    step: () => undefined,
    status: () => undefined,
    shot: () => undefined,
    exposure: () => undefined,
    confirmShot: async () => true,
    ask: async () => "Done",
    ended: (outcome) => ended.push(outcome),
    ...over,
  };
  return { ui, ended };
}

function unanswered(input: unknown[]) {
  const items = input as Array<{ type?: string; call_id?: string }>;
  const answered = new Set(items.filter((i) => i.type === "function_call_output").map((i) => i.call_id));
  return items.filter((i) => i.type === "function_call" && !answered.has(i.call_id)).length;
}

test("the model's commentary shows once, not next to tell_user or reworded a round later", async () => {
  const replies: AgentResponse[] = [
    { ...reply(call("tell_user", { text: "Short note" })), commentary: SHADE },
    { ...reply(call("get_camera_state")), commentary: SHADE_AGAIN },
    { ...reply(call("get_camera_state")), commentary: "The shot came out soft, so servo focus goes on next." },
    reply(call("finish", { summary: "ok" })),
  ];
  const notes: string[] = [];
  const { ui } = fakeUi({ step: (e) => void ((e.kind === "think" || e.kind === "tell") && notes.push(e.text)) });
  const run = new AgentRun({ step: async () => replies.shift()! }, camera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" });
  await run.start("Keep her face and the meadow");
  assert.deepEqual(notes, ["Short note", "The shot came out soft, so servo focus goes on next."]);
});

test("a cancelled shot approval ends the run, and a follow-up sends a valid transcript", async () => {
  const requests: AgentRequest[] = [];
  const replies = [reply(call("shoot"), call("tell_user", { text: "hi" })), reply(call("finish", { summary: "ok" }))];
  const api = { step: async (req: AgentRequest) => (requests.push(structuredClone(req)), replies.shift()!) };
  let run: AgentRun;
  const { ui, ended } = fakeUi({
    // The prompt never answers; only cancelling ends it.
    confirmShot: () => (setTimeout(() => run.cancel(), 0), new Promise<boolean>(() => undefined)),
  });
  run = new AgentRun(api, camera, ui, { maxShots: 3, askBeforeShooting: true, glasses: () => false, session: "t" });
  await run.start("Freeze the dog");
  assert.deepEqual(ended, ["cancelled"]);
  assert.equal(run.busy, false);
  await run.instruct("try again");
  assert.deepEqual(ended, ["cancelled", "done"]);
  assert.equal(unanswered(requests[1].input), 0);
});

test("a correction sent while the model finishes still gets its turn", async () => {
  const requests: AgentRequest[] = [];
  let run: AgentRun;
  const replies = [reply(call("finish", { summary: "first" })), reply(call("finish", { summary: "second" }))];
  const api = {
    step: async (req: AgentRequest) => {
      requests.push(structuredClone(req));
      if (requests.length === 1) void run.instruct("a bit warmer");
      return replies.shift()!;
    },
  };
  const summaries: Array<string | null> = [];
  const { ui } = fakeUi({ ended: (_o, summary) => summaries.push(summary) });
  run = new AgentRun(api, camera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" });
  await run.start("Freeze the dog");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].input), /\[Photographer\] a bit warmer/);
  assert.deepEqual(summaries, ["second"]);
});

test("a new goal waits for a cancelled run to finish its camera call, then starts", async () => {
  const requests: AgentRequest[] = [];
  let release!: () => void;
  const slowCamera = { ...camera, getState: () => new Promise<string>((r) => (release = () => r("{}"))) } as unknown as CameraTools;
  const replies = [reply(call("get_camera_state")), reply(call("finish", { summary: "B done" }))];
  const api = { step: async (req: AgentRequest) => (requests.push(structuredClone(req)), replies.shift()!) };
  const { ui, ended } = fakeUi();
  const run = new AgentRun(api, slowCamera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" });
  const first = run.start("A");
  await new Promise((r) => setTimeout(r, 0));
  run.cancel();
  const second = run.start("B");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(ended, ["cancelled", "done"]);
  assert.match(JSON.stringify(requests.at(-1)!.input), /Goal: B/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)!.input), /Goal: A/);
});

test("cancelling while a new goal waits for the old run cancels the new goal too", async () => {
  let requests = 0;
  let release!: () => void;
  const slowCamera = { ...camera, getState: () => new Promise<string>((r) => (release = () => r("{}"))) } as unknown as CameraTools;
  const api = { step: async () => (requests++, reply(call("get_camera_state"))) };
  const { ui, ended } = fakeUi();
  const run = new AgentRun(api, slowCamera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" });
  const first = run.start("A");
  await new Promise((r) => setTimeout(r, 0));
  const second = run.start("B");
  run.cancel();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(ended, ["cancelled"]);
  assert.equal(requests, 1);
  assert.equal(run.busy, false);
});

test("a correction sent after cancelling runs once the cancelled run has ended", async () => {
  const requests: AgentRequest[] = [];
  let release!: () => void;
  const slowCamera = { ...camera, getState: () => new Promise<string>((r) => (release = () => r("{}"))) } as unknown as CameraTools;
  const replies = [reply(call("get_camera_state")), reply(call("finish", { summary: "warmer" }))];
  const api = { step: async (req: AgentRequest) => (requests.push(structuredClone(req)), replies.shift()!) };
  const { ui, ended } = fakeUi();
  const run = new AgentRun(api, slowCamera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" });
  const first = run.start("A");
  await new Promise((r) => setTimeout(r, 0));
  run.cancel();
  const correction = run.instruct("a bit warmer");
  release();
  await Promise.all([first, correction]);
  assert.deepEqual(ended, ["cancelled", "done"]);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].input), /\[Photographer\] a bit warmer/);
  assert.equal(run.busy, false);
});

// ------------------------------------------------------------------ presets and ideas

function memoryPresets() {
  let list: Preset[] = [];
  return { list: () => list, save: (p: Preset) => void (list = [...list.filter((q) => q.name !== p.name), p]) };
}

const outputOf = (req: AgentRequest, name: string) => {
  const items = req.input as Array<{ type?: string; name?: string; call_id?: string; output?: unknown }>;
  const id = items.find((i) => i.type === "function_call" && i.name === name)?.call_id;
  return String(items.find((i) => i.type === "function_call_output" && i.call_id === id)?.output ?? "");
};

test("save_preset stores the camera's values; apply_preset sets them and hands back the menu settings", async () => {
  const sets: Array<Record<string, unknown>> = [];
  const presetCamera = {
    ...camera,
    snapshot: async (keys?: string[]) => {
      const all = { tv: "1/1307", iso: "auto", hfantiflickershoot: "enable", shuttermode: "electronic" };
      return keys ? Object.fromEntries(Object.entries(all).filter(([k]) => keys.includes(k))) : all;
    },
    set: async (changes: Record<string, unknown>) => (sets.push(changes), { applied: ["Shutter 1/250 s → 1/1307 s"], errors: [] }),
  } as unknown as CameraTools;
  const store = memoryPresets();
  const requests: AgentRequest[] = [];
  const replies = [
    reply(call("save_preset", { name: "Club night", note: "Dimmed LED stages", menu: [{ setting: "Adjust dyn range", value: "Auto" }] })),
    reply(call("finish", { summary: "saved" })),
    reply(call("apply_preset", { name: "club  NIGHT" })),
    reply(call("finish", { summary: "applied" })),
  ];
  const api = { step: async (req: AgentRequest) => (requests.push(structuredClone(req)), replies.shift()!) };
  const steps: string[] = [];
  const { ui } = fakeUi({ step: (e) => steps.push(e.kind) });
  const opts = { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t", presets: store };
  await new AgentRun(api, presetCamera, ui, opts).start("Save this as club night");
  assert.equal(store.list().length, 1);
  const saved = store.list()[0];
  assert.deepEqual(saved.settings, { tv: "1/1307", iso: "auto", hfantiflickershoot: "enable", shuttermode: "electronic" });
  assert.deepEqual(saved.menu, [{ setting: "Adjust dyn range", value: "Auto" }]);
  assert.ok(steps.includes("preset"));
  assert.match(outputOf(requests[1], "save_preset"), /Saved preset "Club night": tv 1\/1307/);

  await new AgentRun(api, presetCamera, ui, opts).start("Use my club night preset");
  // The worker sees the preset by name in the context; the camera gets its settings.
  assert.deepEqual(requests[2].context.presets?.map((p) => p.name), ["Club night"]);
  assert.match(requests[2].context.presets![0].settings, /by hand: Adjust dyn range Auto/);
  assert.deepEqual(sets, [saved.settings]);
  assert.match(outputOf(requests[3], "apply_preset"), /call menu_steps .*Adjust dyn range = Auto/);
});

test("show_ideas pictures each idea from the live view; a failed picture still shows as text", async () => {
  const lookCamera = {
    ...camera,
    look: async () => ({ text: "Live view", image: { dataUrl: "data:image/jpeg;base64,LV", w: 1, h: 1, stats: {} } }),
    ideaPicture: async (dataUrl: string) => `small:${dataUrl}`,
  } as unknown as CameraTools;
  const prompts: Array<{ prompt: string; image?: string }> = [];
  const replies = [
    reply(
      call("show_ideas", {
        from_camera: true,
        ideas: [
          { title: "Lean on the tree", direction: "Shoulder to the trunk, look past me", prompt: "she leans on the tree" },
          { title: "Walk towards me", direction: "Slow steps, look down then up", prompt: "FAIL" },
        ],
      }),
    ),
    reply(call("finish", { summary: "ideas shown" })),
  ];
  const requests: AgentRequest[] = [];
  const api = {
    step: async (req: AgentRequest) => (requests.push(structuredClone(req)), replies.shift()!),
    inspire: async (req: { prompt: string; image?: string }) => {
      prompts.push(req);
      if (req.prompt === "FAIL") throw new Error("model busy");
      return { image: "data:image/png;base64,PIC" };
    },
  };
  let shown: Idea[] = [];
  const { ui } = fakeUi({ step: (e) => void (e.kind === "ideas" && (shown = e.ideas!)) });
  await new AgentRun(api, lookCamera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" }).start("Other poses?");
  assert.deepEqual(prompts.map((p) => p.image), ["data:image/jpeg;base64,LV", "data:image/jpeg;base64,LV"]);
  assert.deepEqual(shown.map((i) => i.image), ["small:data:image/png;base64,PIC", null]);
  assert.equal(shown[1].direction, "Slow steps, look down then up");
  assert.match(outputOf(requests[1], "show_ideas"), /1 of 2 pictures were made \(model busy\)/);
});

test("a confirmed menu guide tells the camera what was set by hand", async () => {
  const handSet: string[] = [];
  const replies = [
    reply(call("menu_steps", { setting: "Adjust dyn range", value: "Auto", why: "shade and sun", steps: ["Press MENU"] })),
    reply(call("finish", { summary: "hdr" })),
  ];
  const api = { step: async () => replies.shift()! };
  const { ui } = fakeUi({ handSet: async (s, v) => void handSet.push(`${s}=${v}`) });
  await new AgentRun(api, camera, ui, { maxShots: 3, askBeforeShooting: false, glasses: () => false, session: "t" }).start("HDR");
  assert.deepEqual(handSet, ["Adjust dyn range=Auto"]);
});
