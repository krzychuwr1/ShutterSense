// The simulated camera over HTTP, so the Android app (or curl) can drive it
// like a real body: `npm run sim`, then point the app at http://<this PC>:8080.
// Open the same address in a browser to watch the camera's screen and switch scenes.

import http from "node:http";
import os from "node:os";
import { VirtualCamera } from "../camsim/camera.ts";
import { handleSim } from "../camsim/control.ts";
import { SCENE_INFO } from "../camsim/scenes.ts";
import { encodeJpegNode } from "./jpeg-node.ts";
import { loadImageNode } from "./scene-files-node.ts";

const port = Number(process.env.PORT ?? 8080);
const scene = process.env.SCENE ?? "concert";
const cam = await VirtualCamera.create({ encodeJpeg: encodeJpegNode, now: () => Date.now(), loadImage: loadImageNode }, scene);

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated camera</title>
<style>body{font:15px system-ui;margin:16px;background:#111;color:#eee}img{width:100%;max-width:900px;display:block;border-radius:8px}
button{margin:8px 8px 0 0;padding:8px 12px;border-radius:6px;border:1px solid #555;background:#222;color:#eee;cursor:pointer}pre{color:#aaa}</style>
<h1>Simulated camera</h1><img id="lv"><div id="scenes"></div><pre id="st"></pre>
<script>
const scenes=${JSON.stringify(SCENE_INFO.map(({ id, title }) => ({ id, title })))};
for(const s of scenes){const b=document.createElement('button');b.textContent=s.title;b.onclick=()=>fetch('/sim/scene',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:s.id})});scenes_el.append(b)}
async function tick(){try{const r=await fetch('/sim/frame?w=600');lv.src=URL.createObjectURL(await r.blob());const s=await (await fetch('/sim/status')).json();
st.textContent=s.sceneTitle+'  ·  '+s.lens+'\n'+JSON.stringify(s.settings)+'\ncamera would use: '+s.exposure.av+' '+s.exposure.tv+' ISO '+s.exposure.isoValue+'\nshots: '+s.shots.length}catch{}setTimeout(tick,400)}
var scenes_el=document.getElementById('scenes');tick();
</script>`;

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: unknown;
  if (chunks.length) {
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Illegal JSON syntax" }));
      return;
    }
  }
  try {
    const headers: Record<string, string> = {};
    for (const k of ["range", "origin", "host"]) if (typeof req.headers[k] === "string") headers[k] = req.headers[k] as string;
    const out = await handleSim(cam, { method: req.method ?? "GET", path: url, body, headers });
    if (out.closed) {
      // The camera left the network: drop the connection without an answer.
      req.socket.destroy();
      return;
    }
    if (out.bytes) {
      res.writeHead(out.status, { ...out.headers, "content-type": out.contentType ?? "application/octet-stream", "content-length": out.bytes.length });
      res.end(Buffer.from(out.bytes));
    } else {
      res.writeHead(out.status, { ...out.headers, "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Internal error" }));
  }
  console.log(`${req.method} ${url} -> ${res.statusCode}`);
});

server.listen(port, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
  console.log(`Simulated camera (scene "${scene}") on port ${port}`);
  for (const ip of ips) console.log(`  CCAPI: http://${ip}:${port}/ccapi    screen: http://${ip}:${port}/`);
});
