// The agent loop. Runs where the camera is (the phone; in the web demo, the
// browser): sends the transcript to /api/agent, executes the tool calls the
// model makes on the camera, appends the results, and repeats until the model
// calls finish. Calls are stateless: the full compact transcript goes up each
// time, with only the latest few images attached.

import {
  AGENT_LIMITS,
  AGENT_SETTINGS,
  cleanPreset,
  DEFAULT_MAX_SHOTS,
  INSPIRE_LIMITS,
  PRESET_LIMITS,
  presetKey,
  presetLine,
  presetSummary,
  type AgentContext,
  type AgentRequest,
  type AgentResponse,
  type FunctionCall,
  type Idea,
  type InspireRequest,
  type InspireResponse,
  type Preset,
} from "../shared/agent-api.ts";
import { cleanMenu, type MenuScreen } from "../shared/menu.ts";
import { prettyValue, SETTING_LABELS } from "../shared/settings.ts";
import { statsLine, type CameraTools, type PreparedImage, type ShotResult } from "./camera-tools.ts";

export type StepKind = "goal" | "think" | "look" | "settings" | "shot" | "guide" | "preset" | "ideas" | "tell" | "ask" | "answer" | "instruction" | "done" | "error";

export interface StepEntry {
  kind: StepKind;
  text: string;
  /** For "guide": the setting the photographer changes by hand; for "preset": the preset's name. */
  title?: string;
  /** Settings diff lines, menu steps (guide), question options (ask), the shot's exposure, or a preset's settings. */
  detail?: string[];
  /** For "ideas": the picture ideas to flip through. */
  ideas?: Idea[];
  /** For "guide": the camera menu screens to step through. */
  menu?: MenuScreen[];
  errors?: string[];
  image?: string;
}

export interface RunUi {
  step(entry: StepEntry): void;
  /** The current activity, for the status line and the lens ("Looking…", "Shooting 2/5"). */
  status(text: string): void;
  shot(result: ShotResult): void;
  /** Settings or exposure changed. */
  exposure(line: string, diff: string[]): void;
  /** "Ask before shooting" is on: may the agent take shot `n`? */
  confirmShot(n: number, reason: string): Promise<boolean>;
  ask(question: string, options: string[], signal: AbortSignal): Promise<string>;
  /** The photographer says they set a menu setting by hand (a simulated camera applies it). */
  handSet?(setting: string, value: string): Promise<void>;
  /** The run ended: finished, cancelled or failed. `lens` is the summary cut to one line for the glasses. */
  ended(outcome: "done" | "cancelled" | "error", summary: string | null, lens: string | null): void;
}

export interface AgentApi {
  step(req: AgentRequest, signal: AbortSignal): Promise<AgentResponse>;
  /** One idea picture (POST /api/inspire). Without it, show_ideas shows the ideas as text. */
  inspire?(req: InspireRequest, signal: AbortSignal): Promise<InspireResponse>;
}

/** Where the phone keeps the photographer's presets. */
export interface PresetStore {
  list(): Preset[];
  /** Adds the preset, replacing one with the same name (see presetKey). */
  save(preset: Preset): void;
}

export interface RunOptions {
  maxShots: number;
  askBeforeShooting: boolean;
  glasses: () => boolean;
  session: string;
  presets?: PresetStore;
}

/** Model steps per run, a backstop against loops. */
const MAX_ROUNDS = 30;
/** Images kept attached in the transcript; older ones are replaced by a note. */
const KEEP_IMAGES = 3;
/** Most transcript items sent per step (under the worker's limit); older tool rounds are dropped. */
const MAX_ITEMS = AGENT_LIMITS.maxItems - 10;
/** Extra shots a correction after "done" gets. */
const FOLLOW_UP_SHOTS = 3;
/** Long side of idea pictures: they go to the lens too, so they stay small. */
const IDEA_SIDE = 400;
/** Longest summary the glasses' lens shows. */
const LENS_MAX = 90;

