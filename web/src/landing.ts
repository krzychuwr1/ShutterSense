// The front page: what Shutter Sense is (the camera settings most people
// never find, changed over the camera's API or shown tap by tap), the three
// devices it runs across, an animated diagram of how the camera, the phone app, the cloud and the glasses work
// together, and the way into the simulated experience.

import { menuPath, type MenuScreen } from "../../shared/menu.ts";
import { sprite, use } from "./brand.ts";
import { menuGuide } from "./camera-menu.ts";
import { cameraArt, glassesArt, phoneArt } from "./devices.ts";
import { el, h } from "./dom.ts";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T & Element>(sel) as T;

// ---------------------------------------------------------------- hero

const HERO = `<section class="hero">
  <div class="wrap">
    <div class="hero-text">
      <span class="eyebrow"><b>AI agent</b> for your mirrorless camera</span>
      <h1>Your camera can already do it. <span class="g">Shutter Sense knows how.</span></h1>
      <p class="hero-lede">The settings that make the shot are rarely the obvious ones. Anti-flicker under LED light, servo AF on the right point, spot metering, a white-balance shift: say what you want and Shutter Sense changes them over Wi-Fi, takes a test shot and checks it. The few it can't reach, it shows you tap by tap, on your phone and on your glasses.</p>
      <div class="quotes" aria-label="Things you can say">
        <span class="quote">Stop the LED banding</span>
        <span class="quote">Freeze the dog</span>
        <span class="quote">Get all three sharp</span>
      </div>
      <div class="cta">
        <a class="btn primary" href="/try">Try the simulated experience ${use("i-arrow")}</a>
        <a class="btn soft" href="#how">How it works</a>
      </div>
      <p class="note">${use("i-check")}No camera, phone app or glasses needed: the web version simulates all three.</p>
    </div>

    <div class="ba-shell">
      <div class="float ask" aria-hidden="true">
        <span class="fl-ico">${use("i-mic")}</span>
        <span><small>You, on the glasses</small>“Shoot silently, lose the stripes”</span>
      </div>
      <div class="ba">
        <img src="/landing/after.jpg" alt="The same concert after high-frequency anti-flicker: clean, evenly lit frame" draggable="false">
        <div class="ba-before"><img src="/landing/before.jpg" alt="A singer on an LED-lit stage, striped with dark bands from the silent electronic shutter" draggable="false"></div>
        <span class="ba-tag l">Camera's choice</span>
        <span class="ba-tag r">After Shutter Sense</span>
        <span class="ba-line"></span>
        <span class="ba-knob" role="slider" tabindex="0" aria-label="Compare the camera's photo with the agent's photo" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">${use("i-drag")}</span>
      </div>
      <div class="float res" aria-hidden="true">
        <span class="fl-ico">${use("i-wifi")}</span>
        <span><small>Found 1310 Hz LED flicker · set over CCAPI</small>HF anti-flicker · 1/1307 s · still silent</span>
      </div>
      <div class="float drag" aria-hidden="true">Drag to compare</div>
    </div>
  </div>
</section>`;

/** The hero's before/after: drag it (or use the arrow keys); a short sweep on load hints that it moves. */
function beforeAfter(root: HTMLElement) {
  const ba = $(root, ".ba");
  const knob = $(root, ".ba-knob");
  let dragging = false;
  let hint = 0;
  let touched = false;
  const set = (p: number) => {
    p = Math.max(0, Math.min(100, p));
    ba.style.setProperty("--pos", `${p}%`);
    knob.setAttribute("aria-valuenow", String(Math.round(p)));
    knob.setAttribute("aria-valuetext", `${Math.round(p)}% showing the camera's photo`);
  };
  const fromEvent = (e: PointerEvent) => {
    const r = ba.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 100);
  };
  // The visitor took over, possibly before the sweep began: it must not start afterwards.
  const stopHint = () => {
    touched = true;
    cancelAnimationFrame(hint);
  };
  ba.addEventListener("pointerdown", (e) => {
    stopHint();
    dragging = true;
    ba.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  ba.addEventListener("pointermove", (e) => dragging && fromEvent(e));
  for (const t of ["pointerup", "pointercancel"]) ba.addEventListener(t, () => (dragging = false));
  const KEYS: Record<string, number> = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -20, PageUp: 20 };
  knob.addEventListener("keydown", (e) => {
    const now = Number(knob.getAttribute("aria-valuenow"));
    if (e.key in KEYS) set(now + KEYS[e.key]);
    else if (e.key === "Home") set(0);
    else if (e.key === "End") set(100);
    else return;
    stopHint();
    e.preventDefault();
  });
  if (reducedMotion()) return;
  const keys: Array<[number, number]> = [[0, 50], [900, 22], [2000, 80], [2900, 50]];
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  let t0 = 0;
  const tick = (now: number) => {
    t0 ||= now;
    const t = now - t0;
    const i = keys.findIndex((k) => k[0] > t);
    if (i === -1) return set(50);
    const [ta, pa] = keys[i - 1];
    const [tb, pb] = keys[i];
    set(pa + (pb - pa) * ease((t - ta) / (tb - ta)));
    hint = requestAnimationFrame(tick);
  };
  setTimeout(() => touched || (hint = requestAnimationFrame(tick)), 900);
}

