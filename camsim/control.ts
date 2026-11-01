// Simulator-only endpoints next to CCAPI, for the demo UI (never used by the agent):
//   GET  /sim/status          scene, settings, the exposure the camera would use, shots
//   GET  /sim/scenes          scene list with suggested goals
//   POST /sim/scene {id}      switch scene (settings reset to that scene's starting point)
//   GET  /sim/frame?w=600     what the camera's rear screen shows now
//   GET  /sim/shot/<n>        a past shot's details

import type { SimRequest, SimResponse, VirtualCamera } from "./camera.ts";
import { SCENE_INFO } from "./scenes.ts";

export async function handleSim(cam: VirtualCamera, req: SimRequest): Promise<SimResponse> {
  const [pathname, query = ""] = req.path.split("?");
  const params = new URLSearchParams(query);
  const m = req.method.toUpperCase();
  if (!pathname.startsWith("/sim/")) return cam.handle(req);
  if (pathname === "/sim/status" && m === "GET") return { status: 200, json: cam.status() };
  if (pathname === "/sim/scenes" && m === "GET") return { status: 200, json: SCENE_INFO };
  if (pathname === "/sim/scene" && m === "POST") {
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !SCENE_INFO.some((s) => s.id === id)) return { status: 400, json: { message: "Unknown scene" } };
    await cam.setScene(id);
    return { status: 200, json: cam.status() };
  }
  if (pathname === "/sim/frame" && m === "GET") {
    const w = Number(params.get("w")) || 600;
    return { status: 200, bytes: await cam.frame([150, 300, 600, 1200].includes(w) ? w : 600), contentType: "image/jpeg" };
  }
  return { status: 404, json: { message: "URL not found" } };
}
