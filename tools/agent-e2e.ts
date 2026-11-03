// Runs the real agent loop against the simulated camera from the command
// line, through a running worker: `npm run dev:worker` in one terminal, then
// `npm run e2e -- <scene> "<goal>" [outDir]`. Prints each step; saves shots.

import fs from "node:fs";
import path from "node:path";
import { CcapiClient } from "../ccapi/client.ts";
import { CameraTools } from "../agent/camera-tools.ts";
import { AgentRun, type AgentApi } from "../agent/loop.ts";
import type { Preset } from "../shared/agent-api.ts";
import { VirtualCamera } from "../camsim/camera.ts";
import { simTransport } from "../camsim/transport.ts";
import { encodeJpegNode } from "./jpeg-node.ts";
import { loadImageNode } from "./scene-files-node.ts";
import { nodeImages } from "./image-node.ts";

const [scene = "concert", goal = "Shoot silently, but get rid of the dark stripes", out = "e2e-out"] = process.argv.slice(2);
const base = process.env.WORKER ?? "http://127.0.0.1:8790";
fs.mkdirSync(out, { recursive: true });

const cam = await VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => Date.now(), loadImage: loadImageNode }, scene);
const tools = new CameraTools(new CcapiClient(simTransport((r) => cam.handle(r))), nodeImages);
console.log("camera:", await tools.connect());

const api: AgentApi = {
  async step(req, signal) {
    const t = Date.now();
    const res = await fetch(`${base}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal });
    const data = (await res.json()) as { error?: string };
    console.log(`  (model ${Date.now() - t} ms)`);
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data as never;
  },
  async inspire(req, signal) {
    const t = Date.now();
    const res = await fetch(`${base}/api/inspire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal });
    const data = (await res.json()) as { error?: string; image?: string };
    console.log(`  (picture ${Date.now() - t} ms)`);
    if (!res.ok || !data.image) throw new Error(data.error ?? `HTTP ${res.status}`);
    return { image: data.image };
  },
};

let presets: Preset[] = [];
let ideas = 0;

const started = Date.now();
const run = new AgentRun(api, tools, {
  status: () => {},
  step: (e) => {
    console.log(`[${e.kind}] ${e.text}${e.detail?.length ? `\n    ${e.detail.join("\n    ")}` : ""}${e.errors?.length ? `\n    ! ${e.errors.join("\n    ! ")}` : ""}`);
    for (const idea of e.ideas ?? []) {
      console.log(`    idea: ${idea.title}: ${idea.direction}${idea.image ? "" : " (no picture)"}`);
      if (idea.image) fs.writeFileSync(path.join(out, `${scene}-idea${++ideas}.jpg`), Buffer.from(idea.image.split(",")[1], "base64"));
    }
  },
  shot: (r) => fs.writeFileSync(path.join(out, `${scene}-shot${r.n}.jpg`), r.jpeg),
  exposure: () => {},
  confirmShot: async () => true,
  ask: async (q, options) => {
    console.log(`  (auto-answering "${q}" with "${options[0] ?? "yes"}")`);
    return options[0] ?? "yes";
  },
  // As if the photographer pressed the buttons on the body.
  handSet: async (setting, value) => console.log(`  (set by hand: ${setting} = ${value}, ${cam.handSet(setting, value) ? "applied" : "not simulated"})`),
  ended: (outcome) => console.log(`== ${outcome} in ${((Date.now() - started) / 1000).toFixed(1)} s, ${run.shotsTaken} shots`),
}, {
  maxShots: 5,
  askBeforeShooting: false,
  glasses: () => false,
  session: "e2e",
  presets: { list: () => presets, save: (p) => void (presets = [...presets.filter((q) => q.name !== p.name), p]) },
});
await run.start(goal);
