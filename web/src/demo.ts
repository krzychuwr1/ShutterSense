// The simulated experience: the phone app on the left; on the right the
// camera it drives, with the glasses' lens next to the camera's rear screen.

import { CameraTools } from "../../agent/camera-tools.ts";
import { CcapiClient } from "../../ccapi/client.ts";
import { icon, sprite, use } from "./brand.ts";
import { el, h } from "./dom.ts";
import { browserImages } from "./images.ts";
import { CameraPanel } from "./panel.ts";
import { PhoneApp } from "./phone.ts";
import { SimLink } from "./sim/link.ts";

/** The Neural Band's gestures, as keys the glasses app understands. */
const PAD: Array<[string, string, string]> = [
  ["ArrowUp", "↑", "Swipe up"],
  ["ArrowLeft", "←", "Swipe left"],
  ["Enter", "●", "Pinch (select / dictate)"],
  ["ArrowRight", "→", "Swipe right"],
  ["ArrowDown", "↓", "Swipe down"],
];

const VOICE_KEY = "shuttersense:lensVoice";

/** The simulated Ray-Ban Display lens, paired on request, with an on-screen D-pad. */
function glassesView(connect: () => Promise<void>) {
  const lens = el("div", { class: "glasses-lens" });
  let frame: HTMLIFrameElement | null = null;
  const key = (k: string) => frame?.contentWindow?.postMessage({ type: "sim-key", key: k }, location.origin);
  const pad = el(
    "div",
    { class: "glasses-pad", hidden: true },
    [
      ...PAD.map(([k, label, title]) => el("button", { class: `pad-${k}`, type: "button", title, "aria-label": title, onclick: () => key(k) }, [label])),
      el("button", { class: "pad-back", type: "button", title: "Back", onclick: () => key("Escape") }, ["Back"]),
    ],
  );
  const start = el("button", { class: "btn primary small", type: "button" }, ["Connect simulated glasses"]);
  const note = el("p", { class: "glasses-note" }, ["Pairs the lens with the phone, as real glasses would: it swipes the phone's arrow pattern."]);
  start.addEventListener("click", async () => {
    start.disabled = true;
    start.textContent = "Pairing…";
    try {
      await connect();
    } catch (e) {
      start.disabled = false;
      start.textContent = "Connect simulated glasses";
      note.textContent = e instanceof Error ? e.message : "Could not start a session";
    }
  });
  lens.append(el("div", { class: "glasses-idle" }, [icon("i-glasses", "glasses-art"), start, note]));
  const hint = el("p", { class: "pad-hint", hidden: true }, ["The Neural Band's swipes and pinch"]);

  // The lens can speak the agent's notes; embedded here it stays silent until asked.
  let voiceOn = false;
  try {
    voiceOn = localStorage.getItem(VOICE_KEY) === "1";
  } catch {
    // storage unavailable: voice starts off
  }
  const sendVoice = () => frame?.contentWindow?.postMessage({ type: "sim-sound", on: voiceOn }, location.origin);
  const voice = el("input", { type: "checkbox", checked: voiceOn });
  voice.addEventListener("change", () => {
    voiceOn = voice.checked;
    try {
      localStorage.setItem(VOICE_KEY, voiceOn ? "1" : "0");
    } catch {
      // storage unavailable: setting lasts for this page only
    }
    sendVoice();
  });

  const root = el("section", { class: "panel-card glasses-card", "aria-label": "Glasses" }, [
    el("div", { class: "card-head" }, [
      el("div", {}, [el("h3", {}, ["Glasses"]), el("div", { class: "card-sub" }, ["Ray-Ban Display lens, simulated"])]),
      el("label", { class: "toggle voice-toggle", title: "Let the lens speak the agent's notes" }, [voice, "Voice"]),
    ]),
    lens,
    pad,
    hint,
  ]);

  /** Loads the glasses app into the lens and returns its window for pairing. */
  const show = (url: string): Window | null => {
    if (!frame) {
      frame = el("iframe", { title: "Simulated glasses lens", src: url, allow: "microphone; autoplay" });
      frame.addEventListener("load", sendVoice);
      lens.replaceChildren(frame);
      pad.hidden = hint.hidden = false;
    } else frame.src = url;
    return frame.contentWindow;
  };
  return { root, show };
}

export async function startDemo(root: HTMLElement) {
  document.body.className = "demo-body";
  const link = new SimLink();
  const tools = new CameraTools(new CcapiClient(link.transport()), browserImages);
  let phone: PhoneApp | null = null;
  const glasses = glassesView(() => phone!.connectSimGlasses());
  const panel = new CameraPanel(link, () => void phone?.cameraChanged(), glasses.root);
  phone = new PhoneApp(tools, { goals: () => panel.goals(), cameraLabel: "Simulated camera (built in)", simGlasses: glasses.show });

  root.replaceChildren(
    sprite(),
    el("header", { class: "try-top" }, [
      el("div", { class: "wrap" }, [
        h(`<a class="brand" href="/">${use("logo", "logo")}Shutter Sense</a>`),
        el("span", { class: "try-pill" }, ["Simulated experience"]),
        el("a", { class: "btn ghost small", href: "/#how" }, ["How it works"]),
      ]),
    ]),
    el("section", { class: "try-intro" }, [
      el("div", { class: "wrap" }, [
        h(`<h1>Say what you want. <span>Watch it work the camera.</span></h1>`),
        el("p", { class: "try-lede" }, [
          "Everything here runs in your browser: the phone app, the camera it controls and the glasses' lens. ",
          el("strong", {}, ["Pick a scene, then tap an example goal in the phone."]),
          " The agent changes what the camera's API allows itself, and walks you through the menus for the rest.",
        ]),
      ]),
    ]),
    el("main", { class: "demo wrap" }, [
      el("section", { class: "phone-col", "aria-label": "Phone app" }, [
        el("div", { class: "phone-frame" }, [phone.root]),
        el("p", { class: "phone-caption" }, ["The Android app's agent, running in your browser. With a real camera it runs on the phone, over Wi-Fi."]),
      ]),
      el("section", { class: "camera-col", "aria-label": "Camera and glasses" }, [panel.root]),
    ]),
    el("footer", { class: "try-foot" }, [
      el("div", { class: "wrap" }, [
        "Built for the Meta Global AI Developer Hackathon with Muse models (muse-wonder-1.0 agent and vision, muse-voice-transcribe-1.0). Works with Canon cameras via CCAPI; not affiliated with Canon.",
      ]),
    ]),
  );

  await panel.start();
  phone.cameraChanged();
}
