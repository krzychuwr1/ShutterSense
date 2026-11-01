// The phone app, in the browser: the same screens and the same agent loop as
// the Android app, driving the simulated camera. Goal in (typed or spoken),
// live step log with settings diffs and test shots, before/after, and the
// glasses link with arrow-pattern pairing.

import { AgentRun, type AgentApi, type RunUi, type StepEntry } from "../../agent/loop.ts";
import type { CameraTools, ShotResult } from "../../agent/camera-tools.ts";
import { DEFAULT_MAX_SHOTS, type AgentResponse } from "../../shared/agent-api.ts";
import { EMPTY_HUD, type HudState, type ServerMessage } from "../../shared/protocol.ts";
import { createRoom, RoomConn, type NewRoom } from "./conn.ts";
import { el } from "./dom.ts";
import { Recorder, transcribeBlob } from "./voice.ts";

const ARROW: Record<string, string> = { U: "↑", D: "↓", L: "←", R: "→" };

const ICONS: Record<string, string> = {
  goal: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0"/>',
  instruction: '<path d="M4 5h16v11H8l-4 4z"/>',
  think: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>',
  look: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  shot: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  tell: '<path d="M4 5h16v11H8l-4 4z"/>',
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h0"/>',
  answer: '<path d="M20 6 9 17l-5-5"/>',
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
  tell: "Agent",
  ask: "Question",
  answer: "Your answer",
  done: "Done",
  error: "Stopped",
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`secondshooter:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`secondshooter:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: setting lasts for this page only
  }
}

