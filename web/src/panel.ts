// The camera, as the visitor sees it: pick a scene, watch the camera's rear
// screen (live, with its settings display) and see the photos on its card.

import type { SimStatus } from "../../camsim/camera.ts";
import { evStops, prettyValue } from "../../shared/settings.ts";
import { icon } from "./brand.ts";
import { el, lightbox } from "./dom.ts";
import { blobUrl } from "./images.ts";
import type { SimLink } from "./sim/link.ts";

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
  scene = "concert";
  private link: SimLink;
  private onScene: (id: string) => void;
  private sceneList: HTMLElement;
  private lv: HTMLImageElement;
  private osdTop: HTMLElement;
  private osdBottom: HTMLElement;
  private meterEl: HTMLElement;
  private card: HTMLElement;
  private lastOsd = new Map<string, string>();
  private shotThumbs = new Map<string, string>();
  private cardCount: HTMLElement;
  private lvUrl: string | null = null;
  /** Scene switches, one at a time, so the camera ends on the scene picked last. */
  private switching = Promise.resolve();
  private busy: HTMLElement;
  private scrollBtns: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;

  /** `aside` sits next to the rear screen (the demo puts the glasses' lens there). */
  constructor(link: SimLink, onScene: (id: string) => void, aside?: HTMLElement) {
    this.link = link;
    this.onScene = onScene;
    this.sceneList = el("div", { class: "scenes", role: "radiogroup", "aria-label": "Scene" });
    this.lv = el("img", { class: "lv", alt: "The camera's rear screen" });
    this.osdTop = el("div", { class: "osd top" });
    this.osdBottom = el("div", { class: "osd bottom" });
    this.meterEl = el("div", { class: "meter", title: "Exposure level relative to the camera's meter" });
    this.busy = el("div", { class: "busy-flash" });
    this.card = el("div", { class: "card-strip" }, [el("span", { class: "card-empty" }, ["No photos yet."])]);
    this.cardCount = el("span", { class: "card-badge" }, ["Empty"]);

    // Scenes scroll sideways, so any number fits; the arrows page through them with a mouse.
    this.prevBtn = el("button", { class: "prev", type: "button", "aria-label": "Previous scenes", onclick: () => this.page(-1) }, [icon("i-chevron")]);
    this.nextBtn = el("button", { class: "next", type: "button", "aria-label": "More scenes", onclick: () => this.page(1) }, [icon("i-chevron")]);
    this.scrollBtns = el("div", { class: "scroll-btns", hidden: true }, [this.prevBtn, this.nextBtn]);
    this.sceneList.addEventListener("scroll", () => this.updateScroll(), { passive: true });
    new ResizeObserver(() => this.updateScroll()).observe(this.sceneList);

    const head = (title: string, sub: string, lead: HTMLElement | null, trail: HTMLElement) =>
      el("div", { class: "card-head" }, [lead, el("div", {}, [el("h3", {}, [title]), el("div", { class: "card-sub" }, [sub])]), trail]);

    this.root = el("div", { class: "camera-panel" }, [
      el("div", { class: "panel-head" }, [
        el("h2", {}, ["The camera"]),
        el("p", {}, [
          "The camera the app is driving, simulated here so you can try it without one. Exposure, metering, white balance, focus, depth of field, motion blur and noise behave as they would on a real body.",
        ]),
      ]),
      el("section", { class: "panel-card", "aria-label": "Scene" }, [
        head("Pick a scene", "Each one is a different problem for the agent", el("span", { class: "card-num" }, ["1"]), this.scrollBtns),
        this.sceneList,
      ]),
      el("div", { class: "screens" }, [
        el("section", { class: "panel-card", "aria-label": "Rear screen" }, [
          head("Rear screen", "Live view, with exposure simulation", null, el("span", { class: "card-badge live" }, ["Live"])),
          el("div", { class: "screen-body" }, [el("div", { class: "screen" }, [this.lv, this.osdTop, this.osdBottom, this.meterEl, this.busy])]),
        ]),
        aside,
      ]),
      el("section", { class: "panel-card", "aria-label": "Memory card" }, [head("Memory card", "Every test shot the agent takes. Tap one to see it full size.", null, this.cardCount), this.card]),
    ]);
  }

  /** Scrolls the scene list by about a screenful. */
  private page(dir: number) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.sceneList.scrollBy({ left: dir * this.sceneList.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  }

  private updateScroll() {
    const l = this.sceneList;
    const max = l.scrollWidth - l.clientWidth;
    this.scrollBtns.hidden = max <= 2;
    this.prevBtn.disabled = l.scrollLeft <= 2;
    this.nextBtn.disabled = l.scrollLeft >= max - 2;
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
        b.addEventListener("click", () => this.pick(s.id));
        return b;
      }),
    );
    this.updateScroll();
  }

  private pick(id: string) {
    if (id === this.scene) return;
    this.scene = id;
    this.renderScenes();
    this.switching = this.switching.then(async () => {
      if (id !== this.scene) return; // another pick came after this one
      await this.link.request("POST", "/sim/scene", { id });
      if (id === this.scene) this.onScene(id);
    }).catch(console.error);
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
    // With high-frequency anti-flicker on, Tv and M shoot at its matched speed, not the Tv setting.
    const manualTv = st.hfantiflickershoot === "enable" ? String(st.hfflickertv) : String(st.tv);
    const tv = mode === "tv" || mode === "m" ? manualTv : e.tv;
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
      ...Object.entries(s.menu ?? {}).map(([k, v]): [string, string] => ["hand", k === "HDR Mode" ? `HDR ${v === "Auto" ? "AUTO" : v}` : `${k} ${v}`]),
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
      if (this.shotThumbs.size || !this.card.querySelector(".card-empty")) this.card.replaceChildren(el("span", { class: "card-empty" }, ["No photos yet."]));
      this.dropThumbs();
      this.cardCount.textContent = "Empty";
      return;
    }
    const before = this.shotThumbs.size;
    this.dropThumbs(new Set(s.shots.map((shot) => shot.path)));
    let changed = this.shotThumbs.size !== before;
    for (const shot of s.shots) {
      if (this.shotThumbs.has(shot.path)) continue;
      const res = await this.link.request("GET", `${shot.path}?kind=thumbnail`);
      if (!res.bytes) continue;
      this.shotThumbs.set(shot.path, blobUrl(res.bytes));
      changed = true;
    }
    if (!changed && this.card.childElementCount === s.shots.length) return;
    this.cardCount.textContent = s.shots.length === 1 ? "1 photo" : `${s.shots.length} photos`;
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

  /** Releases the thumbnails of photos no longer on the card (all of them by default). */
  private dropThumbs(keep = new Set<string>()) {
    for (const [path, url] of this.shotThumbs) {
      if (keep.has(path)) continue;
      URL.revokeObjectURL(url);
      this.shotThumbs.delete(path);
    }
  }

  private async openShot(path: string) {
    let res = await this.link.request("GET", `${path}?kind=display`);
    // Small JPEGs have no display image: the photo itself is small enough.
    if (!res.bytes && /\.jpe?g$/i.test(path)) res = await this.link.request("GET", path);
    if (!res.bytes) return;
    const url = blobUrl(res.bytes);
    lightbox(url, () => URL.revokeObjectURL(url));
  }
}