// ---------------------------------------------------------------- the two paths

/** Settings the agent changes itself, as its diff lines would show them. */
const API_SETTINGS: Array<[string, string, string, string]> = [
  ["Anti-flicker", "Off", "On", "LED and fluorescent light pulses; it fires at the peak, so every frame matches"],
  ["AF", "One Shot", "Servo", "Keeps tracking a dog that won't sit still"],
  ["Metering", "Evaluative", "Spot", "Exposes for her face, not the bright sky behind her"],
  ["WB shift", "BA 0", "BA +2", "Warms skin a touch without losing the mood"],
  ["Contrast", "0", "−2", "Holds detail in harsh midday light"],
  ["Shutter type", "Electronic", "Mechanical", "No banding or skew under artificial light"],
];

/** The example walk-through, drawn the way the phone app draws it, from the camera's menu map. */
const MENU_DEMO: MenuScreen[] = menuPath("mirrorless", "Subject to detect", "Animals")?.screens ?? [];

const MENU_ONLY = ["Highlight tone priority", "Servo AF Case 1–4", "Auto-ISO min. shutter speed", "Eye detection", "Auto Lighting Optimizer"];

const PATHS = `<section class="paths" id="settings">
  <div class="wrap">
    <div class="sec-head">
      <span class="kicker">Beyond exposure compensation</span>
      <h2>The settings most people never find.</h2>
      <p>Nudging exposure is the easy part. What makes the shot is usually a setting three menus deep. Shutter Sense knows them, knows when your shot needs one, and takes whichever path your camera allows.</p>
    </div>
    <div class="path-grid">
      <article class="path-card api">
        <span class="path-tag">${use("i-wifi")}Path 1 · over CCAPI</span>
        <h3>It changes them itself</h3>
        <p>Everything the camera's control API exposes, the agent sets directly over Wi-Fi, including high-frequency anti-flicker for LED panels, the AF point and picture-style fine-tuning. Then it takes a test shot to check the change worked.</p>
        <ul class="diff-list" aria-label="Examples of settings the agent changes">
          ${API_SETTINGS.map(([k, a, b, why], i) => `<li style="--i:${i}"><span class="dl-name">${k}</span><span class="dl-val"><s>${a}</s>${use("i-arrow")}<b>${b}</b></span><span class="dl-why">${why}</span></li>`).join("")}
        </ul>
      </article>
      <article class="path-card menu">
        <span class="path-tag">${use("i-tap")}Path 2 · on the camera's menu</span>
        <h3>It shows you where to tap</h3>
        <p>Some settings the API can't reach. For those, the agent puts the exact menu path on your phone and on the glasses lens, and waits for your “Done” before it carries on.</p>
        <div class="menu-demo" aria-label="Example: the menu steps for animal detection">
          <div class="guide-mock">
            <span class="gm-kicker">${use("i-cam")}On the camera</span>
            <strong class="gm-title">Subject to detect: Animals</strong>
            <span class="gm-why">Eye AF on the dog, not the fence. Not in the API.</span>
            <div class="gm-menu"></div>
            <span class="gm-btns"><span class="gm-btn on">Done</span><span class="gm-btn">Skip</span></span>
          </div>
          <div class="lens-mock" aria-hidden="true">
            <span class="lm-head">On the camera</span>
            <span class="lm-path">MENU › AF tab › Subject to detect › <b>Animals</b></span>
            <span class="lm-btns"><b>Done</b><span>Skip</span></span>
          </div>
        </div>
        <div class="menu-more"><span>Also walks you to</span>${MENU_ONLY.map((s) => `<i>${s}</i>`).join("")}</div>
      </article>
    </div>
    <p class="paths-note">Menu names vary a little between bodies and firmware, so the agent names each item rather than page numbers.</p>
  </div>
</section>`;

// ---------------------------------------------------------------- how it works

type Dev = "camera" | "phone" | "cloud" | "glasses";
const ORDER: Dev[] = ["camera", "phone", "cloud", "glasses"];
const NAME: Record<Dev, string> = { camera: "Camera", phone: "Phone", cloud: "Cloud", glasses: "Glasses" };
const WIRE = ["Wi-Fi · CCAPI", "HTTPS", "WebSocket"];

/** What the illustrated devices show after a message arrives. */
interface Effects {
  /** A new line in the phone's log: a menu step or the photographer's answer look different. */
  phone?: string;
  phoneKind?: "menu" | "you";
  cloud?: string;
  hud?: string;
  hudKind?: "menu" | "ok";
  photo?: "before" | "after";
  flash?: boolean;
}

