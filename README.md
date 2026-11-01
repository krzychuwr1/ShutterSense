# Second Shooter

**An AI agent that works your camera for you.**

You say what you want from the shot: *"sharp shot of the dog, background blurred"*, *"she's backlit, fix it"*, *"make it moody"*. The agent does the rest. It looks through the camera's live view, changes the camera's settings, takes a test shot, looks at the photo it got, and tries again until the shot matches what you asked for. Then it tells you what it changed and why, in photography terms:

> She was underexposed against the bright sunset, so I switched to partial metering, opened up from f/5.6 to f/2.0 and set exposure compensation to +1 EV (+1⅔ EV proved too washed out). Her face is now properly bright with a soft background; the trade-off is a largely blown-out sky.

This isn't a chatbot that comments on photos. The agent operates a real mirrorless camera over Wi-Fi through Canon's Camera Control API (CCAPI) and checks its own work on the actual photo. With **Ray-Ban Display**, your eye stays at the viewfinder and your hands on the grip: the lens shows what the agent is doing and each settings change, and you correct it by voice ("a bit warmer").

## Try it without a camera

The web demo runs the phone app's agent loop in your browser against a **simulated camera** that speaks CCAPI:

1. `npm install`, then `npm run dev:worker` (it needs a Meta Model API key in `.dev.vars`, see [Setup](#setup)), and open http://127.0.0.1:8790.
2. Pick a scene on the right: **Backlit portrait**, **Dog running in the park** or **Birthday dinner indoors**. Each one starts with camera settings a photographer would recognise as wrong.
3. In the phone on the left, tap an example goal or type your own. Watch the step log: what the agent looks at, every settings change as a diff (`Shutter 1/60 s → 1/1000 s`), each test shot, and the final summary with a before/after slider. The camera's rear screen updates live as the agent changes settings, and **CCAPI traffic** lists every request the app sent.
4. While it works, or after it's done, type a correction: *"a bit warmer"*, *"keep more of the sky"*.
5. **Connect glasses → Open simulated glasses** opens the 600×600 glasses app. It pairs itself by swiping the arrow pattern, just as real glasses would. In that window the arrow keys are the D-pad, <kbd>Enter</kbd> opens "Tell the agent" (dictation on real glasses) and <kbd>Esc</kbd> is Back.

## How it works

```
 Camera (CCAPI: HTTP on the LAN)   or   simulated camera (same API)
      ▲
 Phone app ── runs the agent loop, executes every camera tool
 (Android, Kotlin/Compose; the web demo runs the same loop in TypeScript)
      │  HTTPS / WebSocket
 Cloudflare Worker + Durable Objects
      ├─ /api/agent       one stateless agent step, proxied to Muse (the API key never ships in the app)
      ├─ /api/transcribe  push-to-talk via Muse Voice Transcribe
      └─ rooms            phone ⇄ glasses relay, 8-arrow pairing
      │  WebSocket (SSE fallback)
 Glasses web app (Ray-Ban Display, 600×600): HUD + dictated corrections
```

**The agent loop runs on the phone**, because the phone is what can reach the camera. A browser can't call the camera's HTTP API: the request is cross-origin, and an HTTPS page can't call an HTTP device. Each step sends the compact transcript (only the latest three images attached), the goal and the shot budget to `/api/agent`. The worker adds the instructions and tool definitions, calls `muse-wonder-1.0`, and returns the tool calls for the phone to execute. Calls are stateless, so nothing expires mid-run.

**Tools** (executed on the phone, against the camera):

| Tool | What it does |
| --- | --- |
| `get_camera_state` | Mode, every changeable setting with its current value and the exact options the camera accepts now, camera-chosen values in auto modes, battery |
| `look` | One live-view frame, downscaled, plus brightness numbers |
| `set_settings` | Several changes at once, validated against the camera's ability lists. An invalid value returns a precise error listing the valid options. Allow-listed to exposure, white balance, metering, AF, drive and picture style; never storage, formats, network or power |
| `shoot` | Shutter (with or without AF), waits for the new file in event polling, downloads a display-size copy, and returns the photo, the exposure the camera actually used, and brightness numbers |
| `tell_user`, `ask_user` | Short notes and questions, shown on the phone and the lens |
| `finish` | The summary |

**Guardrails:** a shot budget per goal (5 by default), an optional "ask before shooting", a cancel button, and every settings change shown as a diff.

**Models:** `muse-wonder-1.0` for the agent and vision (images go into function outputs directly), `muse-voice-transcribe-1.0` for push-to-talk. Set `AGENT_MODEL` to try a faster model such as `muse-spark-1.3`.

### The CCAPI client

The client works the same way in TypeScript ([`ccapi/client.ts`](ccapi/client.ts)) and Kotlin (the Android app):

- Discovery through `GET /ccapi`. Which API version hosts an endpoint differs per camera model, so every call goes through the discovered list, and the highest version wins. It accepts the older absolute-URL form, and falls back to `topurlfordev` on activation-free cameras.
- Settings merged across the `ver100`/`ver110` bulk lists, and checked against each setting's ability list before any PUT. A setting the current mode doesn't use comes back empty.
- Mode changes on cameras with a physical dial switch on "ignore shooting mode dial" first.
- Live view with retries, the shutter with a fallback to the manual half/full press, event polling (`timeout=short` on `ver110`, `continue=off` on `ver100`), and downloads of `kind=display` with a fallback to `main`.
- In auto modes, the values the camera actually picked come from `effective_value_*` in event polling.
- Android only: optional digest auth, and HTTP or HTTPS, with the self-signed-certificate exception scoped to the camera client.

### The simulated camera

[`camsim/`](camsim) is a virtual mirrorless camera that answers CCAPI the way a camera with a physical mode dial does: discovery, per-mode emptied settings, `400 Invalid parameter`, `503 Device busy`, live view that must be started, files that show up in event polling. Its scenes are photographs split into layers at known distances (a background plate and cut-out subjects), turned into linear radiance calibrated in EV and rendered through a physically based pipeline:

- **Exposure** in real units: scene radiance is calibrated in EV, so f-number, shutter speed and ISO behave as on a real camera. Av/Tv/P/M and auto ISO are solved from a meter with evaluative, partial, spot and centre-weighted modes, so evaluative metering really does underexpose a backlit face.
- **Depth of field** from the thin-lens model, per layer at its real distance; lawns and table tops blur progressively with distance. Live view runs wide open, as on a real camera.
- **Motion blur** of moving subjects over the exposure time, **hand shake** that grows with shutter time and focal length, and **one-shot AF** lagging behind a moving subject (servo fixes it).
- **Noise** from shot and read noise that grows with ISO, **white balance** from colour temperature (the dinner really is lit at 2500 K, so auto white balance leaves it orange), light sources (sun, candle flames, lamps) far above white so they clip and glow, and picture styles.

The same simulator runs in a Web Worker for the browser demo, and as a plain HTTP server for testing the Android app without a camera: `npm run sim`, then point the app at `http://<your PC>:8080`. Open that address in a browser to see the camera's screen and switch scenes.

## Setup

**Camera access.** CCAPI must be enabled on the camera before any app can use it. Apply through Canon's developer programme (Canon Developer Community / CCAPI), then use Canon's activation tool to enable CCAPI on your body. In the camera's network menu, connect it to the same Wi-Fi as the phone and note its IP address; the default port is 8080. Canon's material is not included in this repository.

**Worker** (Cloudflare):

```bash
npm install
```

```bash
echo MUSE_API_KEY=your-key > .dev.vars
```

```bash
npm run dev:worker
```

To deploy, add the key as a secret and deploy. One Worker serves the web demo and the API:

```bash
npx wrangler secret put MUSE_API_KEY
```

```bash
npm run deploy
```

**Android app:** see [`android/README.md`](android/README.md). Enter the camera's IP (or the simulator's) and your worker's URL.

**Glasses:** with Developer Mode on Ray-Ban Display, install the deployed site as a web app. It opens straight to the pairing screen; tap **Connect glasses** on the phone and swipe the eight arrows it shows.

**Other commands:**

- `npm test`: unit tests (the CCAPI client against the simulator, exposure and metering, value formats, transcript pruning).
- `npm run e2e -- dog "Freeze the dog mid-stride"`: the real agent loop against the simulator from the command line, through a running worker.
- `npm run render-scenes -- out/`: renders the scenes to check them by eye, and refreshes the scene-picker thumbnails.
- `npm run prepare-scenes -- <dir>`: turns newly generated scene layers into the simulator's assets in `web/public/scenes/`.

## Repository

| Path | What |
| --- | --- |
| `android/` | The phone app (Kotlin, Jetpack Compose) |
| `agent/` | Agent loop and camera tools (TypeScript, used by the web demo) |
| `ccapi/` | CCAPI client (TypeScript) |
| `camsim/` | Simulated camera: scenes, renderer, CCAPI device |
| `shared/` | Contracts: agent API, phone⇄glasses protocol, CCAPI value formats |
| `worker/` | Cloudflare Worker: agent proxy, transcription, rooms, pairing, rate limits |
| `web/` | Web demo (phone app + simulator panel) and the glasses app |
| `tools/` | Simulator server, end-to-end runner, scene renders |

## Built during the hackathon

Everything in this repository was written during the Meta Global AI Developer Hackathon. That includes the CCAPI clients (TypeScript and Kotlin), the agent loop and tools, the Android app, the simulated camera and its renderer, the web demo, the glasses HUD and the worker's agent proxy.

The simulator's scene photographs (`web/public/scenes/`) are AI-generated, made during the hackathon: one photo per scene, then edits of it into a clean background plate and cut-out subjects. No real people are pictured.

Works with Canon cameras via CCAPI. Not affiliated with or endorsed by Canon.