/** One line for the lens: the model's own short version, or the summary's first sentence, cut at a word. */
export function lensLine(summary: string, short = ""): string {
  const s = short.trim() || summary.trim().split(/(?<=[.!?])\s+/)[0];
  if (s.length <= LENS_MAX) return s;
  const cut = s.slice(0, LENS_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), LENS_MAX / 2)).replace(/[,;:\s]+$/, "")}…`;
}

type Item = Record<string, unknown>;

export class AgentRun {
  private input: Item[] = [];
  private pending: string[] = [];
  private shots = 0;
  private maxShots: number;
  private abort = new AbortController();
  private running = false;
  /** Settles when the current loop has ended (camera calls included). */
  private finished: Promise<void> = Promise.resolve();
  private goal = "";
  private api: AgentApi;
  private camera: CameraTools;
  private ui: RunUi;
  private opts: RunOptions;
  private cameraName = "Camera";

  constructor(api: AgentApi, camera: CameraTools, ui: RunUi, opts: RunOptions) {
    this.api = api;
    this.camera = camera;
    this.ui = ui;
    this.opts = opts;
    this.maxShots = opts.maxShots || DEFAULT_MAX_SHOTS;
  }

  get busy() {
    return this.running;
  }

  get shotsTaken() {
    return this.shots;
  }

  get shotBudget() {
    return this.maxShots;
  }

  /**
   * Starts a new goal, after a run that is still winding down (cancel it
   * first) has ended. Cancelling while it waits cancels this start too.
   */
  async start(goal: string) {
    if (this.running) {
      this.cancel();
      const waiting = (this.abort = new AbortController());
      await this.finished;
      // Cancelled meanwhile, or another start got in first.
      if (waiting.signal.aborted || this.running) return;
    }
    this.goal = goal.trim();
    this.input = [{ role: "user", content: [{ type: "input_text", text: `Goal: ${this.goal}` }] }];
    this.pending = [];
    this.shots = 0;
    this.maxShots = this.opts.maxShots || DEFAULT_MAX_SHOTS;
    this.ui.step({ kind: "goal", text: this.goal });
    this.cameraName = this.camera.describe();
    await this.loop();
  }

  /** A correction from the photographer: queued while running, or a follow-up run after one ended. */
  async instruct(text: string) {
    const t = text.trim();
    if (!t) return;
    this.ui.step({ kind: "instruction", text: t });
    if (this.running && this.abort.signal.aborted) {
      // Cancelled but still finishing a camera call: the correction is a follow-up once it has ended.
      const waiting = (this.abort = new AbortController());
      await this.finished;
      if (waiting.signal.aborted) return;
    }
    if (this.running) {
      this.pending.push(t);
      return;
    }
    if (!this.goal) return this.start(t);
    this.pending.push(t);
    this.maxShots = this.shots + FOLLOW_UP_SHOTS;
    await this.loop();
  }

  cancel() {
    this.abort.abort();
  }

  private context(): AgentContext {
    return {
      goal: this.goal,
      camera: this.cameraName,
      shotsTaken: this.shots,
      maxShots: this.maxShots,
      askBeforeShooting: this.opts.askBeforeShooting,
      glasses: this.opts.glasses(),
      presets: (this.opts.presets?.list() ?? []).map(presetSummary),
    };
  }

  private loop(): Promise<void> {
    if (this.running) return this.finished;
    this.running = true;
    this.finished = this.rounds();
    return this.finished;
  }

  private async rounds() {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let summary: string | null = null;
    let lens: string | null = null;
    let outcome: "done" | "cancelled" | "error" = "done";
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        for (const t of this.pending.splice(0)) this.input.push({ role: "user", content: [{ type: "input_text", text: `[Photographer] ${t}` }] });
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        this.ui.status(round === 0 ? "Thinking…" : "Deciding next step…");
        const res = await this.api.step({ session: this.opts.session, input: withRecentImages(withoutOldRounds(this.input)), context: this.context() }, signal);
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        // The model often says the same thing in its commentary and in tell_user; show it once.
        const told = res.calls.some((c) => c.name === "tell_user" && c.arguments.includes(res.commentary.slice(0, 24)));
        if (res.commentary && !told) this.ui.step({ kind: "think", text: res.commentary });
        if (!res.calls.length) {
          // Answered in text instead of finishing: treat that as the summary.
          if (res.text) {
            this.input.push({ role: "assistant", content: [{ type: "output_text", text: res.text }] });
            summary = res.text;
            lens = lensLine(summary);
            this.ui.step({ kind: "done", text: summary });
          }
          // A correction that arrived while the model was answering still gets its turn.
          if (this.pending.length) continue;
          break;
        }
        for (const c of res.calls) this.input.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments });
        let finished = false;
        for (const call of res.calls) {
          if (signal.aborted) throw new DOMException("cancelled", "AbortError");
          const { output, done } = await this.exec(call, signal);
          this.input.push({ type: "function_call_output", call_id: call.call_id, output });
          if (done !== undefined) {
            finished = true;
            summary = done.summary;
            lens = done.lens;
          }
        }
        // As above: a correction sent while the model was finishing reopens the run.
        if (finished && !this.pending.length) break;
        if (round === MAX_ROUNDS - 1) this.ui.step({ kind: "error", text: "Stopped: the agent took too many steps." });
      }
    } catch (e) {
      if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        outcome = "cancelled";
        this.ui.step({ kind: "error", text: "Cancelled." });
      } else {
        outcome = "error";
        this.ui.step({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      // Calls cut short still need an output, or a follow-up run's transcript is invalid.
      this.answerOpenCalls(outcome === "cancelled" ? "ERROR: cancelled by the photographer." : "ERROR: the run stopped before this call finished.");
      this.running = false;
      this.ui.status("");
      this.ui.ended(outcome, summary, lens);
    }
  }

  private answerOpenCalls(output: string) {
    const answered = new Set(this.input.filter((i) => i.type === "function_call_output").map((i) => i.call_id));
    const open = this.input.filter((i) => i.type === "function_call" && !answered.has(i.call_id));
    for (const c of open) this.input.push({ type: "function_call_output", call_id: c.call_id, output });
  }

  /** Runs one tool call. `done` is set when the run should end (finish was called). */
  private async exec(call: FunctionCall, signal: AbortSignal): Promise<{ output: string | Item[]; done?: { summary: string; lens: string } }> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || "{}");
      if (typeof args !== "object" || args === null) throw new Error();
    } catch {
      return { output: "ERROR: arguments were not a JSON object." };
    }
    const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    try {
      switch (call.name) {
        case "get_camera_state": {
          this.ui.status("Reading the camera…");
          return { output: await this.camera.getState() };
        }
        case "look": {
          const zoom = Math.trunc(Number(args.zoom)) > 0 ? Math.trunc(Number(args.zoom)) : undefined;
          this.ui.status(zoom ? "Checking focus…" : "Looking…");
          const { text: t, image } = await this.camera.look(zoom);
          this.ui.step({ kind: "look", text: zoom ? `Checked focus at ${zoom}×` : "Checked live view", image: image.dataUrl });
          return { output: imageOutput(t, image) };
        }
        case "detect_flicker": {
          const kind = args.kind === "high_frequency" ? "high_frequency" : "mains";
          this.ui.status("Checking the lights for flicker…");
          const { applied, text: t } = await this.camera.detectFlicker(kind);
          if (applied.length) {
            this.ui.step({ kind: "settings", text: text(args.reason, 160) || "Matched the shutter to the flickering light", detail: applied });
            this.ui.exposure(this.camera.exposureLine(), applied);
          } else this.ui.step({ kind: "tell", text: t.slice(0, 140) });
          return { output: t };
        }
        case "focus": {
          // Number(null), Number("") and Number(true) are numbers too; only real numbers count.
          const coord = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
          const x = coord(args.x);
          const y = coord(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { output: "ERROR: x and y must be numbers from 0 to 1." };
          this.ui.status("Moving the AF point…");
          const { applied, text: t } = await this.camera.focusAt(x, y);
          this.ui.step({ kind: "settings", text: text(args.reason, 160) || "Moved the AF point", detail: applied });
          this.ui.exposure(this.camera.exposureLine(), applied);
          return { output: t };
        }
        case "set_settings": {
          const changes: Record<string, unknown> = {};
          for (const k of AGENT_SETTINGS) if (k in args) changes[k] = args[k];
          if (args.style_detail && typeof args.style_detail === "object") changes.style_detail = args.style_detail;
          if (!Object.keys(changes).length) return { output: "ERROR: no settings given." };
          this.ui.status("Changing settings…");
          const { applied, errors } = await this.camera.set(changes, signal);
          const reason = text(args.reason, 160);
          this.ui.step({ kind: "settings", text: reason || "Changed settings", detail: applied, errors });
          const line = this.camera.exposureLine();
          this.ui.exposure(line, applied);
          const parts = [applied.length ? `Applied: ${applied.join("; ")}.` : "Nothing changed."];
          if (errors.length) parts.push(`Rejected: ${errors.join(" ")}`);
          parts.push(`Exposure now: ${line}.`);
          return { output: parts.join("\n") };
        }
        case "shoot": {
          if (this.shots >= this.maxShots) return { output: `ERROR: all ${this.maxShots} test shots are used. Call finish with the best result so far.` };
          const n = this.shots + 1;
          const reason = text(args.reason, 160);
          if (this.opts.askBeforeShooting) {
            this.ui.status(`Waiting for your OK to take shot ${n}…`);
            if (!(await untilAborted(this.ui.confirmShot(n, reason), signal))) return { output: "ERROR: the photographer declined this shot." };
          }
          this.ui.status(`Shooting ${n}/${this.maxShots}…`);
          // Counted before the press: a shot whose download fails was still taken.
          this.shots = n;
          const result = await this.camera.shoot(args.af !== false, n, signal);
          this.ui.shot(result);
          this.ui.step({ kind: "shot", text: reason ? `Shot ${n}: ${reason}` : `Shot ${n}`, detail: [result.exposure], image: result.image.dataUrl });
          const left = this.maxShots - n;
          return { output: imageOutput(`Shot ${n} of ${this.maxShots} (${left} left). Taken at ${result.exposure}. ${statsLine(result.image.stats)}`, result.image) };
        }
        case "tell_user": {
          const t = text(args.text, 140);
          if (!t) return { output: "ERROR: text is empty." };
          this.ui.step({ kind: "tell", text: t });
          return { output: "Shown." };
        }
        case "menu_steps": {
          const setting = text(args.setting, 60);
          const steps = Array.isArray(args.steps) ? args.steps.map((st) => text(st, 80)).filter(Boolean).slice(0, 8) : [];
          if (!setting || !steps.length) return { output: "ERROR: give the setting and the steps." };
          this.ui.step({ kind: "guide", title: setting, text: text(args.why, 160), detail: steps, menu: cleanMenu(args.screens) });
          this.ui.status("Waiting for you to change it on the camera…");
          const answer = await this.ui.ask(`Set ${setting} on the camera`, ["Done", "Skip"], signal);
          this.ui.step({ kind: "answer", text: answer });
          if (answer !== "Skip" && this.ui.handSet) await this.ui.handSet(setting, text(args.value, 40));
          return { output: answer === "Skip" ? `The photographer skipped ${setting}.` : `The photographer says ${setting} is set (${answer}).` };
        }
        case "save_preset": {
          const store = this.opts.presets;
          if (!store) return { output: "ERROR: this app can't store presets." };
          const name = text(args.name, PRESET_LIMITS.name);
          if (!name) return { output: "ERROR: give the preset a name." };
          const existing = store.list();
          if (existing.length >= PRESET_LIMITS.count && !existing.some((p) => presetKey(p.name) === presetKey(name))) {
            return { output: `ERROR: the phone already holds ${PRESET_LIMITS.count} presets; the photographer has to delete one first.` };
          }
          this.ui.status("Saving the preset…");
          const keys = Array.isArray(args.keys) ? args.keys.map(String) : undefined;
          const preset = cleanPreset({ name, note: args.note, settings: await this.camera.snapshot(keys), menu: args.menu, saved: new Date().toISOString() });
          if (!preset) return { output: "ERROR: the preset couldn't be saved." };
          store.save(preset);
          this.ui.step({ kind: "preset", title: preset.name, text: preset.note || "Saved as a preset", detail: presetLines(preset) });
          return { output: `Saved preset "${preset.name}": ${presetLine(preset)}.` };
        }
        case "apply_preset": {
          const want = presetKey(text(args.name, PRESET_LIMITS.name));
          const presets = this.opts.presets?.list() ?? [];
          const preset = presets.find((p) => presetKey(p.name) === want);
          if (!preset) return { output: `ERROR: no preset called "${text(args.name, 40)}". Saved presets: ${presets.map((p) => p.name).join(", ") || "none"}.` };
          this.ui.status(`Applying ${preset.name}…`);
          const { applied, errors } = await this.camera.set(preset.settings, signal);
          this.ui.step({ kind: "settings", text: `Applied preset "${preset.name}"`, detail: applied, errors });
          const line = this.camera.exposureLine();
          this.ui.exposure(line, applied);
          const parts = [applied.length ? `Applied: ${applied.join("; ")}.` : "The camera already matched the preset."];
          if (errors.length) parts.push(`Rejected: ${errors.join(" ")}`);
          // The matched speed depends on the lights where the photographer is now, so it isn't stored.
          if (preset.settings.hfantiflickershoot === "enable") parts.push("HF anti-flicker is on in this preset: call detect_flicker with kind high_frequency to match these lights.");
          if (preset.menu.length) {
            parts.push(`Set by hand in the menus (call menu_steps for each one that isn't set yet): ${preset.menu.map((m) => `${m.setting} = ${m.value}`).join("; ")}.`);
          }
          parts.push(`Exposure now: ${line}.`);
          return { output: parts.join("\n") };
        }
        case "show_ideas": {
          const ideas = (Array.isArray(args.ideas) ? args.ideas : [])
            .slice(0, INSPIRE_LIMITS.ideas)
            .map((i) => (i && typeof i === "object" ? (i as Record<string, unknown>) : {}))
            .map((i) => ({ title: text(i.title, INSPIRE_LIMITS.title), direction: text(i.direction, INSPIRE_LIMITS.direction), prompt: text(i.prompt, INSPIRE_LIMITS.prompt) }))
            .filter((i) => i.title && i.prompt);
          if (!ideas.length) return { output: "ERROR: give at least one idea with a title and a prompt." };
          let frame: string | undefined;
          if (args.from_camera === true) {
            this.ui.status("Looking…");
            frame = (await this.camera.look()).image.dataUrl;
          }
          this.ui.status(ideas.length === 1 ? "Picturing the idea…" : `Picturing ${ideas.length} ideas…`);
          const inspire = this.api.inspire?.bind(this.api);
          const failures: string[] = [];
          // All at once: each picture takes a while.
          const pictures = await Promise.all(
            ideas.map(async (idea) => {
              if (!inspire) return null;
              try {
                const res = await inspire({ session: this.opts.session, prompt: idea.prompt, ...(frame ? { image: frame } : {}) }, signal);
                return await this.camera.ideaPicture(res.image, IDEA_SIDE);
              } catch (e) {
                if (signal.aborted) throw e;
                failures.push(e instanceof Error ? e.message : String(e));
                return null;
              }
            }),
          );
          const shown: Idea[] = ideas.map((i, k) => ({ title: i.title, direction: i.direction, image: pictures[k] }));
          this.ui.step({ kind: "ideas", text: frame ? "Ideas for this scene" : "Ideas", ideas: shown });
          const made = pictures.filter(Boolean).length;
          const note = !inspire
            ? "This app shows them as text only."
            : made < ideas.length
              ? `${made} of ${ideas.length} pictures were made (${failures[0] ?? "unknown error"}); the rest show as text.`
              : "";
          return { output: `Showed ${ideas.length} ideas on the phone and the lens: ${ideas.map((i) => i.title).join("; ")}. ${note}`.trim() };
        }
        case "ask_user": {
          const q = text(args.question, 160);
          const options = Array.isArray(args.options) ? args.options.map((o) => text(o, 40)).filter(Boolean).slice(0, 4) : [];
          if (!q) return { output: "ERROR: question is empty." };
          this.ui.step({ kind: "ask", text: q, detail: options });
          this.ui.status("Waiting for your answer…");
          const answer = await this.ui.ask(q, options, signal);
          this.ui.step({ kind: "answer", text: answer });
          return { output: `The photographer answered: ${answer}` };
        }
        case "finish": {
          const summary = text(args.summary, 900) || "Done.";
          this.ui.step({ kind: "done", text: summary });
          return { output: "Finished.", done: { summary, lens: lensLine(summary, text(args.lens, 200)) } };
        }
        default:
          return { output: `ERROR: unknown tool ${call.name}.` };
      }
    } catch (e) {
      if (signal.aborted) throw e;
      return { output: `ERROR: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/** A preset's settings, one per line, as the photographer reads them. */
export function presetLines(p: Preset): string[] {
  const lines = Object.entries(p.settings).map(([k, v]) => {
    const label = SETTING_LABELS[k] ?? (k === "style_detail" ? "Style detail" : k);
    if (v && typeof v === "object") return `${label}: ${Object.entries(v).map(([f, n]) => `${SETTING_LABELS[f] ?? f} ${n}`).join(", ")}`;
    return `${label}: ${k === "iso" ? String(v) : prettyValue(k, v as string | number)}`;
  });
  return [...lines, ...p.menu.map((m) => `${m.setting} (by hand): ${m.value}`)];
}

function imageOutput(text: string, image: PreparedImage): Item[] {
  return [
    { type: "input_text", text },
    { type: "input_image", image_url: image.dataUrl },
  ];
}

/** `p`, or an AbortError as soon as `signal` aborts (for UI prompts that don't watch the signal). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("cancelled", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The transcript within MAX_ITEMS: the oldest tool rounds give way to a note,
 * while the goal and the photographer's messages stay (only the latest of
 * them when even they don't fit). Cuts fall between rounds, so a call and
 * its output always go together.
 */
export function withoutOldRounds(input: Item[], max = MAX_ITEMS): Item[] {
  if (input.length <= max) return input;
  for (let k = 2; k < input.length; k++) {
    if (input[k].type === "function_call_output" || input[k - 1].type === "function_call") continue;
    const messages = input.slice(1, k).filter((i) => i.role === "user");
    if (messages.length + input.length - k + 2 > max) continue;
    return [input[0], ...messages, PRUNED_NOTE, ...input.slice(k)];
  }
  // Even the photographer's messages don't fit: keep the latest of them and the last round.
  for (let k = input.length - 1; k >= 2; k--) {
    if (input[k].type === "function_call_output" || input[k - 1].type === "function_call") continue;
    const room = max - (input.length - k) - 2;
    if (room < 0) break;
    const messages = input.slice(1, k).filter((i) => i.role === "user");
    return [input[0], ...messages.slice(messages.length - room), PRUNED_NOTE, ...input.slice(k)];
  }
  return input;
}

const PRUNED_NOTE: Item = { role: "user", content: [{ type: "input_text", text: "[Earlier steps removed to keep the request small.]" }] };

/** A copy of the transcript with only the last KEEP_IMAGES images attached. */
export function withRecentImages(input: Item[]): Item[] {
  let keep = KEEP_IMAGES;
  const out: Item[] = new Array(input.length);
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    const parts = item.type === "function_call_output" ? item.output : item.content;
    if (!Array.isArray(parts) || !parts.some((p) => (p as Item).type === "input_image")) {
      out[i] = item;
      continue;
    }
    if (keep > 0) {
      keep--;
      out[i] = item;
      continue;
    }
    const stripped = (parts as Item[]).map((p) => (p.type === "input_image" ? { type: "input_text", text: "[older image removed]" } : p));
    out[i] = item.type === "function_call_output" ? { ...item, output: stripped } : { ...item, content: stripped };
  }
  return out;
}