interface Hop {
  from: Dev;
  to: Dev;
  label: string;
  then?: Effects;
}

interface Step {
  title: string;
  /** Which of the two paths this step shows. */
  path?: "api" | "menu";
  text: string;
  start?: Effects;
  hops: Hop[];
}

const GOAL = "Freeze the dog mid-stride";

const STEPS: Step[] = [
  {
    title: "Ask",
    text: "Say what you want, in your own words: by voice on the glasses, or typed on the phone.",
    start: { hud: `🎙 “${GOAL}”` },
    hops: [
      { from: "glasses", to: "cloud", label: `“${GOAL}”` },
      { from: "cloud", to: "phone", label: `“${GOAL}”`, then: { phone: `Goal: ${GOAL.toLowerCase()}` } },
    ],
  },
  {
    title: "Look",
    text: "The phone app reads every setting the camera exposes, with the values it accepts, and grabs a live-view frame over Wi-Fi through CCAPI.",
    hops: [
      { from: "phone", to: "camera", label: "Settings + live view?" },
      { from: "camera", to: "phone", label: "Live-view frame", then: { phone: "One Shot AF · 1/250 s · ISO auto" } },
    ],
  },
  {
    title: "Set",
    path: "api",
    text: "The Muse model sees a fast dog. A faster shutter alone won't do it: focus has to track him too. Both are in the camera's API, so the agent changes them itself and the lens shows each change.",
    hops: [
      { from: "phone", to: "cloud", label: "Frame + goal" },
      { from: "cloud", to: "phone", label: "set_settings", then: { cloud: "Fast subject: Servo AF on him, 1/1000 s", phone: "AF One Shot → Servo · 1/250 → 1/1000 s" } },
      { from: "phone", to: "camera", label: "Servo AF · 1/1000 s" },
      { from: "phone", to: "cloud", label: "Lens update" },
      { from: "cloud", to: "glasses", label: "AF → Servo · 1/1000 s", then: { hud: "AF One Shot → Servo · Shutter 1/250 → 1/1000 s" } },
    ],
  },
  {
    title: "Guide",
    path: "menu",
    text: "Animal detection isn't in the API, so the agent shows the exact menu path on the phone and on the lens, then waits. Set it, pinch “Done” on the glasses, and it carries on.",
    hops: [
      { from: "phone", to: "cloud", label: "Settings applied" },
      { from: "cloud", to: "phone", label: "menu_steps", then: { cloud: "Eye AF on animals isn't in the API: show the menu path", phone: "On the camera: Subject to detect → Animals", phoneKind: "menu" } },
      { from: "phone", to: "cloud", label: "Lens update" },
      { from: "cloud", to: "glasses", label: "Menu path", then: { hud: "MENU › AF tab › Subject to detect › Animals", hudKind: "menu" } },
      { from: "glasses", to: "cloud", label: "Pinch: Done" },
      { from: "cloud", to: "phone", label: "Done", then: { phone: "You: Done", phoneKind: "you" } },
    ],
  },
  {
    title: "Shoot",
    text: "It takes a test shot and looks at the real photo, not just the numbers. Not right yet? It adjusts and shoots again, within a shot budget.",
    hops: [
      { from: "phone", to: "camera", label: "Shoot", then: { photo: "after", flash: true } },
      { from: "camera", to: "phone", label: "Photo", then: { phone: "Shot 1 · 1/1000 s · f/2.8 · ISO 800" } },
      { from: "phone", to: "cloud", label: "Photo" },
      { from: "cloud", to: "phone", label: "Matches: finish", then: { cloud: "Eye sharp, paws frozen. Done in one shot" } },
    ],
  },
  {
    title: "Report",
    text: "You hear what it changed and why, in photography terms. Want a little motion in the legs after all? Say so and it carries on.",
    hops: [
      { from: "phone", to: "cloud", label: "Summary" },
      { from: "cloud", to: "glasses", label: "Summary", then: { hud: "✓ Servo AF + animal eye AF, 1/1000 s: frozen mid-stride", hudKind: "ok" } },
    ],
  },
];

const PATH_LABEL = { api: "Changed over CCAPI", menu: "Shown on the menu" };
const HOP_MS = 1250;
const GAP_MS = 220;
const HOLD_MS = 2800;

