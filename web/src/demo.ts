// The judge-facing demo page: the phone app on the left, the simulated
// camera it drives on the right.

import { CameraTools } from "../../agent/camera-tools.ts";
import { CcapiClient } from "../../ccapi/client.ts";
import { el } from "./dom.ts";
import { browserImages } from "./images.ts";
import { CameraPanel } from "./panel.ts";
import { PhoneApp } from "./phone.ts";
import { SimLink } from "./sim/link.ts";

export async function startDemo(root: HTMLElement) {
  document.body.className = "demo-body";
  const link = new SimLink();
  const tools = new CameraTools(new CcapiClient(link.transport()), browserImages);
  let phone: PhoneApp | null = null;
  const panel = new CameraPanel(link, () => void phone?.cameraChanged());
  phone = new PhoneApp(tools, { goals: () => panel.goals(), cameraLabel: "Simulated camera (built in)" });

  root.replaceChildren(
    el("header", { class: "site-head" }, [
      el("div", { class: "brand" }, [
        el("img", { src: "/favicon.svg", alt: "", width: "32", height: "32" }),
        el("div", {}, [el("h1", {}, ["Second Shooter"]), el("p", {}, ["An AI agent that works your camera for you."])]),
      ]),
      el("p", { class: "lede" }, [
        "Say what you want from the shot. The agent looks through the camera, changes its settings, takes a test shot, checks the photo and tries again until it matches, then tells you what it changed and why. ",
        el("strong", {}, ["Try it here without a camera: "]),
        "pick a scene in the simulated camera, then tap an example goal in the phone.",
      ]),
    ]),
    el("main", { class: "demo" }, [
      el("section", { class: "phone-col", "aria-label": "Phone app" }, [
        el("div", { class: "phone-frame" }, [phone.root]),
        el("p", { class: "caption muted" }, ["The Android app, running in your browser against the simulated camera. With a real camera it runs on the phone, over Wi-Fi."]),
      ]),
      el("section", { class: "camera-col", "aria-label": "Simulated camera" }, [panel.root]),
    ]),
    el("footer", { class: "site-foot muted" }, [
      "Built for the Meta Global AI Developer Hackathon with Muse models (muse-wonder-1.0 agent and vision, muse-voice-transcribe-1.0). Works with Canon cameras via CCAPI; not affiliated with Canon.",
    ]),
  );

  await panel.start();
  phone.cameraChanged();
}
