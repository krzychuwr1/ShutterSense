# Shutter Sense for Android

The phone app runs the agent: it talks to the camera over CCAPI on the local
network, sends each agent step to the worker (`/api/agent`, which holds the
Muse API key), executes the tool calls on the camera, and relays the HUD to
the glasses. Kotlin, Jetpack Compose, OkHttp.

| Package | What it does |
| --- | --- |
| `ccapi` | CCAPI client: discovery and per-version routing, settings with validation against the camera's options, mode dial override, live view, shutter, event polling, downloads, digest auth, HTTPS with the camera's self-signed certificate (trusted for the camera connection only) |
| `agent` | The agent loop and its camera tools (`get_camera_state`, `look`, `set_settings`, `shoot`, `menu_steps`, `save_preset`, `apply_preset`, `show_ideas`, `tell_user`, `ask_user`, `finish`), presets kept on the phone, image downscaling and brightness stats, the worker client |
| `glasses` | The phone side of the glasses room: HUD updates, arrow-pattern pairing, dictated corrections |
| `audio` | Push-to-talk recording (24 kHz mono WAV) for Muse Voice Transcribe |
| `sim` | The camera simulator on the phone (`SimulatedCamera`), for demos without a camera or a computer |
| `net` | Which network each kind of traffic uses (camera over Wi-Fi, agent server over a network with internet), joining the camera's own Wi-Fi for this app |
| `service` | The foreground service that keeps the session running with the screen locked |
| `ui` | Compose screens: `welcome` (first-launch tour), `setup` (demo or own camera, demo scene switcher), `connect` (address, SSDP discovery, login/HTTPS/server under Advanced), `agent` (the chat timeline), `camera` (manual control: live view, tap to focus, dials, shutter), `settings` (menu and glasses sheets), `components` (shared pieces, camera-style menu screens) |

The camera code mirrors the TypeScript used by the web demo
(`ccapi/client.ts`, `agent/camera-tools.ts`, `agent/loop.ts`,
`shared/settings.ts`): same routing rules, same validation messages, same tool
outputs.

## Build

Needs JDK 17+ (Android Studio's bundled JBR works) and the Android SDK
(compileSdk 36). Create `local.properties` with `sdk.dir=...` if Android
Studio hasn't, then:

```bash
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # JVM tests: CCAPI client against a mock camera, value parsing
```

Install with `adb install -r app/build/outputs/apk/debug/app-debug.apk`, or
open the `android` folder in Android Studio and run it.

## Run

The app opens with a short tour, then asks how to start:

- **Try the demo** runs a simulated camera on the phone (no camera needed).
  Pick a scene from the chip on the agent or camera screen; each scene comes
  with example goals.
- **Connect my camera**: enable CCAPI on the camera (Canon's developer
  programme) and join the same Wi-Fi as the phone. Cameras that answer SSDP
  are listed to tap; otherwise enter the IP (port 8080 unless changed). Login,
  HTTPS and the agent server URL are under *Advanced*.

The agent server (the worker that holds the Muse key) is set under
*Advanced* on the connect screen or in the menu (⋯): the deployed worker, or
`http://10.0.2.2:8790` in the emulator with `npm run dev:worker` on the host.

Then:

1. **Agent**: say or type a goal ("freeze the dog mid-stride"). Corrections typed
   or spoken while it works ("a bit warmer") go to the agent too. *Ask before
   each shot* and the shot budget are behind the sliders icon.
   Say "save this as club night" to keep the camera's settings as a preset,
   and "use my club night preset" later (or *Use* in the menu's *Presets*).
   "Give me pose ideas" shows pictured ideas to swipe through, on the lens too.
2. **Camera**: manual control. Live view (tap to move the AF point), swipe the
   value strip for mode, aperture, shutter, ISO and exposure compensation
   (values the mode leaves to the camera are greyed), and the shutter. Paused
   while the agent works.
3. **Glasses (optional)**: tap the glasses icon, then on Ray-Ban Display open
   the Shutter Sense web app and swipe the eight arrows the phone shows.

Folded, Agent and Camera sit behind a segmented control; unfolded (or any
window 680 dp wide or more), the camera and the chat are side by side.

## Testing against the simulator

```bash
npm run sim                                  # in the repo root
SIM_URL=http://127.0.0.1:8080 ./gradlew testDebugUnitTest --tests '*SimulatorSmokeTest*'
```

This drives the simulated camera end to end with the Kotlin client: discovery,
camera state, live view, a mode change through the dial override, a shot, the
new file from event polling, and the download.

## Simulator on the phone

`sim.SimulatedCamera` runs the TypeScript camera simulator (`camsim/`) inside
the app, so a demo needs neither a camera nor a computer. `start()` it, then
hand `transport` to `CcapiClient` as you would a real camera's; `scenes()`,
`setScene()` and `thumbnail()` drive the scene picker.

How it works: the simulator is bundled as a small page, `web/sim-host`
(`npm run build:sim` in the repository root writes it to
`app/src/main/assets/sim`). The app loads it from the APK through
`WebViewAssetLoader` in a WebView that is never put on screen; the camera runs
in a web worker inside that page. Each request is an `evaluateJavascript` call
and each answer comes back through a `@JavascriptInterface` callback with the
body in base64 (about 10 ms per round trip; nearly all of a frame's time is
the simulator rendering it). The page never touches the network.

- **The page bundle is committed** (`app/src/main/assets/sim`, about 90 KB),
  so building the app needs no Node. Rebuild it with `npm run build:sim`
  whenever `camsim/` changes, in particular when scenes are added; the
  instrumented test fails if the scene list in the bundle and the scene
  images in the APK disagree.
- **Scene images are not committed twice.** The `copySimScenes` Gradle task
  copies `../web/public/scenes` (layers and picker thumbnails) into
  `app/build/generated/...` as an extra asset folder on every build, so a new
  scene's images reach the APK without any step. They add about 6 MB to the
  APK.
- A WebView that isn't attached to a window is not throttled: on the emulator
  the page reports itself visible and its timers and the worker's fire on
  time (`timersKeepRunningOffScreen` checks this), so the simulated subjects
  keep moving. Nothing pauses it when the app goes to the background either,
  so close it when the demo ends.

On-device tests (an emulator is fine):

```bash
ANDROID_SERIAL=emulator-5554 ./gradlew connectedDebugAndroidTest
```

`SimulatedCameraTest` starts the simulator and drives it with the Kotlin
client: discovery, settings, live view, an aperture change, a shot with its
download, and scene switching. Timings go to logcat under the tag `SimTest`.