const DEVICES = `<div class="devices">
  <article class="device" data-dev="camera">
    <span class="badge">Working</span>
    <div class="ill">
      <div class="cam" aria-hidden="true">
        <span class="cam-hump"></span><span class="cam-dial"></span><span class="cam-shutter"></span>
        <div class="cam-body">
          <div class="cam-screen blur"><img src="/scenes/dog.jpg" alt=""><span class="rec">LIVE</span><span class="cam-flash"></span></div>
          <span class="cam-pad"></span>
          <svg class="cam-wifi" viewBox="0 0 24 24"><use href="#i-wifi"/></svg>
        </div>
      </div>
    </div>
    <h3><span class="num">1</span>Your camera</h3>
    <p class="sub">Any mirrorless body with CCAPI, on the same Wi-Fi as the phone</p>
  </article>
  <article class="device" data-dev="phone">
    <span class="badge">Working</span>
    <div class="ill">
      <div class="ill-phone" aria-hidden="true">
        <div class="ill-phone-screen">
          <div class="app-head"><i></i>Shutter Sense</div>
          <div class="ill-log"></div>
        </div>
      </div>
    </div>
    <h3><span class="num">2</span>Phone app</h3>
    <p class="sub">Android. Runs the agent and drives the camera</p>
  </article>
  <article class="device" data-dev="cloud">
    <span class="badge">Working</span>
    <div class="ill">
      <div class="cloudill">
        <svg viewBox="0 0 132 82" aria-hidden="true">
          <defs><linearGradient id="cloudGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f7bff"/><stop offset="1" stop-color="#5a49f0"/></linearGradient></defs>
          <path d="M34 78h66a25 25 0 0 0 3-49.8A33 33 0 0 0 40 21 28.5 28.5 0 0 0 34 78z" fill="url(#cloudGrad)"/>
          <rect x="44" y="40" width="50" height="22" rx="11" fill="#fff" opacity=".95"/>
          <text x="69" y="55.5" text-anchor="middle" font-family="Plus Jakarta Sans, sans-serif" font-size="12.5" font-weight="800" fill="#5a49f0">Muse</text>
        </svg>
        <div class="ill-think">Waiting for a goal</div>
      </div>
    </div>
    <h3><span class="num">3</span>Cloud</h3>
    <p class="sub">Cloudflare Worker + the Muse model</p>
  </article>
  <article class="device" data-dev="glasses">
    <span class="badge">Working</span>
    <div class="ill">
      <div class="glassill">
        <svg viewBox="0 0 196 72" aria-hidden="true">
          <path d="M6 18h184" stroke="#1d2440" stroke-width="6" stroke-linecap="round"/>
          <rect x="14" y="16" width="70" height="48" rx="20" fill="#dff5ee" stroke="#1d2440" stroke-width="6"/>
          <rect x="112" y="16" width="70" height="48" rx="20" fill="#dff5ee" stroke="#1d2440" stroke-width="6"/>
          <path d="M84 30q14-10 28 0" fill="none" stroke="#1d2440" stroke-width="6"/>
          <rect x="130" y="30" width="34" height="18" rx="5" fill="#12b886" opacity=".75"/>
        </svg>
        <div class="ill-hud">Ready</div>
      </div>
    </div>
    <h3><span class="num">4</span>Your glasses</h3>
    <p class="sub">Ray-Ban Display. Progress, menu steps and voice on the lens</p>
  </article>
</div>`;

interface Segment {
  track: SVGPathElement;
  lit: SVGPathElement;
  /** The track, its dashed centre line and the lit overlay: all follow the same curve. */
  paths: SVGPathElement[];
  ports: SVGCircleElement[];
  label: HTMLElement;
  /** The two cards are stacked (narrow screens) rather than side by side. */
  vertical: boolean;
}

/** The animated diagram: four device cards joined by wires, messages travelling hop by hop, a six-step rail. */
class Flow {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private svg: SVGSVGElement;
  private dot: SVGGElement;
  private msg: HTMLElement;
  private cards = new Map<Dev, HTMLElement>();
  private segs: Segment[] = [];
  private railItems: HTMLElement[] = [];
  private railFill: HTMLElement;
  private playBtn: HTMLButtonElement;
  private capN: HTMLElement;
  private capTitle: HTMLElement;
  private capText: HTMLElement;
  private hopsEl: HTMLElement;
  private camScreen: HTMLElement;
  private camFlash: HTMLElement;
  private phoneLog: HTMLElement;
  private thought: HTMLElement;
  private hud: HTMLElement;
  private reduced = reducedMotion();
  private playing = !this.reduced;
  private run = 0;
  private step = 0;
  /** The last step whose effects the devices already show. */
  private applied = -1;
  private activeSeg: Segment | null = null;
  private ringT0 = 0;
  private ringDur = 1;
  private W = 0;
  private H = 0;

