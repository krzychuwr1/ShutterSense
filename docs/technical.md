# Shutter Sense: technical notes

The detail behind the [README](../README.md).

## The demo, step by step

1. Open https://shuttersense.pages.dev/try. To run it yourself instead: `npm install`, then `npm run dev:worker` (it needs a Meta Model API key in `.dev.vars`, see [Setup](#setup)), open http://127.0.0.1:8790 and click **Try the simulated experience**.
2. Pick a scene: **Club gig under LED lights**, **Basketball under fluorescent lights**, **Portrait in deep shade, sunlit meadow**, **Dog running in the park**, **Group portrait in the shade** or **Birthday dinner indoors**. Each one starts with camera settings a photographer would recognise as wrong, and several need a setting most people never touch. The deep-shade portrait needs HDR Mode, which the control API can't switch on: the agent shows you the way through the camera's menus, and tapping **Done** sets it on the simulated body.
3. In the phone on the left, tap an example goal or type your own. Watch the step log: what the agent looks at, every settings change as a diff (`Shutter 1/60 s → 1/1000 s`), each test shot, and the final summary with a before/after slider. The camera's rear screen updates live as the agent changes settings.
4. While it works, or after it's done, type a correction: *"a bit warmer"*, *"keep more of the sky"*. Ask for ideas (*"suggest a few other poses for her"*) and the agent shows pictures of the scene re-imagined in each pose, on the phone and the lens. Say *"save this as club night"* to keep the settings as a preset, and *"use my club night preset"* later (**Presets** on the phone lists them).
5. **Connect simulated glasses**, next to the camera's rear screen, loads the 600×600 glasses app into a lens on the page. It pairs itself by swiping the phone's arrow pattern, just as real glasses would, then shows each step, settings change and shot. The buttons under it are the Neural Band's gestures: arrows to move, ● to select or dictate ("Tell the agent"), Back. With the lens focused, the arrow keys, <kbd>Enter</kbd> and <kbd>Esc</kbd> work too.

## The agent

**The agent loop runs on the phone**, because the phone is what can reach the camera. A browser can't call the camera's HTTP API: the request is cross-origin, and an HTTPS page can't call an HTTP device. Each step sends the compact transcript (only the latest three images attached), the goal and the shot budget to `/api/agent`. The worker adds the instructions and tool definitions, calls `muse-wonder-1.0`, and returns the tool calls for the phone to execute. Calls are stateless, so nothing expires mid-run.

**Tools** (executed on the phone, against the camera):

| Tool | What it does |
| --- | --- |
| `get_camera_state` | Mode, every changeable setting with its current value and the exact options the camera accepts now, camera-chosen values in auto modes, battery |
| `look` | One live-view frame, downscaled, plus brightness numbers; optionally magnified 5× or 10× around the AF point to check focus |
| `set_settings` | Several changes at once, validated against the camera's ability lists. An invalid value returns a precise error listing the valid options. Allow-listed to exposure, white balance (and WB shift), metering, AF and tracking, drive, flash, shutter type, aspect ratio, picture style and its contrast, saturation, sharpness and colour tone; never storage, formats, network or power |
| `focus` | Puts the AF point on a spot in the frame (switching tracking AF to 1-point), for when autofocus picks the wrong thing |
| `detect_flicker` | Runs the camera's flicker detection: mains flicker, or high-frequency LED flicker, where it also picks a shutter speed that spans whole LED periods |
| `menu_steps` | For a setting the control API can't reach: shows the camera's real menu screens down to the value to choose, and waits until the photographer has set it. The screens come from a menu map in the worker, never from the model |
| `shoot` | Shutter (with or without AF), waits for the new file in event polling, downloads a display-size copy, and returns the photo, the exposure the camera actually used, and brightness numbers |
| `save_preset`, `apply_preset` | Saves the camera's current settings under a name, on the phone (with any menu settings set by hand, such as HDR Mode); applies one later. The agent sees each saved preset in one line |
| `show_ideas` | Two to four ideas for the shot (poses, arrangements, angles) with what to tell the people, each pictured by the image model: the live view re-imagined with the same people and place, or a picture from the prompt alone for general inspiration |
| `tell_user`, `ask_user` | Short notes and questions, shown on the phone and the lens |
| `finish` | The summary |

**Guardrails:** a shot budget per goal (5 by default), an optional "ask before shooting", a cancel button, and every settings change shown as a diff.

**Models:** `muse-wonder-1.0` for the agent and vision (images go into function outputs directly), `muse-voice-transcribe-1.0` for push-to-talk, `muse-image-1.0` for idea pictures (`IMAGE_MODEL` overrides it). Set `AGENT_MODEL` to try a faster model such as `muse-spark-1.3`.

## The CCAPI client

The client works the same way in TypeScript ([`ccapi/client.ts`](../ccapi/client.ts)) and Kotlin (the Android app):

