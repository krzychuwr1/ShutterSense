# Second Shooter for Android

The phone app runs the agent: it talks to the camera over CCAPI on the local
network, sends each agent step to the worker (`/api/agent`, which holds the
Muse API key), executes the tool calls on the camera, and relays the HUD to
the glasses. Kotlin, Jetpack Compose, OkHttp.

| Package | What it does |
| --- | --- |
| `ccapi` | CCAPI client: discovery and per-version routing, settings with validation against the camera's options, mode dial override, live view, shutter, event polling, downloads, digest auth, HTTPS with the camera's self-signed certificate (trusted for the camera connection only) |
| `agent` | The agent loop and its camera tools (`get_camera_state`, `look`, `set_settings`, `shoot`, `tell_user`, `ask_user`, `finish`), image downscaling and brightness stats, the worker client |
| `glasses` | The phone side of the glasses room: HUD updates, arrow-pattern pairing, dictated corrections |
| `audio` | Push-to-talk recording (24 kHz mono WAV) for Muse Voice Transcribe |
| `ui` | Compose screens |

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

1. **Agent server.** Under *HTTPS, login, server* on the connect card, set the
   worker URL: the deployed worker, or `http://10.0.2.2:8790` in the emulator
   with `npm run dev:worker` running on the host.
2. **Camera.** Enable CCAPI on the camera (Canon's developer programme), join
   the same Wi-Fi as the phone, and enter the camera's IP (port 8080 unless
   changed). Fill in username and password if CCAPI accounts are set up, and
   switch on HTTPS if the camera uses it.
3. **No camera?** Run the simulator on a computer on the same network:
   `npm run sim` in the repository root. It serves a simulated camera on port
   8080 and prints the address to enter in the app; open that address in a
   browser to watch the simulated camera's screen and switch scenes.
4. Say or type a goal ("she's backlit, fix it"). Corrections typed or spoken
   while it works ("a bit warmer") go to the agent too.
5. **Glasses (optional).** Tap *Glasses*, then on Ray-Ban Display open the
   Second Shooter web app and swipe the eight arrows the phone shows.

## Testing against the simulator

```bash
npm run sim                                  # in the repo root
SIM_URL=http://127.0.0.1:8080 ./gradlew testDebugUnitTest --tests '*SimulatorSmokeTest*'
```

This drives the simulated camera end to end with the Kotlin client: discovery,
camera state, live view, a mode change through the dial override, a shot, the
new file from event polling, and the download.