  constructor() {
    this.root = h(`<div class="flow">
      <div class="stage">
        <svg class="wires" aria-hidden="true">
          <defs>
            <linearGradient id="litGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3355ff"/><stop offset="1" stop-color="#7b5cff"/></linearGradient>
            <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5"/></filter>
          </defs>
          <g class="segs"></g>
          <g class="dot"><circle class="dot-halo" r="18" filter="url(#glow)"/><circle class="dot-core" r="7"/></g>
        </svg>
        ${DEVICES}
        <div class="flow-chips"><div class="msg"><span class="route"></span><span class="msg-text"></span></div></div>
      </div>
      <div class="player">
        <div class="rail-row">
          <ol class="rail"><span class="rail-fill"></span></ol>
          <button class="btn soft small play" type="button"></button>
        </div>
        <div class="flow-caption" aria-live="polite">
          <span class="cap-n">1</span>
          <h3 class="cap-title"></h3>
          <p class="cap-text"></p>
          <ul class="hops" aria-label="Messages in this step"></ul>
        </div>
      </div>
    </div>`);
    const r = this.root;
    this.stage = $(r, ".stage");
    this.svg = $<SVGSVGElement>(r, ".wires");
    this.dot = $<SVGGElement>(r, ".dot");
    this.msg = $(r, ".msg");
    this.railFill = $(r, ".rail-fill");
    this.playBtn = $<HTMLButtonElement>(r, ".play");
    this.capN = $(r, ".cap-n");
    this.capTitle = $(r, ".cap-title");
    this.capText = $(r, ".cap-text");
    this.hopsEl = $(r, ".hops");
    this.camScreen = $(r, ".cam-screen");
    this.camFlash = $(r, ".cam-flash");
    this.phoneLog = $(r, ".ill-log");
    this.thought = $(r, ".ill-think");
    this.hud = $(r, ".ill-hud");
    for (const id of ORDER) this.cards.set(id, $(r, `[data-dev="${id}"]`));

    // Three wires: camera-phone, phone-cloud, cloud-glasses.
    const segsG = $<SVGGElement>(r, ".segs");
    const chips = $(r, ".flow-chips");
    const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
      const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      segsG.append(n);
      return n;
    };
    for (const name of WIRE) {
      const track = mk("path", { class: "track" });
      const dash = mk("path", { class: "track-dash" });
      const lit = mk("path", { class: "lit", pathLength: "1" });
      const ports = [mk("circle", { class: "port", r: "6" }), mk("circle", { class: "port", r: "6" })];
      const label = el("span", { class: "wire-label" }, [name]);
      chips.append(label);
      this.segs.push({ track, lit, paths: [track, dash, lit], ports, label, vertical: false });
    }

    const rail = $(r, ".rail");
    STEPS.forEach((s, i) => {
      const b = el("button", { type: "button", "aria-label": `Step ${i + 1}: ${s.title}` }, [el("span", { class: "n" }, [String(i + 1)]), el("span", { class: "t" }, [s.title])]);
      b.addEventListener("click", () => {
        this.playing = false;
        void this.go(i);
      });
      const li = el("li", { class: i === 0 ? "on" : undefined }, [b]);
      rail.append(li);
      this.railItems.push(li);
    });
    this.playBtn.addEventListener("click", () => this.toggle());

