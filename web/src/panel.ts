// The simulated camera, as the judge sees it: pick a scene, watch the
// camera's rear screen (live, with its settings display), see the photos on
// its card, and every CCAPI request the app sends it.

import type { SimStatus } from "../../camsim/camera.ts";
import { evStops, prettyValue } from "../../shared/settings.ts";
import { el } from "./dom.ts";
import { blobUrl } from "./images.ts";
import type { SimLink, TrafficEntry } from "./sim/link.ts";

export interface SceneInfo {
  id: string;
  title: string;
  blurb: string;
  goals: string[];
}

const METERING: Record<string, string> = { evaluative: "Evaluative", partial: "Partial", spot: "Spot", center_weighted_average: "Centre-weighted" };
const AF: Record<string, string> = { oneshot: "One Shot", servo: "Servo", aifocus: "AI Focus" };

export class CameraPanel {
  readonly root: HTMLElement;
  scenes: SceneInfo[] = [];
  scene = "backlit";
  private link: SimLink;
  private onScene: (id: string) => void;
  private sceneList: HTMLElement;
  private lv: HTMLImageElement;
  private osdTop: HTMLElement;
  private osdBottom: HTMLElement;
  private meterEl: HTMLElement;
  private card: HTMLElement;
  private traffic: HTMLElement;
  private trafficCount = 0;
  private lastOsd = new Map<string, string>();
  private shotThumbs = new Map<string, string>();
  private lvUrl: string | null = null;
  private busy: HTMLElement;

  constructor(link: SimLink, onScene: (id: string) => void) {
    this.link = link;
    this.onScene = onScene;
    this.sceneList = el("div", { class: "scenes", role: "radiogroup", "aria-label": "Scene" });
    this.lv = el("img", { class: "lv", alt: "The simulated camera's rear screen" });
    this.osdTop = el("div", { class: "osd top" });
    this.osdBottom = el("div", { class: "osd bottom" });
    this.meterEl = el("div", { class: "meter", title: "Exposure level relative to the camera's meter" });
    this.busy = el("div", { class: "busy-flash" });
    this.card = el("div", { class: "card-strip" }, [el("span", { class: "muted" }, ["No photos yet."])]);
    this.traffic = el("ol", { class: "traffic" });

    this.root = el("div", { class: "camera-panel" }, [
      el("div", { class: "panel-head" }, [
        el("h2", {}, ["Simulated camera"]),
        el("p", { class: "muted" }, [
          "A virtual mirrorless camera that speaks Canon's Camera Control API (CCAPI). The app talks to it exactly as it talks to a real body over Wi-Fi: same endpoints, same values. Exposure, metering, white balance, depth of field, motion blur, hand shake and noise are simulated physically.",
        ]),
      ]),
      el("h3", {}, ["1 · Pick a scene"]),
      this.sceneList,
      el("h3", {}, ["Rear screen ", el("span", { class: "muted small" }, ["(live view, exposure simulation)"])]),
      el("div", { class: "screen" }, [this.lv, this.osdTop, this.osdBottom, this.meterEl, this.busy]),
      el("h3", {}, ["Memory card"]),
      this.card,
      el("details", { class: "traffic-box" }, [el("summary", {}, ["CCAPI traffic ", el("span", { class: "muted small" }, ["requests the app sent"])]), this.traffic]),
    ]);
    link.onTraffic((e) => this.addTraffic(e));
  }

  async start() {
    const res = await this.link.request("GET", "/sim/scenes");
    this.scenes = res.json as SceneInfo[];
    this.renderScenes();
    void this.frameLoop();
    void this.statusLoop();
  }

  goals(): string[] {
    return this.scenes.find((s) => s.id === this.scene)?.goals ?? [];
  }

