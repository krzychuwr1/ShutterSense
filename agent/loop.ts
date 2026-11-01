// The agent loop. Runs where the camera is (the phone; in the web demo, the
// browser): sends the transcript to /api/agent, executes the tool calls the
// model makes on the camera, appends the results, and repeats until the model
// calls finish. Calls are stateless: the full compact transcript goes up each
// time, with only the latest few images attached.

import { AGENT_SETTINGS, DEFAULT_MAX_SHOTS, type AgentContext, type AgentRequest, type AgentResponse, type FunctionCall } from "../shared/agent-api.ts";
import { statsLine, type CameraTools, type PreparedImage, type ShotResult } from "./camera-tools.ts";

export type StepKind = "goal" | "think" | "look" | "settings" | "shot" | "tell" | "ask" | "answer" | "instruction" | "done" | "error";

export interface StepEntry {
  kind: StepKind;
  text: string;
  /** Settings diff lines, or rejected changes. */
  detail?: string[];
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
  /** The run ended: finished, cancelled or failed. */
  ended(outcome: "done" | "cancelled" | "error", summary: string | null): void;
}

export interface AgentApi {
  step(req: AgentRequest, signal: AbortSignal): Promise<AgentResponse>;
}

export interface RunOptions {
  maxShots: number;
  askBeforeShooting: boolean;
  glasses: () => boolean;
  session: string;
}

/** Model steps per run, a backstop against loops. */
const MAX_ROUNDS = 30;
/** Images kept attached in the transcript; older ones are replaced by a note. */
const KEEP_IMAGES = 3;
/** Extra shots a correction after "done" gets. */
const FOLLOW_UP_SHOTS = 3;

type Item = Record<string, unknown>;

export class AgentRun {
  private input: Item[] = [];
  private pending: string[] = [];
  private shots = 0;
  private maxShots: number;
  private abort = new AbortController();
  private running = false;
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

  /** Starts a new goal. */
  async start(goal: string) {
    this.goal = goal.trim();
    this.input = [{ role: "user", content: [{ type: "input_text", text: `Goal: ${this.goal}` }] }];
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
    };
  }

  private async loop() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let summary: string | null = null;
    let outcome: "done" | "cancelled" | "error" = "done";
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        for (const t of this.pending.splice(0)) this.input.push({ role: "user", content: [{ type: "input_text", text: `[Photographer] ${t}` }] });
        this.ui.status(round === 0 ? "Thinking…" : "Deciding next step…");
        const res = await this.api.step({ session: this.opts.session, input: withRecentImages(this.input), context: this.context() }, signal);
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        // The model often says the same thing in its commentary and in tell_user; show it once.
        const told = res.calls.some((c) => c.name === "tell_user" && c.arguments.includes(res.commentary.slice(0, 24)));
        if (res.commentary && !told) this.ui.step({ kind: "think", text: res.commentary });
        if (!res.calls.length) {
          // Answered in text instead of finishing: treat that as the summary.
          summary = res.text || null;
          if (summary) this.ui.step({ kind: "done", text: summary });
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
            summary = done;
          }
        }
        if (finished) break;
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
      this.running = false;
      this.ui.status("");
      this.ui.ended(outcome, summary);
    }
  }

  /** Runs one tool call. `done` is set when the run should end (finish was called). */
  private async exec(call: FunctionCall, signal: AbortSignal): Promise<{ output: string | Item[]; done?: string }> {
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
          this.ui.status("Looking…");
          const { text: t, image } = await this.camera.look();
          this.ui.step({ kind: "look", text: "Checked live view", image: image.dataUrl });
          return { output: imageOutput(t, image) };
        }
        case "set_settings": {
          const changes: Record<string, unknown> = {};
          for (const k of AGENT_SETTINGS) if (k in args) changes[k] = args[k];
          if (!Object.keys(changes).length) return { output: "ERROR: no settings given." };
          this.ui.status("Changing settings…");
          const { applied, errors } = await this.camera.set(changes);
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
            if (!(await this.ui.confirmShot(n, reason))) return { output: "ERROR: the photographer declined this shot." };
          }
          this.ui.status(`Shooting ${n}/${this.maxShots}…`);
          const result = await this.camera.shoot(args.af !== false, n);
          this.shots = n;
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
          return { output: "Finished.", done: summary };
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

function imageOutput(text: string, image: PreparedImage): Item[] {
  return [
    { type: "input_text", text },
    { type: "input_image", image_url: image.dataUrl },
  ];
}

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