    this.reset();
    this.renderPlay();
    this.caption(0);
    this.ring();
  }

  /** Lays out the wires once the diagram is in the page, and starts playing when it scrolls into view. */
  mount() {
    this.layout();
    new ResizeObserver(() => this.layout()).observe(this.stage);
    void document.fonts?.ready.then(() => this.layout());
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void this.go(0);
    };
    if (!("IntersectionObserver" in window)) return start();
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        start();
      },
      { threshold: 0.2 },
    );
    io.observe(this.stage);
  }

  private layout() {
    this.W = this.stage.clientWidth;
    this.H = this.stage.clientHeight;
    this.svg.setAttribute("viewBox", `0 0 ${this.W} ${this.H}`);
    const box = ORDER.map((id) => {
      const c = this.cards.get(id)!;
      return { x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight };
    });
    this.segs.forEach((s, k) => {
      const a = box[k];
      const b = box[k + 1];
      s.vertical = b.y >= a.y + a.h - 1;
      let p0: number[], p3: number[], c1: number[], c2: number[];
      if (!s.vertical) {
        p0 = [a.x + a.w, a.y + a.h * 0.38];
        p3 = [b.x, b.y + b.h * 0.38];
        const dx = p3[0] - p0[0];
        c1 = [p0[0] + dx * 0.7, p0[1]];
        c2 = [p3[0] - dx * 0.7, p3[1]];
      } else {
        // Stacked cards: the wire weaves from one side to the other.
        const fa = k % 2 === 0 ? 0.24 : 0.76;
        p0 = [a.x + a.w * fa, a.y + a.h];
        p3 = [b.x + b.w * (1 - fa), b.y];
        const dy = p3[1] - p0[1];
        c1 = [p0[0], p0[1] + dy * 0.95];
        c2 = [p3[0], p3[1] - dy * 0.95];
      }
      const d = `M${p0} C${c1} ${c2} ${p3}`;
      for (const p of s.paths) p.setAttribute("d", d);
      [p0, p3].forEach((p, i) => {
        s.ports[i].setAttribute("cx", String(p[0]));
        s.ports[i].setAttribute("cy", String(p[1]));
      });
      const m = this.point(s, 0.5);
      if (!s.vertical) s.label.style.transform = `translate(${m[0]}px, ${Math.max(p0[1], p3[1]) + 30}px) translate(-50%, -50%)`;
      else {
        // Beside the wire, on the side the curve isn't.
        s.label.style.transform = k % 2 === 0 ? `translate(4px, ${m[1]}px) translate(0, -50%)` : `translate(${this.W - 4}px, ${m[1]}px) translate(-100%, -50%)`;
      }
    });
  }

  private point(s: Segment, f: number): [number, number] {
    const p = s.track.getPointAtLength(f * s.track.getTotalLength());
    return [p.x, p.y];
  }

  /** Keeps the message bubble above the travelling dot (or parked beside a stacked wire). */
  private placeMsg(s: Segment, x: number, y: number, k: number) {
    const w = this.msg.offsetWidth;
    const hgt = this.msg.offsetHeight;
    if (!s.vertical) {
      const left = Math.max(-20, Math.min(this.W - w + 20, x - w / 2));
      this.msg.style.setProperty("--tail", `${Math.max(14, Math.min(w - 14, x - left))}px`);
      this.msg.style.transform = `translate(${left}px, ${y - hgt - 18}px)`;
    } else {
      const m = this.point(s, 0.5);
      this.msg.style.setProperty("--tail", "-40px");
      this.msg.style.transform = `translate(${k % 2 === 0 ? this.W - w : 0}px, ${m[1] - hgt / 2}px)`;
    }
  }

  private toggle() {
    this.playing = !this.playing;
    this.renderPlay();
    if (this.playing) void this.go((this.step + 1) % STEPS.length);
  }

  private renderPlay() {
    this.playBtn.innerHTML = this.playing ? `${use("i-pause")}<span class="lbl">Pause</span>` : `${use("i-play")}<span class="lbl">Play</span>`;
    this.playBtn.setAttribute("aria-label", this.playing ? "Pause the animation" : "Play the animation");
  }

  /** The progress ring around the current step's number. */
  private ring() {
    const n = this.railItems[this.step]?.querySelector<HTMLElement>(".n");
    n?.style.setProperty("--t", this.playing ? Math.min(1, (performance.now() - this.ringT0) / this.ringDur).toFixed(3) : "1");
    requestAnimationFrame(() => this.ring());
  }

  private caption(i: number) {
    const s = STEPS[i];
    this.capN.textContent = String(i + 1);
    this.capTitle.replaceChildren(s.title, el("small", {}, [`Step ${i + 1} of ${STEPS.length}`]));
    if (s.path) this.capTitle.append(el("span", { class: `cap-path ${s.path}` }, [PATH_LABEL[s.path]]));
    this.capText.textContent = s.text;
    this.hopsEl.replaceChildren(...s.hops.map((hp) => el("li", {}, [el("b", {}, [`${NAME[hp.from]} → ${NAME[hp.to]}`]), hp.label])));
  }

  private setWorking(id: Dev) {
    for (const [d, c] of this.cards) c.classList.toggle("working", d === id);
  }

  private ping(id: Dev) {
    const c = this.cards.get(id)!;
    c.classList.remove("ping");
    void c.offsetWidth;
    c.classList.add("ping");
  }

  private reset() {
    this.phoneLog.replaceChildren(el("div", { class: "ph" }, ["Waiting for a goal…"]));
    this.thought.textContent = "Waiting for a goal";
    this.setHud("Ready · pinch to talk");
    this.camScreen.classList.add("blur");
  }

  private setHud(text: string, kind?: string) {
    this.hud.textContent = text;
    if (kind) this.hud.dataset.kind = kind;
    else delete this.hud.dataset.kind;
  }

  private apply(e: Effects | undefined, quiet = false) {
    if (!e) return;
    if (e.phone) {
      this.phoneLog.querySelector(".ph")?.remove();
      this.phoneLog.append(el("div", { class: e.phoneKind }, [e.phone]));
      while (this.phoneLog.childElementCount > 3) this.phoneLog.firstElementChild?.remove();
    }
    if (e.cloud) this.thought.textContent = e.cloud;
    if (e.hud) this.setHud(e.hud, e.hudKind);
    if (e.photo) this.camScreen.classList.toggle("blur", e.photo === "before");
    if (e.flash && !this.reduced && !quiet) {
      this.camFlash.classList.remove("on");
      void this.camFlash.offsetWidth;
      this.camFlash.classList.add("on");
    }
  }

  /** Everything step `s` leaves on the devices, without the animation. */
  private applyStep(s: Step) {
    this.apply(s.start, true);
    for (const hp of s.hops) this.apply(hp.then, true);
  }

  /** Shows step `i`: its messages travel hop by hop, each updating the device it reaches. */
  private async go(i: number) {
    const run = ++this.run;
    // Jumping around: rebuild what the devices would show by now.
    if (i === 0 || this.applied !== i - 1) {
      this.reset();
      for (let j = 0; j < i; j++) this.applyStep(STEPS[j]);
    }
    this.step = i;
    const s = STEPS[i];
    this.renderPlay();
    this.railItems.forEach((li, j) => {
      li.classList.toggle("on", j === i);
      li.classList.toggle("done", j < i);
      const b = li.querySelector("button")!;
      if (j === i) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    this.railFill.style.width = `${(i / STEPS.length) * 100}%`;
    this.ringT0 = performance.now();
    this.ringDur = s.hops.length * (HOP_MS + GAP_MS) + HOLD_MS;
    this.caption(i);
    this.apply(s.start);
    const hopLis = [...this.hopsEl.children];
    for (let k = 0; k < s.hops.length; k++) {
      if (run !== this.run) return;
      hopLis.forEach((li, j) => {
        li.classList.toggle("on", j === k);
        li.classList.toggle("done", j < k);
      });
      await this.send(s.hops[k], run);
      if (run !== this.run) return;
      this.apply(s.hops[k].then);
    }
    if (run !== this.run) return;
    hopLis.forEach((li) => {
      li.classList.remove("on");
      li.classList.add("done");
    });
    this.applied = i;
    await sleep(HOLD_MS);
    if (run !== this.run || !this.playing) return;
    void this.go((i + 1) % STEPS.length);
  }

  /** Animates one message along the wire between two neighbouring devices. */
  private async send(hop: Hop, run: number) {
    const a = ORDER.indexOf(hop.from);
    const b = ORDER.indexOf(hop.to);
    const fwd = a < b;
    const k = Math.min(a, b);
    const s = this.segs[k];
    this.activeSeg = s;
    this.setWorking(hop.from);
    $(this.msg, ".route").textContent = `${NAME[hop.from]} → ${NAME[hop.to]}`;
    $(this.msg, ".msg-text").textContent = hop.label;
    s.label.classList.add("busy");
    s.ports.forEach((p) => p.classList.add("on"));
    s.lit.style.transition = "none";
    s.lit.style.opacity = "1";
    this.msg.classList.add("on");
    if (this.reduced) {
      s.lit.style.strokeDashoffset = "0";
      this.placeMsg(s, ...this.point(s, 0.5), k);
      await sleep(900);
    } else {
      this.dot.classList.add("on");
      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const t0 = performance.now();
      for (;;) {
        await nextFrame();
        if (run !== this.run) break;
        const t = Math.min(1, (performance.now() - t0) / HOP_MS);
        const e = ease(t);
        const [x, y] = this.point(s, fwd ? e : 1 - e);
        this.dot.setAttribute("transform", `translate(${x} ${y})`);
        s.lit.style.strokeDashoffset = String(fwd ? 1 - e : e - 1);
        this.placeMsg(s, x, y, k);
        if (t >= 1) break;
      }
    }
    const clear = () => {
      s.label.classList.remove("busy");
      s.ports.forEach((p) => p.classList.remove("on"));
      s.lit.style.transition = "";
      s.lit.style.opacity = "0";
    };
    // A newer step took over mid-flight: leave the shared bubble and dot to it.
    if (run !== this.run) {
      if (this.activeSeg !== s) clear();
      return;
    }
    this.dot.classList.remove("on");
    this.msg.classList.remove("on");
    clear();
    this.setWorking(hop.to);
    this.ping(hop.to);
    await sleep(this.reduced ? 150 : GAP_MS);
  }
}

const HOW_HEAD = `<div class="sec-head">
  <span class="kicker">How it works</span>
  <h2>One sentence in.<br>The right settings out.</h2>
  <p>The phone is the only piece that talks to the camera, over Wi-Fi; the glasses reach it through the cloud. What the API can reach, the agent sets itself. What it can't, it walks you to.</p>
</div>`;

// ---------------------------------------------------------------- the four pieces and the way in

const PIECES = `<section class="pieces" id="pieces">
  <div class="wrap">
    <div class="sec-head">
      <span class="kicker">The four pieces</span>
      <h2>Hardware you already love, working as a team.</h2>
    </div>
    <div class="piece-grid">
      <article class="piece pc-cam">
        <span class="pi">${use("i-cam")}</span>
        <h3>Your camera</h3>
        <span class="tag">Wi-Fi · CCAPI</span>
        <p>Any mirrorless body with the Camera Control API switched on, on the same Wi-Fi as your phone. The agent may only touch shooting settings: exposure, metering, white balance, focus, drive, shutter type, anti-flicker and picture style. Never storage, network or power.</p>
      </article>
      <article class="piece pc-ph">
        <span class="pi">${use("i-phone")}</span>
        <h3>Phone app</h3>
        <span class="tag">Android · runs the agent</span>
        <p>Runs the agent loop and is the only piece that talks to the camera. Every change shows up as a diff, menu steps as a numbered list with Done and Skip. A shot budget, an optional “ask before shooting” and a cancel button keep you in charge.</p>
      </article>
      <article class="piece pc-cl">
        <span class="pi">${use("i-cloud")}</span>
        <h3>Cloud</h3>
        <span class="tag">Cloudflare Worker · Muse</span>
        <p>Calls the Muse model, so the API key never ships in the app. Transcribes push-to-talk and relays messages between phone and glasses over HTTPS and WebSocket.</p>
      </article>
      <article class="piece pc-gl">
        <span class="pi">${use("i-glasses")}</span>
        <h3>Ray-Ban Display</h3>
        <span class="tag">Web app on the lens</span>
        <p>Shows progress, each settings change, the menu path to follow and the last shot, so your eye stays at the viewfinder. Pinch to confirm a menu step or dictate a correction. Pair by swiping the eight arrows the phone shows.</p>
      </article>
    </div>
  </div>
</section>`;

const SCENES: Array<[string, string, string]> = [
  ["concert", "Club gig under LED lights", "“Shoot silently, but get rid of the dark stripes”"],
  ["gym", "Basketball under fluorescent lights", "“Even exposure and colour across a burst”"],
  ["group", "Group portrait in the shade", "“Get all three of them sharp”"],
];

// ---------------------------------------------------------------- the setup

const SETUP_CARDS: Array<[string, string, string]> = [
  [cameraArt("light"), "Professional camera", "Connects over Wi-Fi. The agent sets it up and takes test shots."],
  [phoneArt("light"), "Your phone", "Runs the AI agent. Say what you want, it does the rest."],
  [glassesArt("light"), "Ray-Ban Display", "Each step on the lens. Your eye stays at the viewfinder."],
];

const SETUP = `<section class="setup" id="setup">
  <div class="wrap">
    <ol class="setup-cards">
      ${SETUP_CARDS.map(([art, title, text], i) => `<li class="setup-card">
        <div class="setup-art">${art}</div>
        <h3><span class="setup-n">${i + 1}</span>${title}</h3>
        <p>${text}</p>
      </li>`).join("")}
    </ol>
  </div>
</section>`;

const KEEP_SHOOTING = `<section class="keep">
  <div class="wrap">
    <div class="keep-band">
      <div class="keep-text">
        <h2>Say what you want.<span class="g">Keep shooting.</span></h2>
        <p>One agent across the three things in your hands.</p>
        <ul>
          <li>Camera takes the shot</li>
          <li>Phone runs the agent</li>
          <li>Glasses show every step</li>
        </ul>
      </div>
      <div class="keep-stage" aria-hidden="true">
        <div class="keep-glasses">${glassesArt("dark")}</div>
        <div class="keep-camera">${cameraArt("dark")}</div>
        <div class="keep-phone">${phoneArt("dark")}</div>
        <div class="keep-bubble">“Freeze the dog mid-stride”</div>
      </div>
    </div>
  </div>
</section>`;

const TRY = `<section class="try" id="try">
  <div class="wrap">
    <div class="band">
      <div>
        <h2>Try it in your browser.</h2>
        <p>The simulated experience runs the phone app's real agent against a virtual camera that answers the same API as a real one, with exposure, focus, depth of field, motion blur and white balance worked out physically. A simulated glasses lens sits right next to it. Pick a scene, say what you want, and watch it work.</p>
        <a class="btn white" href="/try">Try the simulated experience ${use("i-arrow")}</a>
      </div>
      <div class="band-scenes">
        ${SCENES.map(([id, title, goal]) => `<figure class="band-scene"><img src="/scenes/${id}.jpg" alt="" loading="lazy"><b>${title}</b><span>${goal}</span></figure>`).join("")}
      </div>
    </div>
  </div>
</section>`;

export function startLanding(root: HTMLElement) {
  document.body.className = "landing-body";
  const flow = new Flow();
  const brand = () => h(`<a class="brand" href="/">${use("logo", "logo")}Shutter Sense</a>`);
  const hero = h(HERO);
  beforeAfter(hero);
  const paths = h(PATHS);
  paths.querySelector(".gm-menu")?.replaceWith(menuGuide(MENU_DEMO));

  root.replaceChildren(
    sprite(),
    el("header", { class: "lp-top" }, [
      el("div", { class: "wrap" }, [
        brand(),
        h(`<nav class="lp-nav" aria-label="Sections"><a href="#setup">The setup</a><a href="#settings">The settings</a><a href="#how">How it works</a><a href="#pieces">The four pieces</a></nav>`),
        el("a", { class: "btn primary small", href: "/try" }, ["Try it"]),
      ]),
    ]),
    el("main", {}, [
      hero,
      h(SETUP),
      paths,
      h(KEEP_SHOOTING),
      el("section", { class: "how", id: "how" }, [el("div", { class: "wrap" }, [h(HOW_HEAD), flow.root])]),
      h(PIECES),
      h(TRY),
    ]),
    el("footer", { class: "lp-foot" }, [
      el("div", { class: "wrap" }, [
        brand(),
        el("p", {}, ["Built for the Meta Global AI Developer Hackathon with Muse models. Works with Canon cameras via CCAPI; not affiliated with Canon."]),
      ]),
    ]),
  );
  flow.mount();
}