  private renderScenes() {
    this.sceneList.replaceChildren(
      ...this.scenes.map((s) => {
        const b = el("button", { class: `scene${s.id === this.scene ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(s.id === this.scene) }, [
          el("img", { src: `/scenes/${s.id}.jpg`, alt: "" }),
          el("span", { class: "scene-text" }, [el("strong", {}, [s.title]), el("span", {}, [s.blurb])]),
        ]);
        b.addEventListener("click", () => void this.pick(s.id));
        return b;
      }),
    );
  }

  private async pick(id: string) {
    if (id === this.scene) return;
    this.scene = id;
    this.renderScenes();
    await this.link.request("POST", "/sim/scene", { id });
    this.shotThumbs.clear();
    this.onScene(id);
  }

  private async frameLoop() {
    for (;;) {
      if (document.visibilityState === "visible") {
        try {
          const res = await this.link.request("GET", "/sim/frame?w=600");
          if (res.bytes) {
            const url = blobUrl(res.bytes);
            this.lv.src = url;
            if (this.lvUrl) URL.revokeObjectURL(this.lvUrl);
            this.lvUrl = url;
          }
        } catch {
          // keep the last frame
        }
      }
      await new Promise((r) => setTimeout(r, 180));
    }
  }

  private async statusLoop() {
    for (;;) {
      try {
        const res = await this.link.request("GET", "/sim/status");
        await this.renderStatus(res.json as SimStatus);
      } catch {
        // try again
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async renderStatus(s: SimStatus) {
    const st = s.settings;
    const mode = String(st.shootingmode);
    const e = s.exposure;
    const tv = mode === "tv" || mode === "m" ? String(st.tv) : e.tv;
    const av = mode === "av" || mode === "m" ? String(st.av) : e.av;
    const iso = st.iso === "auto" ? `AUTO ${e.isoValue}` : String(st.iso);
    const wb = st.wb === "colortemp" ? `${st.colortemperature}K` : String(st.wb).toUpperCase();
    const comp = String(st.exposure);
    this.osd(this.osdTop, [
      ["mode", prettyValue("shootingmode", mode)],
      ["metering", METERING[String(st.metering)] ?? String(st.metering)],
      ["af", `${AF[String(st.afoperation)] ?? st.afoperation} · ${st.afmethod}`],
      ["wb", `WB ${wb}`],
      ["style", String(st.picturestyle)],
    ]);
    this.osd(this.osdBottom, [
      ["tv", prettyValue("tv", tv).replace(" s", "")],
      ["av", prettyValue("av", av).replace("/", "")],
      ["comp", prettyValue("exposure", comp).replace(" EV", "")],
      ["iso", `ISO ${iso}`],
    ]);
    // Exposure level against the meter: where the camera sits relative to "correct".
    // error = (meter - comp) - used, so the photo sits error + comp stops above the meter's idea of correct.
    const compUsed = mode === "m" && st.iso !== "auto" ? 0 : (evStops(comp) ?? 0);
    const shown = Math.max(-3, Math.min(3, e.error + compUsed));
    this.meterEl.replaceChildren(
      el("span", {}, ["-3"]),
      el("span", { class: "meter-bar" }, [el("span", { class: "meter-mark", style: `left:${((shown + 3) / 6) * 100}%` })]),
      el("span", {}, ["+3"]),
    );
    this.busy.classList.toggle("on", s.busy);
    await this.renderCard(s);
  }

  /** Writes OSD fields, flashing any that changed. */
  private osd(target: HTMLElement, fields: Array<[string, string]>) {
    target.replaceChildren(
      ...fields.map(([k, v]) => {
        const prev = this.lastOsd.get(k);
        this.lastOsd.set(k, v);
        return el("span", { class: `osd-${k}${prev !== undefined && prev !== v ? " changed" : ""}` }, [v]);
      }),
    );
  }

  private async renderCard(s: SimStatus) {
    if (!s.shots.length) {
      if (this.shotThumbs.size || !this.card.querySelector(".muted")) this.card.replaceChildren(el("span", { class: "muted" }, ["No photos yet."]));
      this.shotThumbs.clear();
      return;
    }
    let added = false;
    for (const shot of s.shots) {
      if (this.shotThumbs.has(shot.path)) continue;
      const res = await this.link.request("GET", `${shot.path}?kind=thumbnail`);
      if (!res.bytes) continue;
      this.shotThumbs.set(shot.path, blobUrl(res.bytes));
      added = true;
    }
    if (!added && this.card.childElementCount === s.shots.length) return;
    this.card.replaceChildren(
      ...s.shots
        .slice()
        .reverse()
        .map((shot) => {
          const b = el("button", { class: "card-shot", type: "button", title: `${shot.name}: ${shot.exposure.av} · ${shot.exposure.tv} · ISO ${shot.exposure.isoValue}` }, [
            el("img", { src: this.shotThumbs.get(shot.path) ?? "", alt: shot.name }),
            el("span", {}, [shot.name.replace(".JPG", "")]),
          ]);
          b.addEventListener("click", () => void this.openShot(shot.path));
          return b;
        }),
    );
  }

  private async openShot(path: string) {
    const res = await this.link.request("GET", `${path}?kind=display`);
    if (!res.bytes) return;
    const box = el("div", { class: "lightbox", role: "dialog", "aria-label": "Photo" }, [el("img", { src: blobUrl(res.bytes), alt: "" })]);
    box.addEventListener("click", () => box.remove());
    document.body.append(box);
  }

  private addTraffic(e: TrafficEntry) {
    const ok = e.status >= 200 && e.status < 300;
    const row = el("li", { class: ok ? "" : "bad" }, [
      el("span", { class: "m" }, [e.method]),
      el("span", { class: "p" }, [e.path + (e.body ? ` ${e.body}` : "")]),
      el("span", { class: "s" }, [`${e.status} · ${e.ms} ms`]),
    ]);
    this.traffic.prepend(row);
    if (++this.trafficCount > 80) this.traffic.lastElementChild?.remove();
  }
}
