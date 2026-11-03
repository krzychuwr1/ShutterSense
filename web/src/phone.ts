// The phone app, in the browser: the same screens and the same agent loop as
// the Android app, driving the simulated camera. Goal in (typed or spoken),
// live step log with settings diffs and test shots, before/after, and the
// glasses link with arrow-pattern pairing.

import { AgentRun, presetLines, type AgentApi, type PresetStore, type RunUi, type StepEntry } from "../../agent/loop.ts";
import type { CameraTools, ShotResult } from "../../agent/camera-tools.ts";
import { cleanPreset, DEFAULT_MAX_SHOTS, PRESET_LIMITS, presetKey, type AgentResponse, type Idea, type InspireResponse, type Preset } from "../../shared/agent-api.ts";
import { EMPTY_HUD, shotReply, type HudState, type ServerMessage } from "../../shared/protocol.ts";
import { createRoom, RoomConn, type NewRoom } from "./conn.ts";
import { arrow, icon as spriteIcon } from "./brand.ts";
import { menuGuide } from "./camera-menu.ts";
import { el, h, lightbox } from "./dom.ts";
import { Recorder, transcribeBlob } from "./voice.ts";


const ICONS: Record<string, string> = {
  goal: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0"/>',
  instruction: '<path d="M4 5h16v11H8l-4 4z"/>',
  think: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>',
  look: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  shot: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  guide: '<path d="M9 11V5.5a1.8 1.8 0 0 1 3.6 0V11m0-1.2a1.8 1.8 0 0 1 3.6 0V12m0-1a1.8 1.8 0 0 1 3.6 0v3.5A6.5 6.5 0 0 1 13.3 21h-1a6 6 0 0 1-4.6-2.2L4.6 15a1.9 1.9 0 0 1 2.8-2.5L9 14"/>',
  tell: '<path d="M4 5h16v11H8l-4 4z"/>',
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h0"/>',
  answer: '<path d="M20 6 9 17l-5-5"/>',
  preset: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  ideas: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3Z"/>',
  done: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h0"/>',
};