- Discovery through `GET /ccapi`. Which API version hosts an endpoint differs per camera model, so every call goes through the discovered list, and the highest version wins. It accepts the older absolute-URL form, and falls back to `topurlfordev` on activation-free cameras.
- Settings merged across the `ver100`/`ver110` bulk lists, and checked against each setting's ability list before any PUT. A setting the current mode doesn't use comes back empty.
- Mode changes on cameras with a physical dial switch on "ignore shooting mode dial" first.
- Live view with retries, the shutter with a fallback to the manual half/full press, event polling (`timeout=short` on `ver110`, `continue=off` on `ver100`), and downloads of `kind=display` with a fallback to `main`.
- In auto modes, the values the camera actually picked come from `effective_value_*` in event polling.
- Every other endpoint has a typed method too: device status, storage, clock and other camera functions, picture style detail and WB shift, AF start/stop, focus steps, the AF point, magnified live view and live-view info (histogram, AF frames), live-view streams, movie mode and recording, event monitoring, and contents browsing, paging, file info, range downloads, rotate/protect/rate and delete, text functions (CORS origin, the HTTPS certificate's common name, file name parts), and the network setups of multi-network bodies (communication, function and connection settings, read from their own endpoint list).
- Android only: optional digest auth, and HTTP or HTTPS, with the self-signed-certificate exception scoped to the camera client.

## The simulated camera

[`camsim/`](../camsim) is a virtual mirrorless camera that answers CCAPI the way a camera with a physical mode dial does: discovery, per-mode emptied settings, `400 Invalid parameter`, `503 Device busy`, live view that must be started, files that show up in event polling. Its scenes are photographs split into layers at known distances (a background plate and cut-out subjects), turned into linear radiance calibrated in EV and rendered through a physically based pipeline:

- **Exposure** in real units: scene radiance is calibrated in EV, so f-number, shutter speed and ISO behave as on a real camera. Av/Tv/P/M and auto ISO are solved from a meter with evaluative, partial, spot and centre-weighted modes, so a bright LED wall or window really does pull evaluative metering down.
- **Depth of field** from the thin-lens model, per layer at its real distance; lawns and table tops blur progressively with distance. Live view previews the depth of field at the shooting aperture, so the rear screen matches the shot.
- **Motion blur** of moving subjects over the exposure time, **hand shake** that grows with shutter time and focal length, and **one-shot AF** lagging behind a moving subject (servo fixes it).
- **Noise** from shot and read noise that grows with ISO, **white balance** from colour temperature (the dinner really is lit at 2500 K, so auto white balance leaves it orange), light sources (sun, candle flames, lamps) far above white so they clip and glow, and picture styles with their fine-tuning.
- **Flicker** from mains-powered tubes (a 100/120 Hz ripple that also shifts colour) and LED dimming: each row integrates the light over its own exposure window as the shutter crosses the frame, so short exposures change brightness from shot to shot and the electronic shutter shows bands. Anti-flicker shooting times the shot to the light's peak; high-frequency anti-flicker offers fine-step shutter speeds that last a whole number of LED periods; flicker detection reports the frequency.
- **HDR Mode**, which the control API can't reach: once the photographer sets it in the menus (`POST /sim/menu`), each shot merges the brackets as a local tone map, lifting a face in deep shade without burning the sunlit background behind it. Live view stays a single exposure, as on the real camera.
- **Flash beyond the API:** high-speed sync and flash exposure compensation are menu settings too. With high-speed sync the flash works above 1/200 s, at a stop less power for each stop faster; flash compensation moves the flash without the ambient exposure. The flash's light doesn't flicker and isn't smeared by motion, so where it dominates, a subject under LED stage light comes out sharp and free of bands.
- **The rest of the body:** flash with distance fall-off and sync speed, exposure and white-balance bracketing, continuous drive and self-timers, the AF point and zone AF, manual focus steps, magnified live view with histogram and AF frames, aspect ratios, RAW files, an electronic shutter that skews fast motion, movie recording (Motion-JPEG), and a card you can browse, protect, delete from and format. Event polling reports every change.

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

**Deploying.** The live site is on Cloudflare Pages at https://shuttersense.pages.dev: the web app plus the API as a Pages Function ([`pages/`](../pages)). The rooms, pairing, rate limits and budget are Durable Objects in a private Worker, `shuttersense-core` ([`wrangler.jsonc`](../wrangler.jsonc)), which has no public URL; the Pages Function binds to them. The first time, create the Pages project and add the key to it:

```bash
cd pages && npx wrangler pages project create shuttersense --production-branch main --force
```

```bash
cd pages && npx wrangler pages secret put MUSE_API_KEY --project-name shuttersense
```

Then each deploy builds the site, updates the private Worker and publishes the Pages project:

```bash
npm run deploy
```

**Voice on the glasses (optional):** the lens reads the agent's notes aloud. For natural speech, create an app on [Wit.ai](https://wit.ai) (Meta's voice service) and add its Server Access Token as `WIT_TOKEN` in `.dev.vars`, or with `npx wrangler pages secret put WIT_TOKEN --project-name shuttersense` when deployed. `WIT_VOICE` picks the voice (default `wit$Rebecca`; `GET https://api.wit.ai/voices` lists them). Without a token, the lens uses the device's own voice.

**Android app:** see [`android/README.md`](../android/README.md). It talks to https://shuttersense.pages.dev by default; "Try the demo" runs the simulated camera on the phone itself, or connect a real camera by IP.

**Glasses:** with Developer Mode on Ray-Ban Display, install the deployed site as a web app. It opens straight to the pairing screen; tap **Connect glasses** on the phone and swipe the eight arrows it shows.

**Other commands:**

- `npm test`: unit tests (the CCAPI client against the simulator, exposure and metering, value formats, transcript pruning).
- `npm run e2e -- dog "Freeze the dog mid-stride"`: the real agent loop against the simulator from the command line, through a running worker.
- `npm run render-scenes -- out/`: renders the scenes to check them by eye, and refreshes the scene-picker thumbnails.
- `npm run prepare-scenes -- <dir> [scene ...]`: turns newly generated scene layers into the simulator's assets in `web/public/scenes/`.

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