const session = (() => {
  try {
    let s = sessionStorage.getItem("secondshooter:session");
    if (!s) sessionStorage.setItem("secondshooter:session", (s = crypto.randomUUID()));
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
};

export interface PhoneOptions {
  /** Example goals for the current scene. */
  goals: () => string[];
  /** Short name of the camera connection, shown in the connect card. */
  cameraLabel: string;
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
  private newBtn: HTMLButtonElement;

  // run state
  private firstLook: string | null = null;
  private shots: ShotResult[] = [];
  private question: { resolve: (a: string) => void; card: HTMLElement } | null = null;
  private recorder = new Recorder();
  private hud: HudState = { ...EMPTY_HUD };
  private runSeq = 0;

  // glasses
  private room: NewRoom | null = null;
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
    this.input = el("textarea", { rows: "2", placeholder: "What do you want? e.g. “She's backlit, fix it”", "aria-label": "Goal for the agent" });
    this.goBtn = el("button", { class: "btn primary go", type: "button" }, ["Go"]);
    this.micBtn = el("button", { class: "btn icon-btn mic", type: "button", title: "Speak your goal", "aria-label": "Speak" });
    this.micBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    if (!Recorder.supported()) this.micBtn.hidden = true;
    this.cancelBtn = el("button", { class: "btn ghost small", type: "button", hidden: true }, ["Cancel"]);
    this.glassesBtn = el("button", { class: "btn ghost small glasses-btn", type: "button" }, ["Connect glasses"]);
    this.sheet = el("div", { class: "sheet", hidden: true });
    this.newBtn = el("button", { class: "btn ghost small", type: "button", hidden: true }, ["New goal"]);
    this.newBtn.addEventListener("click", () => this.reset());

    const askToggle = el("input", { type: "checkbox", checked: this.askBefore });
    askToggle.addEventListener("change", () => save("askBefore", (this.askBefore = askToggle.checked)));
    const shotsSel = el("select", { "aria-label": "Test shots per goal" }, [3, 5, 8].map((n) => el("option", { value: String(n), selected: n === this.maxShots }, [`${n} shots max`])));
    shotsSel.addEventListener("change", () => save("maxShots", (this.maxShots = Number(shotsSel.value))));

    this.root = el("div", { class: "phone-app" }, [
      el("header", { class: "app-bar" }, [
        el("div", { class: "app-title" }, [el("strong", {}, ["Second Shooter"])]),
        this.newBtn,
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
    this.cancelBtn.addEventListener("click", () => this.run.cancel());
    this.micBtn.addEventListener("click", () => this.toggleMic());
    this.glassesBtn.addEventListener("click", () => this.openGlassesSheet());
    window.addEventListener("message", (e) => this.onWindowMessage(e));

    this.run = new AgentRun(api, tools, this.ui(this.runSeq), {
      maxShots: this.maxShots,
      askBeforeShooting: this.askBefore,
      glasses: () => this.glassesOnline > 0,
      session,
    });
    this.renderChips();
    this.renderEmpty();
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
          if (this.run.busy) this.run.cancel();
          this.startGoal(g);
        });
        return b;
      }),
    );
  }

  private renderEmpty() {
    this.log.replaceChildren(
      el("div", { class: "empty" }, [
        el("p", {}, ["Tell the agent what you want from the shot. It looks through the camera, changes settings, takes test shots and checks them until the photo matches."]),
        el("p", { class: "muted" }, ["Pick an example below, type your own, or tap the mic."]),
      ]),
    );
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    if (this.question) return this.answer(text);
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

  /** Clears the run for a fresh goal. */
  private reset() {
    if (this.run.busy) this.run.cancel();
    this.runSeq++;
    this.hud = { ...EMPTY_HUD, exposure: this.hud.exposure };
    this.pushHud();
    this.firstLook = null;
    this.shots = [];
    this.compare.hidden = true;
    this.renderEmpty();
    this.setRunning(false);
    this.input.focus();
  }

  private startGoal(goal: string) {
    this.runSeq++;
    this.run = new AgentRun(api, this.tools, this.ui(this.runSeq), {
      maxShots: this.maxShots,
      askBeforeShooting: this.askBefore,
      glasses: () => this.glassesOnline > 0,
      session,
    });
    this.log.replaceChildren();
    this.firstLook = null;
    this.shots = [];
    this.compare.hidden = true;
    this.hud = { ...EMPTY_HUD, exposure: this.hud.exposure, goal, phase: "working", shots: { taken: 0, max: this.maxShots } };
    this.pushHud();
    this.setRunning(true);
    void this.run.start(goal);
  }

  /** A correction or answer from the glasses. */
  private fromGlasses(text: string) {
    if (this.question) return this.answer(text);
    this.followUpOrStart(text);
  }

  private answer(text: string) {
    const q = this.question;
    if (!q) return;
    this.question = null;
    q.card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
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
    this.input.placeholder = on ? "Correct it while it works: “a bit warmer”" : this.hud.goal ? "Follow up (“a bit brighter”) or a new goal" : "What do you want? e.g. “She's backlit, fix it”";
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
            yes.disabled = no.disabled = true;
            resolve(v);
          };
          yes.addEventListener("click", () => done(true));
          no.addEventListener("click", () => done(false));
          this.append(card);
        }),
      ask: (question, options, signal) =>
        new Promise<string>((resolve, reject) => {
          const card = this.log.lastElementChild as HTMLElement;
          this.question = { resolve, card };
          this.hud.question = { text: question, options };
          this.hud.phase = "asking";
          this.pushHud();
          signal.addEventListener("abort", () => {
            this.question = null;
            reject(new DOMException("cancelled", "AbortError"));
          });
          this.input.focus();
        }),
      ended: (outcome, summary) => {
        if (!live()) return;
        this.setRunning(false);
        this.question = null;
        this.hud.phase = outcome === "done" ? "done" : "error";
        this.hud.summary = summary;
        this.hud.question = null;
        this.hud.step = outcome === "done" ? "Done" : outcome === "cancelled" ? "Cancelled" : "Stopped";
        this.pushHud();
        this.renderCompare();
      },
    };
  }

  private addStep(e: StepEntry) {
    if (e.kind === "look" && !this.firstLook && e.image) this.firstLook = e.image;
    if (e.kind === "tell") {
      this.hud.message = e.text;
      this.pushHud();
    }
    const body = el("div", { class: "step-body" }, [el("div", { class: "step-label" }, [LABEL[e.kind] ?? e.kind]), el("div", { class: "step-text" }, [e.text])]);
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
      img.addEventListener("click", () => this.lightbox(e.image!));
      body.append(el("div", { class: `thumb ${e.kind}` }, [img]));
    }
    this.append(el("div", { class: `step ${e.kind}` }, [icon(e.kind), body]));
  }

  private append(node: HTMLElement) {
    this.log.append(node);
    node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private lightbox(src: string) {
    const box = el("div", { class: "lightbox", role: "dialog", "aria-label": "Photo" }, [el("img", { src, alt: "" })]);
    box.addEventListener("click", () => box.remove());
    document.body.append(box);
  }

  /** Before/after: the first shot (or the first live view) against the last shot. */
  private renderCompare() {
    const after = this.shots.at(-1);
    const before = this.shots.length > 1 ? this.shots[0].image.dataUrl : this.firstLook;
    if (!after || !before) return;
    const beforeLabel = this.shots.length > 1 ? "First shot" : "Before (live view)";
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
    try {
      await this.recorder.start(() => void this.toggleMic());
      this.micBtn.classList.add("rec");
    } catch {
      this.statusEl.textContent = "Microphone not available";
      this.statusEl.classList.add("on");
    }
  }

  // ---------------------------------------------------------------- glasses

  private async openGlassesSheet() {
    this.sheet.hidden = false;
    this.renderSheet();
    if (!this.room) {
      try {
        this.room = await createRoom();
        this.conn = new RoomConn(this.room.code, "phone", (m) => this.onRoom(m), () => this.renderSheet(), this.room.token);
        this.conn.start();
        this.pushHud(true);
      } catch (e) {
        this.renderSheet(e instanceof Error ? e.message : "Could not start a session");
        return;
      }
    }
    if (!this.glassesOnline) this.conn?.send({ t: "pair" });
  }

  private renderSheet(error?: string) {
    const close = el("button", { class: "btn ghost small", type: "button" }, ["Close"]);
    close.addEventListener("click", () => (this.sheet.hidden = true));
    const children: Array<Node | null> = [el("div", { class: "sheet-head" }, [el("strong", {}, ["Ray-Ban Display"]), close])];
    if (error) children.push(el("p", { class: "error-text" }, [error]));
    else if (this.glassesOnline) {
      children.push(el("p", { class: "good-text" }, ["Glasses connected. The lens shows each step, the latest settings change and the last shot. Corrections you dictate there go straight to the agent."]));
    } else if (this.pattern) {
      children.push(
        el("p", {}, ["Open Second Shooter on the glasses and swipe these arrows with the Neural Band:"]),
        el("div", { class: "arrows" }, [...this.pattern].map((m) => el("span", {}, [ARROW[m]]))),
      );
    } else children.push(el("p", { class: "muted" }, ["Getting a pairing pattern…"]));
    if (!this.glassesOnline && !error) {
      const sim = el("button", { class: "btn primary small", type: "button" }, ["No glasses? Open simulated glasses ↗"]);
      sim.addEventListener("click", () => this.openSimGlasses());
      children.push(sim);
    }
    this.sheet.replaceChildren(...children.filter((c): c is Node => !!c));
  }

  private openSimGlasses() {
    if (!this.room) return;
    this.simWindow = window.open(`/g?sim=${this.room.code}`, `glasses-${this.room.code}`, "popup,width=600,height=600");
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
        this.glassesOnline = m.presence.glasses;
        this.glassesBtn.textContent = this.glassesOnline ? "Glasses ●" : "Connect glasses";
        this.glassesBtn.classList.toggle("on", this.glassesOnline > 0);
        if (!this.sheet.hidden) this.renderSheet();
        if (this.glassesOnline > before) this.pushHud(true);
        break;
      }
      case "pairing":
        this.pattern = m.pattern;
        if (!this.sheet.hidden) this.renderSheet();
        if (m.pattern) this.simWindow?.postMessage({ type: "sim-pair", moves: m.pattern }, location.origin);
        break;
      case "say":
        this.fromGlasses(m.text);
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