const icon = (k: string) => {
  const span = el("span", { class: "ico", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] ?? ICONS.think}</svg>`;
  return span;
};

const LABEL: Record<string, string> = {
  goal: "Goal",
  instruction: "You",
  think: "Agent",
  look: "Look",
  settings: "Settings",
  shot: "Test shot",
  guide: "Camera menu",
  preset: "Saved preset",
  ideas: "Ideas",
  tell: "Agent",
  ask: "Question",
  answer: "Your answer",
  done: "Done",
  error: "Stopped",
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`shuttersense:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`shuttersense:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: setting lasts for this page only
  }
}

const session = (() => {
  try {
    let s = sessionStorage.getItem("shuttersense:session");
    if (!s) sessionStorage.setItem("shuttersense:session", (s = crypto.randomUUID()));
    return s;
  } catch {
    return crypto.randomUUID();
  }
})();

const api: AgentApi = {
  async step(req, signal) {
    const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal });
    const data = (await res.json().catch(() => ({}))) as AgentResponse & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `The agent is unavailable (HTTP ${res.status}).`);
    return data;
  },
  async inspire(req, signal) {
    const res = await fetch("/api/inspire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal });
    const data = (await res.json().catch(() => ({}))) as InspireResponse & { error?: string };
    if (!res.ok || !data.image) throw new Error(data.error ?? `No picture (HTTP ${res.status}).`);
    return data;
  },
};

/** The photographer's presets, in this browser. */
const presets: PresetStore & { remove(name: string): void } = {
  list: () => (load<unknown[]>("presets", []) ?? []).map(cleanPreset).filter((p): p is Preset => !!p),
  save(preset) {
    const rest = presets.list().filter((p) => presetKey(p.name) !== presetKey(preset.name));
    save("presets", [...rest, preset].slice(-PRESET_LIMITS.count));
  },
  remove(name) {
    save("presets", presets.list().filter((p) => presetKey(p.name) !== presetKey(name)));
  },
};

export interface PhoneOptions {
  /** Example goals for the current scene. */
  goals: () => string[];
  /** Short name of the camera connection, shown in the connect card. */
  cameraLabel: string;
  /** Shows simulated glasses at `url` (embedded in the page) and returns their window; without it they open in a pop-up. */
  simGlasses?: (url: string) => Window | null;
  /** The photographer set a menu setting on the camera by hand: the simulated camera applies it. */
  handSet?: (setting: string, value: string) => Promise<void>;
}

export class PhoneApp {
  readonly root: HTMLElement;
  private tools: CameraTools;
  private opts: PhoneOptions;
  private run: AgentRun;
  private askBefore = load("askBefore", false);
  private maxShots = load("maxShots", DEFAULT_MAX_SHOTS);

  // elements
  private camStatus: HTMLElement;
  private exposureEl: HTMLElement;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private goBtn: HTMLButtonElement;
  private micBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private chips: HTMLElement;
  private compare: HTMLElement;
  private glassesBtn: HTMLButtonElement;
  private sheet: HTMLElement;
  /** Which sheet is open over the app: glasses updates must not redraw the presets sheet. */
  private sheetOpen: "glasses" | "presets" | null = null;
  private newBtn: HTMLButtonElement;
  private presetsBtn: HTMLButtonElement;

  // run state
  /** The first live view taken before the agent changed anything: the camera's own idea of the shot. */
  private firstLook: string | null = null;
  private settingsTouched = false;
  private shots: ShotResult[] = [];
  private question: { resolve: (a: string) => void; card: HTMLElement } | null = null;
  /** Answers the open "Take test shot n?" card. */
  private confirming: ((ok: boolean) => void) | null = null;
  private recorder = new Recorder();
  private micStarting = false;
  private hud: HudState = { ...EMPTY_HUD };
  private runSeq = 0;

  // glasses
  private room: NewRoom | null = null;
  private roomReady: Promise<void> | null = null;
  private conn: RoomConn | null = null;
  private glassesOnline = 0;
  private pattern: string | null = null;
  private simWindow: Window | null = null;
  private hudTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tools: CameraTools, opts: PhoneOptions) {
    this.tools = tools;
    this.opts = opts;
    this.camStatus = el("span", { class: "cam-status" }, ["Connecting…"]);
    this.exposureEl = el("div", { class: "exposure-line" }, [""]);
    this.log = el("div", { class: "log", "aria-live": "polite" });
    this.statusEl = el("div", { class: "run-status" });
    this.chips = el("div", { class: "chips" });
    this.compare = el("div", { class: "compare", hidden: true });
    this.input = el("textarea", { rows: "2", placeholder: "What do you want? e.g. “Freeze the dog mid-stride”", "aria-label": "Goal for the agent" });
    this.goBtn = el("button", { class: "btn primary go", type: "button" }, ["Go"]);
    this.micBtn = el("button", { class: "btn icon-btn mic", type: "button", title: "Speak your goal", "aria-label": "Speak" });
    this.micBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    if (!Recorder.supported()) this.micBtn.hidden = true;
    this.cancelBtn = el("button", { class: "btn ghost small", type: "button", hidden: true }, ["Cancel"]);
    this.glassesBtn = el("button", { class: "btn ghost small glasses-btn", type: "button" }, ["Connect glasses"]);
    this.sheet = el("div", { class: "sheet", hidden: true });
    this.newBtn = el("button", { class: "btn ghost small new-btn", type: "button", hidden: true }, ["New goal"]);
    this.newBtn.addEventListener("click", () => this.reset());
    this.presetsBtn = el("button", { class: "btn ghost small presets-btn", type: "button", title: "Saved presets" }, ["Presets"]);
    this.presetsBtn.addEventListener("click", () => this.openPresets());

    const askToggle = el("input", { type: "checkbox", checked: this.askBefore });
    askToggle.addEventListener("change", () => save("askBefore", (this.askBefore = askToggle.checked)));
    const shotsSel = el("select", { "aria-label": "Test shots per goal" }, [3, 5, 8].map((n) => el("option", { value: String(n), selected: n === this.maxShots }, [`${n} shots max`])));
    shotsSel.addEventListener("change", () => save("maxShots", (this.maxShots = Number(shotsSel.value))));

    this.root = el("div", { class: "phone-app" }, [
      el("header", { class: "app-bar" }, [
        el("div", { class: "app-title" }, [spriteIcon("logo", "logo"), el("span", { class: "app-name" }, ["Shutter Sense"])]),
        this.newBtn,
        this.presetsBtn,
        this.glassesBtn,
      ]),
      el("div", { class: "connect-card" }, [
        el("span", { class: "dot" }),
        el("div", { class: "connect-text" }, [el("div", { class: "connect-name" }, [opts.cameraLabel]), this.camStatus]),
      ]),
      this.exposureEl,
      this.log,
      el("div", { class: "composer" }, [
        this.statusEl,
        this.chips,
        el("div", { class: "composer-row" }, [this.input, this.micBtn, this.goBtn]),
        el("div", { class: "options-row" }, [el("label", { class: "toggle" }, [askToggle, " Ask before shooting"]), shotsSel, this.cancelBtn]),
      ]),
      this.sheet,
    ]);

    this.goBtn.addEventListener("click", () => this.submit());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.cancelBtn.addEventListener("click", () => this.cancelRun());
    this.micBtn.addEventListener("click", () => this.toggleMic());
    this.glassesBtn.addEventListener("click", () => this.openGlassesSheet());
    window.addEventListener("message", (e) => this.onWindowMessage(e));

    this.run = this.newRun();
    this.renderChips();
    this.renderEmpty();
  }

  /** A fresh run with the current options; callbacks from earlier runs are ignored from now on. */
  private newRun(): AgentRun {
    return new AgentRun(api, this.tools, this.ui(++this.runSeq), {
      maxShots: this.maxShots,
      askBeforeShooting: this.askBefore,
      glasses: () => this.glassesOnline > 0,
      session,
      presets,
    });
  }

  // ---------------------------------------------------------------- camera

  async connect() {
    try {
      const name = await this.tools.connect();
      this.camStatus.textContent = `Connected · ${name.replace(/^.*?, lens /, "")}`;
      this.root.classList.add("connected");
      await this.refreshExposure();
    } catch (e) {
      this.camStatus.textContent = `Not connected: ${e instanceof Error ? e.message : e}`;
    }
  }

  /** The scene (or something else outside the agent) changed the camera. */
  async cameraChanged() {
    this.reset();
    this.renderChips();
    await this.connect();
  }

  private async refreshExposure() {
    await this.tools.refresh();
    this.setExposure(this.tools.exposureLine());
  }

  private setExposure(line: string) {
    this.exposureEl.replaceChildren(el("span", { class: "label" }, ["Camera"]), line);
    this.hud.exposure = line;
    this.pushHud();
  }

  // ---------------------------------------------------------------- goals

  private renderChips() {
    this.chips.replaceChildren(
      ...this.opts.goals().map((g) => {
        const b = el("button", { class: "chip", type: "button" }, [g]);
        b.addEventListener("click", () => {
          this.cancelRun();
          this.startGoal(g);
        });
        return b;
      }),
    );
  }

  private renderEmpty() {
    this.log.replaceChildren(
      el("div", { class: "empty" }, [
        el("span", { class: "empty-mark" }, [spriteIcon("i-cam")]),
        el("p", { class: "empty-title" }, ["What do you want from the shot?"]),
        el("p", {}, ["The agent looks through the camera, changes the settings that matter, takes test shots and checks them until the photo matches. Settings it can't reach, it walks you to on the camera's menu."]),
        el("p", { class: "muted" }, ["Pick an example below, type your own, or tap the mic."]),
      ]),
    );
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.dispatch(text);
  }

  /** Typed, dictated or from the glasses: answers an open question or shot approval, else a goal or a correction. */
  private dispatch(text: string) {
    if (this.question) return this.answer(text);
    if (this.confirming) {
      const ok = shotReply(text);
      // Neither yes nor no: a correction, queued before the skip so the agent's next step sees it.
      if (ok === null) this.followUpOrStart(text);
      return this.confirming(ok ?? false);
    }
    this.followUpOrStart(text);
  }

  /** While a goal is open, text is a correction ("a bit warmer"); otherwise a new goal. */
  private followUpOrStart(text: string) {
    if (this.run.busy || this.hud.goal) {
      this.setRunning(true);
      this.hud.phase = "working";
      this.pushHud();
      void this.run.instruct(text);
    } else this.startGoal(text);
  }

  /** Stops the run, and answers an open "Take test shot n?" card with No so its buttons go dead. */
  private cancelRun() {
    if (!this.run.busy) return;
    this.run.cancel();
    this.confirming?.(false);
  }

  /** Clears the run for a fresh goal. */
  private reset() {
    this.cancelRun();
    // A new run object: the cancelled one stays busy while it winds down, and
    // text typed meanwhile must start a goal rather than go to it as a correction.
    this.run = this.newRun();
    this.hud = { ...EMPTY_HUD, exposure: this.hud.exposure };
    this.pushHud();
    this.firstLook = null;
    this.settingsTouched = false;
    this.shots = [];
    this.compare.hidden = true;
    this.renderEmpty();
    this.setRunning(false);
    this.input.focus({ preventScroll: true });
  }

  private startGoal(goal: string) {
    this.run = this.newRun();
    this.log.replaceChildren();
    this.firstLook = null;
    this.settingsTouched = false;
    this.shots = [];
    this.compare.hidden = true;
    this.hud = { ...EMPTY_HUD, exposure: this.hud.exposure, goal, phase: "working", shots: { taken: 0, max: this.maxShots } };
    this.pushHud();
    this.setRunning(true);
    void this.run.start(goal);
  }

  private answer(text: string) {
    const q = this.question;
    if (!q) return;
    this.question = null;
    q.card.querySelectorAll<HTMLButtonElement>(".options button").forEach((b) => (b.disabled = true));
    q.card.classList.add("answered");
    this.hud.question = null;
    this.hud.phase = "working";
    this.pushHud();
    q.resolve(text);
  }

  private setRunning(on: boolean) {
    this.root.classList.toggle("running", on);
    this.cancelBtn.hidden = !on;
    this.goBtn.textContent = on || this.hud.goal ? "Send" : "Go";
    this.newBtn.hidden = !this.hud.goal;
    this.input.placeholder = on ? "Correct it while it works: “a bit warmer”" : this.hud.goal ? "Follow up (“a bit brighter”) or a new goal" : "What do you want? e.g. “Freeze the dog mid-stride”";
  }

  // ---------------------------------------------------------------- agent UI

  /** Callbacks for run number `id`; a cancelled run's late callbacks are ignored. */
  private ui(id: number): RunUi {
    const live = () => id === this.runSeq;
    return {
      step: (e) => live() && this.addStep(e),
      status: (text) => {
        if (!live()) return;
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle("on", !!text);
        if (text) {
          this.hud.step = text;
          this.pushHud();
        }
      },
      shot: (r) => {
        if (!live()) return;
        this.shots.push(r);
        this.hud.thumb = r.thumb;
        this.hud.shots = { taken: r.n, max: this.run.shotBudget };
        this.pushHud();
      },
      exposure: (line, diff) => {
        if (!live()) return;
        this.setExposure(line);
        if (diff.length) {
          this.hud.diff = diff;
          this.pushHud();
        }
      },
      confirmShot: (n, reason) =>
        new Promise<boolean>((resolve) => {
          const yes = el("button", { class: "btn primary small", type: "button" }, ["Shoot"]);
          const no = el("button", { class: "btn ghost small", type: "button" }, ["Skip"]);
          const card = el("div", { class: "step ask" }, [
            icon("shot"),
            el("div", { class: "step-body" }, [
              el("div", { class: "step-label" }, [`Take test shot ${n}?`]),
              reason ? el("div", { class: "step-text" }, [reason]) : null,
              el("div", { class: "options" }, [yes, no]),
            ]),
          ]);
          const done = (v: boolean) => {
            if (this.confirming !== done) return;
            this.confirming = null;
            yes.disabled = no.disabled = true;
            if (live()) {
              this.hud.question = null;
              this.hud.phase = "working";
              this.pushHud();
            }
            resolve(v);
          };
          this.confirming = done;
          // On the lens too, answered with its buttons or by voice.
          if (live()) {
            this.hud.question = { text: `Take shot ${n}?`, options: ["Shoot", "Skip"] };
            this.hud.phase = "asking";
            this.pushHud();
          }
          yes.addEventListener("click", () => done(true));
          no.addEventListener("click", () => done(false));
          this.append(card);
        }),
      ask: (question, options, signal) =>
        new Promise<string>((resolve, reject) => {
          const card = this.log.lastElementChild as HTMLElement;
          const cancelled = () => {
            if (this.question?.card === card) this.question = null;
            card.querySelectorAll<HTMLButtonElement>(".options button").forEach((b) => (b.disabled = true));
            reject(new DOMException("cancelled", "AbortError"));
          };
          if (signal.aborted) return cancelled();
          signal.addEventListener("abort", cancelled, { once: true });
          this.question = { resolve, card };
          this.hud.question = { text: question, options };
          this.hud.phase = "asking";
          this.pushHud();
          this.input.focus({ preventScroll: true });
        }),
      handSet: async (setting, value) => {
        await this.opts.handSet?.(setting, value).catch(() => undefined);
      },
      ended: (outcome, _summary, lens) => {
        if (!live()) return;
        this.setRunning(false);
        this.question = null;
        this.hud.phase = outcome === "done" ? "done" : "error";
        this.hud.summary = lens;
        this.hud.question = null;
        this.hud.step = outcome === "done" ? "Done" : outcome === "cancelled" ? "Cancelled" : "Stopped";
        this.pushHud();
        this.renderCompare();
      },
    };
  }

  private addStep(e: StepEntry) {
    // The lens shows what the photographer asked for last, not only the first goal.
    if (e.kind === "instruction") {
      this.hud.goal = e.text;
      this.pushHud();
    }
    if (e.kind === "look" && !this.firstLook && !this.settingsTouched && e.image) this.firstLook = e.image;
    if (e.kind === "settings" && e.detail?.length) this.settingsTouched = true;
    // Menu steps stay on the lens until the photographer has done them.
    if (e.kind === "guide") {
      this.hud.guide = { setting: e.title ?? "", steps: e.detail ?? [], menu: e.menu ?? [] };
      this.pushHud();
    } else if (this.hud.guide && e.kind !== "ask" && e.kind !== "answer") {
      this.hud.guide = null;
      this.pushHud();
    }
    if (e.kind === "tell") {
      this.hud.message = e.text;
      this.pushHud();
    }
    if (e.kind === "ideas" && e.ideas?.length) {
      this.hud.ideas = e.ideas;
      this.pushHud();
    }
    const body = el("div", { class: "step-body" }, [el("div", { class: "step-label" }, [LABEL[e.kind] ?? e.kind]), el("div", { class: "step-text" }, [e.text])]);
    if (e.kind === "guide") {
      // The run waits on this card: the photographer sets it by hand, then taps Done (or Skip).
      const reply = (label: string, cls: string) => el("button", { class: `btn ${cls} small`, type: "button", onclick: () => this.answer(label) }, [label]);
      body.replaceChildren(el("div", { class: "step-label" }, ["On the camera · set it by hand"]), el("div", { class: "guide-title" }, [e.title ?? ""]));
      if (e.text) body.append(el("div", { class: "guide-why" }, [e.text]));
      // The camera's own menu screens when the agent drew them; the numbered taps otherwise.
      if (e.menu?.length) body.append(menuGuide(e.menu));
      else body.append(el("ol", { class: "guide-steps" }, (e.detail ?? []).map((st) => el("li", {}, [st]))));
      body.append(el("div", { class: "options guide-options" }, [reply("Done", "primary"), reply("Skip", "ghost")]));
    }
    if (e.kind === "preset") {
      body.replaceChildren(el("div", { class: "step-label" }, [LABEL.preset]), el("div", { class: "guide-title" }, [e.title ?? ""]), el("div", { class: "step-text" }, [e.text]));
      body.append(el("div", { class: "diff" }, (e.detail ?? []).map((d) => el("span", { class: "diff-chip preset-chip" }, [d]))));
    }
    if (e.kind === "ideas" && e.ideas?.length) body.append(this.ideaStrip(e.ideas));
    if (e.kind === "settings" && e.detail?.length) body.append(el("div", { class: "diff" }, e.detail.map((d) => el("span", { class: "diff-chip" }, [d]))));
    if (e.errors?.length) body.append(el("div", { class: "errors" }, e.errors.map((d) => el("div", {}, [d]))));
    if (e.kind === "shot" && e.detail?.length) body.append(el("div", { class: "shot-meta" }, [e.detail[0]]));
    if (e.kind === "ask" && e.detail?.length) {
      body.append(
        el(
          "div",
          { class: "options" },
          e.detail.map((o) => {
            const b = el("button", { class: "btn ghost small", type: "button" }, [o]);
            b.addEventListener("click", () => this.answer(o));
            return b;
          }),
        ),
      );
    }
    if (e.image) {
      const img = el("img", { src: e.image, alt: e.kind === "shot" ? "Test shot" : "Live view frame", loading: "lazy" });
      img.addEventListener("click", () => lightbox(e.image!));
      body.append(el("div", { class: `thumb ${e.kind}` }, [img]));
    }
    this.append(el("div", { class: `step ${e.kind}` }, [icon(e.kind), body]));
  }

  /** Idea cards to scroll through; "Try this" tells the agent which one. */
  private ideaStrip(ideas: Idea[]): HTMLElement {
    return el(
      "div",
      { class: "idea-strip" },
      ideas.map((idea) => {
        const pic = idea.image
          ? el("img", { src: idea.image, alt: idea.title, loading: "lazy", onclick: () => lightbox(idea.image!) })
          : el("div", { class: "idea-blank", "aria-hidden": "true" }, [icon("ideas")]);
        const pick = el("button", { class: "btn ghost small", type: "button", onclick: () => this.dispatch(`Let's try "${idea.title}": ${idea.direction}`) }, ["Try this"]);
        return el("figure", { class: "idea" }, [pic, el("figcaption", {}, [el("strong", {}, [idea.title]), el("span", {}, [idea.direction]), pick])]);
      }),
    );
  }

  // ---------------------------------------------------------------- presets

  private openPresets() {
    this.showSheet("presets");
    this.renderPresets();
  }

  private showSheet(kind: "glasses" | "presets") {
    this.sheetOpen = kind;
    this.sheet.hidden = false;
  }

  private closeSheet() {
    this.sheetOpen = null;
    this.sheet.hidden = true;
  }

  private renderPresets() {
    const close = el("button", { class: "btn ghost small", type: "button", onclick: () => this.closeSheet() }, ["Close"]);
    const rows = presets.list().map((p) => {
      const use = el("button", { class: "btn primary small", type: "button" }, ["Use"]);
      use.addEventListener("click", () => {
        this.closeSheet();
        this.dispatch(`Apply my preset "${p.name}"`);
      });
      const del = el("button", { class: "btn ghost small", type: "button" }, ["Delete"]);
      del.addEventListener("click", () => {
        presets.remove(p.name);
        this.renderPresets();
      });
      return el("div", { class: "preset-row" }, [
        el("div", { class: "preset-head" }, [el("strong", {}, [p.name]), el("div", { class: "preset-actions" }, [use, del])]),
        p.note ? el("p", { class: "muted" }, [p.note]) : null,
        el("div", { class: "diff" }, presetLines(p).map((d) => el("span", { class: "diff-chip preset-chip" }, [d]))),
      ]);
    });
    this.sheet.replaceChildren(
      el("div", { class: "sheet-head" }, [el("strong", {}, ["Presets"]), close]),
      ...(rows.length ? rows : [el("p", { class: "muted" }, ["None yet. Once a shot looks right, say “save this as club night”; later, “use my club night preset”."])]),
    );
  }

  private append(node: HTMLElement) {
    this.log.append(node);
    // Scroll the log only, so the page around the phone stays put.
    const instant = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.log.scrollTo({ top: this.log.scrollHeight, behavior: instant ? "auto" : "smooth" });
  }

  /**
   * Before/after: the camera's own settings (live view before the agent
   * changed anything) against the last shot. Without that view, the first
   * test shot stands in.
   */
  private renderCompare() {
    const after = this.shots.at(-1);
    const before = this.firstLook ?? (this.shots.length > 1 ? this.shots[0].image.dataUrl : null);
    if (!after || !before) return;
    const beforeLabel = this.firstLook ? "Camera's settings" : "First shot";
    const top = el("img", { src: after.image.dataUrl, alt: "After", class: "after" });
    const range = el("input", { type: "range", min: "0", max: "100", value: "50", "aria-label": "Compare before and after" });
    const frame = el("div", { class: "compare-frame" }, [el("img", { src: before, alt: "Before" }), top, el("div", { class: "compare-handle" }), range]);
    const set = () => {
      frame.style.setProperty("--split", `${range.value}%`);
    };
    range.addEventListener("input", set);
    set();
    this.compare.replaceChildren(
      el("div", { class: "compare-head" }, [el("span", {}, [beforeLabel]), el("strong", {}, ["Before / after"]), el("span", {}, [`Shot ${after.n}`])]),
      frame,
    );
    this.compare.hidden = false;
    this.append(this.compare);
  }

  // ---------------------------------------------------------------- voice

  private async toggleMic() {
    if (this.recorder.recording) {
      this.micBtn.classList.remove("rec");
      const wav = await this.recorder.stop();
      if (!wav) return;
      this.statusEl.textContent = "Transcribing…";
      this.statusEl.classList.add("on");
      try {
        const text = await transcribeBlob(wav);
        this.statusEl.textContent = "";
        this.statusEl.classList.remove("on");
        if (text) {
          this.input.value = text;
          this.submit();
        }
      } catch (e) {
        this.statusEl.textContent = e instanceof Error ? e.message : "Transcription failed";
      }
      return;
    }
    // A second tap while the browser asks for the microphone would open a second recording.
    if (this.micStarting) return;
    this.micStarting = true;
    try {
      await this.recorder.start(() => void this.toggleMic());
      this.micBtn.classList.add("rec");
    } catch {
      this.statusEl.textContent = "Microphone not available";
      this.statusEl.classList.add("on");
    } finally {
      this.micStarting = false;
    }
  }

  // ---------------------------------------------------------------- glasses

  private async openGlassesSheet() {
    this.showSheet("glasses");
    this.renderSheet();
    try {
      await this.ensureRoom();
    } catch (e) {
      this.updateSheet(e instanceof Error ? e.message : "Could not start a session");
    }
  }

  /** Redraws the glasses sheet if it is the one open. */
  private updateSheet(error?: string) {
    if (this.sheetOpen === "glasses") this.renderSheet(error);
  }

  private setGlassesOnline(n: number) {
    this.glassesOnline = n;
    this.glassesBtn.textContent = n ? "Glasses" : "Connect glasses";
    this.glassesBtn.classList.toggle("on", n > 0);
  }

  /** Starts a glasses session (once) and asks for a pairing pattern unless glasses are already on. */
  private async ensureRoom() {
    // Shared while the session is being created, so a second tap doesn't open a second one.
    this.roomReady ??= createRoom().then(
      (room) => {
        this.room = room;
        this.conn = new RoomConn(room.code, "phone", (m) => this.onRoom(m), () => this.updateSheet(), room.token, () => this.roomGone());
        this.conn.start();
        this.pushHud(true);
      },
      (e: unknown) => {
        this.roomReady = null;
        throw e;
      },
    );
    await this.roomReady;
    if (!this.glassesOnline) this.conn?.send({ t: "pair" });
  }

  /** Pairs simulated glasses without the sheet (the demo page's "Connect" button). */
  async connectSimGlasses() {
    await this.ensureRoom();
    this.openSimGlasses();
  }

  /** The glasses session expired: the next "Connect glasses" starts a new one. */
  private roomGone() {
    this.room = this.roomReady = this.conn = this.pattern = null;
    this.setGlassesOnline(0);
    this.updateSheet("The glasses session expired. Connect again to start a new one.");
  }

  private renderSheet(error?: string) {
    const close = el("button", { class: "btn ghost small", type: "button" }, ["Close"]);
    close.addEventListener("click", () => this.closeSheet());
    const children: Array<Node | null> = [el("div", { class: "sheet-head" }, [el("strong", {}, ["Ray-Ban Display"]), close])];
    if (error) children.push(el("p", { class: "error-text" }, [error]));
    else if (this.glassesOnline) {
      children.push(el("p", { class: "good-text" }, ["Glasses connected. The lens shows each step, the latest settings change and the last shot. Corrections you dictate there go straight to the agent."]));
    } else if (this.pattern) {
      children.push(
        el("p", {}, ["Open Shutter Sense on the glasses and swipe these arrows with the Neural Band:"]),
        el("div", { class: "arrows" }, [...this.pattern].map((m) => el("span", {}, [h(arrow(m))]))),
      );
    } else children.push(el("p", { class: "muted" }, ["Getting a pairing pattern…"]));
    if (!this.glassesOnline && !error) {
      const sim = el("button", { class: "btn primary small", type: "button" }, [this.opts.simGlasses ? "No glasses? Use the simulated glasses" : "No glasses? Open simulated glasses ↗"]);
      sim.addEventListener("click", () => this.openSimGlasses());
      children.push(sim);
    }
    this.sheet.replaceChildren(...children.filter((c): c is Node => !!c));
  }

  private openSimGlasses() {
    if (!this.room) return;
    const url = `/g?sim=${this.room.code}`;
    if (this.opts.simGlasses) {
      this.simWindow = this.opts.simGlasses(url);
      this.closeSheet();
    } else this.simWindow = window.open(url, `glasses-${this.room.code}`, "popup,width=600,height=600");
  }

  /** The simulated glasses window says it's ready: hand it the pattern to swipe. */
  private onWindowMessage(e: MessageEvent) {
    if (e.origin !== location.origin || e.source !== this.simWindow) return;
    if ((e.data as { type?: string })?.type === "sim-ready" && this.pattern) this.simWindow?.postMessage({ type: "sim-pair", moves: this.pattern }, location.origin);
  }

  private onRoom(m: ServerMessage) {
    switch (m.t) {
      case "hello":
      case "presence": {
        const before = this.glassesOnline;
        this.setGlassesOnline(m.presence.glasses);
        this.updateSheet();
        if (this.glassesOnline > before) this.pushHud(true);
        break;
      }
      case "pairing":
        this.pattern = m.pattern;
        this.updateSheet();
        if (m.pattern) this.simWindow?.postMessage({ type: "sim-pair", moves: m.pattern }, location.origin);
        break;
      case "say":
        this.dispatch(m.text);
        break;
    }
  }

  /** Sends the HUD to the glasses (debounced). */
  private pushHud(now = false) {
    if (!this.conn) return;
    if (this.hudTimer) clearTimeout(this.hudTimer);
    const send = () => {
      this.hudTimer = null;
      this.conn?.send({ t: "hud", hud: this.hud });
    };
    if (now) send();
    else this.hudTimer = setTimeout(send, 120);
  }
}
