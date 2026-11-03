// Shutter Sense backend (one Cloudflare Worker, static assets alongside):
//   POST /api/agent        one stateless agent step, proxied to Muse (the key never leaves here)
//   POST /api/inspire      one picture for a pose or composition idea (Muse Image), from a live-view frame or a prompt
//   POST /api/transcribe   push-to-talk audio -> text (Muse Voice Transcribe)
//   POST /api/speak        a line for the glasses -> speech (Wit.ai voices), when WIT_TOKEN is set
//   /api/rooms/...         the phone <-> glasses relay, one Durable Object per session
//   POST /api/pair         glasses trade a swiped arrow pattern for their session

import { DurableObject } from "cloudflare:workers";
import { AGENT_LIMITS, DEFAULT_MAX_SHOTS, INSPIRE_LIMITS, PRESET_LIMITS, TOOL_NAMES, type AgentContext, type AgentResponse, type PresetSummary } from "../shared/agent-api.ts";
import { cleanMenu, rewriteMenuSteps } from "../shared/menu.ts";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_RE,
  EMPTY_HUD,
  HUD_THUMB_BYTES,
  IDEA_IMAGE_BYTES,
  PATTERN_LENGTH,
  PATTERN_RE,
  PATTERN_TTL_MS,
  type ClientMessage,
  type HudState,
  type Presence,
  type Role,
  type ServerMessage,
} from "../shared/protocol.ts";
import { createResponse, editImage, generateImage, MODELS, MuseError, transcribe } from "./muse.ts";
import { MAX_SPEECH_CHARS, speak, VoiceError } from "./voice.ts";
import { buildInstructions, TOOLS } from "./prompt.ts";

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<Room>;
  BUDGET: DurableObjectNamespace<Budget>;
  LIMITER: DurableObjectNamespace<Limiter>;
  PAIR: DurableObjectNamespace<PairSlot>;
  MUSE_API_KEY: string;
  /** Optional override of the agent model (e.g. a faster Muse Spark model). */
  AGENT_MODEL?: string;
  /** Optional override of the image model for picture ideas. */
  IMAGE_MODEL?: string;
  /** Wit.ai server access token for the glasses' voice; without it the lens falls back to the browser's voices. */
  WIT_TOKEN?: string;
  /** Wit.ai voice name. */
  WIT_VOICE?: string;
}

/** Paid model calls per hour across everyone: a cap on what a public demo can spend. */
const GLOBAL_CALLS_PER_HOUR = 3000;
const MAX_AUDIO_BYTES = 8_000_000;

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "unknown";
const enc = new TextEncoder();

// ------------------------------------------------------------------ entry

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    return handleApi(request, env, ctx);
  },
};

/**
 * Every /api/* request. This Worker serves it locally; when deployed, the
 * Pages site serves it from a Pages Function (pages/functions/api), with the
 * Durable Objects bound from this Worker.
 */
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await api(request, env, new URL(request.url), ctx);
  } catch (e) {
    console.error("api error", e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
}

async function api(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const route = parts[1];

  if (route === "agent" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    return agent(request, env);
  }

  if (route === "inspire" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    return inspire(request, env);
  }

  if (route === "transcribe" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const tooMany = await limited(env, request, "voice");
    if (tooMany) return tooMany;
    const audio = await readBody(request, MAX_AUDIO_BYTES);
    if (!audio) return json({ error: "Recording too long" }, 413);
    if (audio.byteLength < 1000) return json({ error: "Recording too short" }, 400);
    if (!(await takeBudget(env))) return json({ error: "The demo is very busy right now. Try again in a few minutes." }, 429);
    try {
      return json({ text: await transcribe(env.MUSE_API_KEY, audio.buffer as ArrayBuffer) });
    } catch (e) {
      if (e instanceof MuseError) return json({ error: e.message }, e.status);
      console.error("transcribe error", e);
      return json({ error: "Transcription failed" }, 502);
    }
  }

  if (route === "speak" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.WIT_TOKEN) return json({ error: "No voice configured" }, 503);
    const tooMany = await limited(env, request, "speech");
    if (tooMany) return tooMany;
    const body = await readJson(request, 8_000);
    const text = isObj(body) && typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH_CHARS) : "";
    if (!text) return json({ error: "Nothing to say" }, 400);
    try {
      return await speak(env.WIT_TOKEN, env.WIT_VOICE || "wit$Rebecca", text, ctx);
    } catch (e) {
      return json({ error: e instanceof VoiceError ? e.message : "Speech failed" }, 502);
    }
  }

  // Glasses swiped a pattern: trade it (once) for the session's code and glasses token.
  if (route === "pair" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const tooMany = await limited(env, request, "pair");
    if (tooMany) return tooMany;
    const body = await readJson(request, 1_000);
    const pattern = isObj(body) && typeof body.pattern === "string" ? body.pattern : "";
    if (!PATTERN_RE.test(pattern)) return json({ error: `Patterns are ${PATTERN_LENGTH} moves` }, 400);
    const session = await env.PAIR.get(env.PAIR.idFromName(pattern)).claim();
    return session ? json(session) : json({ error: "No phone is showing that pattern" }, 404);
  }

  if (route !== "rooms") return json({ error: "not found" }, 404);

  if (parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const tooMany = await limited(env, request, "create");
    if (tooMany) return tooMany;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const room = await roomStub(env, code).create(code);
      if (room) return json(room);
    }
    return json({ error: "could not allocate a room" }, 503);
  }

  const code = (parts[2] ?? "").toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: `Session codes are ${CODE_LENGTH} letters` }, 400);
  const sub = parts.slice(3).join("/");
  const action = sub === "ws" || sub === "events" ? "connect" : sub === "send" ? "send" : "lookup";
  const tooMany = await limited(env, request, action);
  if (tooMany) return tooMany;
  const target = new URL("https://room/" + sub);
  target.search = url.search;
  return roomStub(env, code).fetch(target.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });
}

const roomStub = (env: Env, code: string) => env.ROOM.get(env.ROOM.idFromName(code));

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// ------------------------------------------------------------------ agent proxy

async function agent(request: Request, env: Env): Promise<Response> {
  const tooMany = await limited(env, request, "agent");
  if (tooMany) return tooMany;
  const raw = await readBody(request, AGENT_LIMITS.maxBytes);
  if (!raw) return json({ error: "Request too large: send fewer or smaller images." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "Expected JSON" }, 400);
  }
  if (!isObj(body)) return json({ error: "Expected an object" }, 400);
  const ctx = context(body.context);
  if (typeof ctx === "string") return json({ error: ctx }, 400);
  const input = sanitizeInput(body.input);
  if (typeof input === "string") return json({ error: input }, 400);
  if (!(await takeBudget(env))) return json({ error: "The demo is very busy right now. Try again in a few minutes." }, 429);

  try {
    const result = await createResponse(env.MUSE_API_KEY, {
      model: env.AGENT_MODEL || MODELS.agent,
      instructions: buildInstructions(ctx),
      tools: TOOLS,
      input,
      reasoning: { effort: "low" },
      parallel_tool_calls: true,
      store: false,
    });
    const out: AgentResponse = {
      // Only tools that exist reach the app. Menu paths come from the camera's
      // menu map, never from the model: the screens and steps are filled in here.
      calls: result.calls
        .filter((c) => (TOOL_NAMES as readonly string[]).includes(c.name))
        .map((c) => (c.name === "menu_steps" ? { ...c, arguments: rewriteMenuSteps(c.arguments, ctx.camera) } : c)),
      text: result.text,
      commentary: result.commentary,
    };
    return json(out);
  } catch (e) {
    if (e instanceof MuseError) return json({ error: e.message }, e.status);
    console.error("agent error", e);
    return json({ error: "The agent hit an unexpected error." }, 502);
  }
}

// ------------------------------------------------------------------ picture ideas

/**
 * One picture for a show_ideas idea. With a live-view frame, the image model
 * re-imagines that frame (same people, place and light, new pose); without
 * one, it makes a picture from the prompt alone.
 */
async function inspire(request: Request, env: Env): Promise<Response> {
  const tooMany = await limited(env, request, "inspire");
  if (tooMany) return tooMany;
  const body = await readJson(request, INSPIRE_LIMITS.maxBytes);
  if (!isObj(body)) return json({ error: "Expected a JSON object (images at most 1.5 MB)" }, 400);
  const prompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim().slice(0, INSPIRE_LIMITS.prompt) : "";
  if (!prompt) return json({ error: "prompt is required" }, 400);
  const image = typeof body.image === "string" ? body.image : "";
  const jpeg = image.startsWith("data:image/jpeg;base64,") ? base64Bytes(image.slice(image.indexOf(",") + 1)) : null;
  if (image && !jpeg) return json({ error: "image must be a JPEG data URL" }, 400);
  if (!(await takeBudget(env))) return json({ error: "The demo is very busy right now. Try again in a few minutes." }, 429);
  const model = env.IMAGE_MODEL || MODELS.image;
  try {
    const out = jpeg
      ? await editImage(env.MUSE_API_KEY, model, jpeg, `${EDIT_PREFIX} ${prompt}`)
      : await generateImage(env.MUSE_API_KEY, model, `${GENERATE_PREFIX} ${prompt}`);
    return json({ image: out });
  } catch (e) {
    if (e instanceof MuseError) return json({ error: e.message }, e.status);
    console.error("inspire error", e);
    return json({ error: "The picture couldn't be made." }, 502);
  }
}

const EDIT_PREFIX =
  "Edit this camera live-view photo. Keep the same people (faces, clothes), the same place, light and colours, and the same camera position and lens. Change only how the people pose and arrange themselves, as described. Photorealistic, natural, no text or graphics. The change:";
const GENERATE_PREFIX = "A natural, photorealistic photograph showing a pose and composition idea for a photographer. No text or graphics. The picture:";

/** Decoded base64, or null if it isn't valid (or is empty). */
function base64Bytes(b64: string): Uint8Array | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (!bin) return null;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function context(raw: unknown): AgentContext | string {
  if (!isObj(raw)) return "context is required";
  const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const goal = text(raw.goal, AGENT_LIMITS.maxGoal);
  if (!goal) return "context.goal is required";
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    goal,
    camera: text(raw.camera, 120) || "Camera",
    shotsTaken: n(raw.shotsTaken, 0, 50, 0),
    // Follow-up corrections raise the budget past the photographer's setting (shots taken + 3).
    maxShots: n(raw.maxShots, 1, 50, DEFAULT_MAX_SHOTS),
    askBeforeShooting: raw.askBeforeShooting === true,
    glasses: raw.glasses === true,
    presets: (Array.isArray(raw.presets) ? raw.presets : [])
      .slice(0, PRESET_LIMITS.count)
      .filter(isObj)
      .map((p): PresetSummary => ({ name: text(p.name, PRESET_LIMITS.name), note: text(p.note, PRESET_LIMITS.note), settings: text(p.settings, 400) }))
      .filter((p) => p.name),
  };
}

/**
 * Keeps only the input shapes an agent step needs (messages, function calls
 * and their outputs; text and JPEG images), within size limits.
 */
function sanitizeInput(raw: unknown): unknown[] | string {
  if (!Array.isArray(raw) || !raw.length) return "input must be a non-empty array";
  if (raw.length > AGENT_LIMITS.maxItems) return "input has too many items";
  let images = 0;
  const content = (c: unknown, allowOutput: boolean): unknown[] | string => {
    if (typeof c === "string") return [{ type: allowOutput ? "output_text" : "input_text", text: c.slice(0, 20_000) }];
    if (!Array.isArray(c)) return "bad content";
    const out: unknown[] = [];
    for (const part of c) {
      if (!isObj(part)) return "bad content part";
      if (part.type === "input_text" || (allowOutput && part.type === "output_text")) {
        out.push({ type: part.type, text: String(part.text ?? "").slice(0, 20_000) });
      } else if (part.type === "input_image") {
        const src = String(part.image_url ?? "");
        if (!src.startsWith("data:image/jpeg;base64,")) return "images must be JPEG data URLs";
        if (++images > AGENT_LIMITS.maxImages) return `at most ${AGENT_LIMITS.maxImages} images per request`;
        out.push({ type: "input_image", image_url: src });
      } else return `unsupported content type ${String(part.type)}`;
    }
    return out;
  };
  const callId = (v: unknown) => String(v).slice(0, 100);
  const items: unknown[] = [];
  for (const item of raw) {
    if (!isObj(item)) return "bad input item";
    if (item.type === "function_call") {
      items.push({ type: "function_call", call_id: callId(item.call_id), name: String(item.name).slice(0, 64), arguments: String(item.arguments ?? "{}").slice(0, 10_000) });
    } else if (item.type === "function_call_output") {
      let output: unknown;
      if (typeof item.output === "string") output = item.output.slice(0, 20_000);
      else {
        const parts = content(item.output, false);
        if (typeof parts === "string") return parts;
        output = parts;
      }
      items.push({ type: "function_call_output", call_id: callId(item.call_id), output });
    } else if (item.role === "user" || item.role === "assistant") {
      const c = content(item.content, item.role === "assistant");
      if (typeof c === "string") return c;
      items.push({ role: item.role, content: c });
    } else return "unsupported input item";
  }
  return items;
}

// ------------------------------------------------------------------ limits

/** Requests allowed per client IP: [count, window in seconds]. */
const RATE_LIMITS = {
  agent: [400, 600], // agent steps (a goal takes 5-15)
  create: [60, 3600], // new sessions
  lookup: [120, 600], // session existence checks (stops code enumeration)
  connect: [300, 600], // WebSocket / SSE connections
  send: [600, 600], // SSE-fallback messages
  voice: [60, 600], // transcriptions
  inspire: [40, 600], // idea pictures (up to four per show_ideas)
  speech: [300, 600], // lines spoken on the glasses
  say: [120, 600], // dictated instructions from the glasses
  pattern: [30, 600], // phones asking for a pairing pattern
  pair: [30, 600], // glasses swiping a pattern (stops pattern guessing)
} as const;
export type RateAction = keyof typeof RATE_LIMITS;

async function limited(env: Env, request: Request, action: RateAction): Promise<Response | null> {
  if (await env.LIMITER.get(env.LIMITER.idFromName(clientIp(request))).hit(action)) return null;
  return json({ error: "Too many requests. Wait a few minutes and try again." }, 429, { "retry-after": "60" });
}

function takeBudget(env: Env): Promise<boolean> {
  return env.BUDGET.get(env.BUDGET.idFromName("global")).take(GLOBAL_CALLS_PER_HOUR);
}

/**
 * One instance per client IP (named by the IP), counting in fixed windows.
 * Counters live in memory only: if the object is evicted they reset, which is
 * fine for abuse protection and costs no storage.
 */
export class Limiter extends DurableObject<Env> {
  private windows = new Map<string, { start: number; n: number }>();

  hit(action: RateAction): boolean {
    const [limit, seconds] = RATE_LIMITS[action];
    const now = Date.now();
    let w = this.windows.get(action);
    if (!w || now - w.start >= seconds * 1000) this.windows.set(action, (w = { start: now, n: 0 }));
    return ++w.n <= limit;
  }
}

/** Global hourly counter (one instance, named "global"). */
export class Budget extends DurableObject<Env> {
  async take(limit: number): Promise<boolean> {
    const hour = Math.floor(Date.now() / 3_600_000);
    const cur = (await this.ctx.storage.get<{ hour: number; n: number }>("c")) ?? { hour, n: 0 };
    const next = { hour, n: cur.hour === hour ? cur.n + 1 : 1 };
    await this.ctx.storage.put("c", next);
    return next.n <= limit;
  }
}

// ------------------------------------------------------------------ room

interface Stored {
  code: string;
  created: number;
  /** Secret for the phone that created the session. */
  phoneToken: string;
  /** Secret given to glasses when they pair. */
  glassesToken: string;
  hud: HudState;
  pattern: { moves: string; expires: number } | null;
  /** Last time a client connected or the phone sent a HUD. */
  active: number;
}

const ROOM_DEFAULTS: Stored = { code: "", created: 0, phoneToken: "", glassesToken: "", hud: EMPTY_HUD, pattern: null, active: 0 };
/** A session nobody has connected to or updated for this long is deleted. */
const ROOM_IDLE_MS = 24 * 60 * 60_000;
/** Largest message the room accepts from a client (a HUD with its thumbnail and idea pictures fits). */
const MAX_MESSAGE_BYTES = 256_000;
/** HUD updates a session takes per HUD_WINDOW_MS (the phone sends a few a second at most); more are dropped. */
const HUD_PER_WINDOW = 50;
const HUD_WINDOW_MS = 10_000;
/** Messages an SSE client may fall behind by before it is dropped (it reconnects and gets the latest HUD). */
const SSE_BACKLOG = 16;

interface SseClient { role: Role; writer: WritableStreamDefaultWriter<Uint8Array> }

/**
 * One per session. Relays the phone's HUD to the glasses and the wearer's
 * dictated instructions to the phone, keeps the latest HUD for glasses that
 * connect later, and offers pairing patterns.
 */
export class Room extends DurableObject<Env> {
  private s!: Stored;
  private sse = new Set<SseClient>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private hudWindow = { start: 0, n: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.s = { ...ROOM_DEFAULTS, ...(await ctx.storage.get<Stored>("state")) };
      // Sessions from before the idle clean-up have no alarm yet.
      if (this.s.created && !(await ctx.storage.getAlarm())) {
        this.s.active ||= Date.now();
        await ctx.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
      }
    });
  }

  private save() {
    return this.ctx.storage.put("state", this.s);
  }

  /** RPC from the API: starts the session under `code`. Null if the code is taken. */
  async create(code: string): Promise<{ code: string; token: string } | null> {
    if (this.s.created) return null;
    this.s.code = code;
    this.s.created = this.s.active = Date.now();
    this.s.phoneToken = crypto.randomUUID();
    this.s.glassesToken = crypto.randomUUID();
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
    return { code, token: this.s.phoneToken };
  }

  /** Forgets the session once nobody has used it for ROOM_IDLE_MS. */
  async alarm() {
    if (!this.s.created) return;
    const idleUntil = this.s.active + ROOM_IDLE_MS;
    if (this.ctx.getWebSockets().length || this.sse.size || idleUntil > Date.now()) {
      await this.ctx.storage.setAlarm(Math.max(idleUntil, Date.now() + 60 * 60_000));
      return;
    }
    await this.ctx.storage.deleteAll();
    this.s = { ...ROOM_DEFAULTS };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Same answer as any other unknown path, so probing doesn't reveal which codes exist.
    if (!this.s.created) return json({ error: "not found" }, 404);
    if (path === "/") return new Response(null, { status: 204 });

    const roleParam = url.searchParams.get("role");
    const token = url.searchParams.get("token");
    let role: Role;
    if (roleParam === "glasses" && token === this.s.glassesToken) role = "glasses";
    else if (roleParam === "phone" && token === this.s.phoneToken) role = "phone";
    else return json({ error: "Not part of this session" }, 403);

    if (path === "/ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected WebSocket" }, 426);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role, ip: clientIp(req) });
      server.send(JSON.stringify(this.hello(role)));
      this.broadcastPresence();
      await this.touch();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/events" && req.method === "GET") {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const client: SseClient = { role, writer: writable.getWriter() };
      this.sse.add(client);
      this.writeSse(client, JSON.stringify(this.hello(role)));
      this.ensureHeartbeat();
      this.broadcastPresence();
      await this.touch();
      return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
    }

    if (path === "/send" && req.method === "POST") {
      await this.handle(role, await readJson(req, MAX_MESSAGE_BYTES), clientIp(req));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
    const { role, ip = "unknown" } = ws.deserializeAttachment() as { role: Role; ip?: string };
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    await this.handle(role, msg, ip);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }

  /** RPC from a PairSlot: glasses just swiped this room's pattern. */
  async paired(moves: string) {
    if (!this.s.created) return;
    if (this.s.pattern?.moves === moves) {
      this.s.pattern = null;
      await this.save();
    }
    this.broadcast({ t: "pairing", pattern: null, expiresIn: 0 }, "phone");
  }

  /** Counts a HUD update against HUD_PER_WINDOW (WebSocket messages skip the per-IP limiter). */
  private hudAllowed() {
    const now = Date.now();
    if (now - this.hudWindow.start >= HUD_WINDOW_MS) this.hudWindow = { start: now, n: 0 };
    return ++this.hudWindow.n <= HUD_PER_WINDOW;
  }

  /** Marks the session as in use, for the idle clean-up. */
  private touch() {
    this.s.active = Date.now();
    return this.save();
  }

  private async handle(role: Role, raw: unknown, ip: string) {
    if (!isObj(raw)) return;
    const msg = raw as ClientMessage;
    switch (msg.t) {
      case "hud": {
        if (role !== "phone" || !this.hudAllowed()) return;
        const hud = cleanHud(msg.hud);
        if (!hud) return;
        this.s.hud = hud;
        await this.touch();
        this.broadcast({ t: "hud", hud }, "glasses");
        return;
      }
      case "say": {
        if (role !== "glasses") return;
        if (!(await this.env.LIMITER.get(this.env.LIMITER.idFromName(ip)).hit("say"))) return;
        const text = String(msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (text) this.broadcast({ t: "say", text }, "phone");
        return;
      }
      case "pair": {
        if (role !== "phone") return;
        if (!(await this.env.LIMITER.get(this.env.LIMITER.idFromName(ip)).hit("pattern"))) return;
        await this.offerPattern();
        return;
      }
    }
  }

  /** Shows phones a pattern for the glasses to swipe; one with time left is reused. */
  private async offerPattern() {
    const now = Date.now();
    const cur = this.s.pattern;
    if (cur && cur.expires - now > 60_000) {
      this.broadcast({ t: "pairing", pattern: cur.moves, expiresIn: cur.expires - now }, "phone");
      return;
    }
    if (cur) await this.slot(cur.moves).revoke(this.s.code);
    for (let attempt = 0; attempt < 6; attempt++) {
      const moves = randomPattern();
      const expires = now + PATTERN_TTL_MS;
      if (await this.slot(moves).offer(moves, this.s.code, this.s.glassesToken, expires)) {
        this.s.pattern = { moves, expires };
        await this.save();
        this.broadcast({ t: "pairing", pattern: moves, expiresIn: PATTERN_TTL_MS }, "phone");
        return;
      }
    }
  }

  private slot(moves: string) {
    return this.env.PAIR.get(this.env.PAIR.idFromName(moves));
  }

  private hello(role: Role): ServerMessage {
    return { t: "hello", role, hud: this.s.hud, presence: this.presence() };
  }

  private presence(): Presence {
    const open = (role: Role) => this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN).length;
    let glasses = open("glasses");
    let phones = open("phone");
    for (const c of this.sse) c.role === "glasses" ? glasses++ : phones++;
    return { glasses, phones };
  }

  private broadcastPresence() {
    this.broadcast({ t: "presence", presence: this.presence() });
  }

  private broadcast(msg: ServerMessage, only?: Role) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(only)) {
      try {
        ws.send(data);
      } catch {
        // socket is closing; presence will update on close
      }
    }
    for (const c of this.sse) if (!only || c.role === only) this.writeSse(c, data);
  }

  private writeSse(client: SseClient, data: string) {
    this.writeRaw(client, `data: ${data}\n\n`);
  }

  /** Writes to an SSE client, dropping one that has stopped reading rather than queueing for it forever. */
  private writeRaw(client: SseClient, chunk: string) {
    if ((client.writer.desiredSize ?? 0) < -SSE_BACKLOG) return this.dropSse(client);
    client.writer.write(enc.encode(chunk)).catch(() => this.dropSse(client));
  }

  private dropSse(client: SseClient) {
    if (!this.sse.delete(client)) return;
    client.writer.close().catch(() => {});
    this.broadcastPresence();
  }

  private ensureHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (!this.sse.size) {
        clearInterval(this.heartbeat!);
        this.heartbeat = null;
        return;
      }
      for (const c of this.sse) this.writeRaw(c, `: ping\n\n`);
    }, 15_000);
  }
}

/** A HUD from the phone, with every field bounded. Null if it isn't one. */
function cleanHud(raw: unknown): HudState | null {
  if (!isObj(raw)) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);
  const phases = ["idle", "working", "asking", "done", "error"] as const;
  const phase = phases.find((p) => p === raw.phase) ?? "idle";
  const shots = isObj(raw.shots) ? raw.shots : {};
  const q = isObj(raw.question) ? raw.question : null;
  const g = isObj(raw.guide) ? raw.guide : null;
  const thumb = typeof raw.thumb === "string" && raw.thumb.startsWith("data:image/jpeg;base64,") && raw.thumb.length <= HUD_THUMB_BYTES ? raw.thumb : null;
  return {
    phase,
    goal: text(raw.goal, 300),
    step: text(raw.step, 80) ?? "",
    shots: { taken: Math.max(0, Math.min(50, Number(shots.taken) || 0)), max: Math.max(0, Math.min(50, Number(shots.max) || 0)) },
    diff: Array.isArray(raw.diff) ? raw.diff.slice(0, 8).map((d) => text(d, 60) ?? "").filter(Boolean) : [],
    thumb,
    exposure: text(raw.exposure, 80),
    message: text(raw.message, 140),
    summary: text(raw.summary, 700),
    question: q && text(q.text, 140)
      ? { text: text(q.text, 140)!, options: Array.isArray(q.options) ? q.options.slice(0, 4).map((o) => text(o, 40) ?? "").filter(Boolean) : [] }
      : null,
    guide: g && text(g.setting, 60)
      ? { setting: text(g.setting, 60)!, steps: Array.isArray(g.steps) ? g.steps.slice(0, 8).map((st) => text(st, 80) ?? "").filter(Boolean) : [], menu: cleanMenu(g.menu) }
      : null,
    ideas: (Array.isArray(raw.ideas) ? raw.ideas : [])
      .slice(0, INSPIRE_LIMITS.ideas)
      .filter(isObj)
      .map((i) => ({
        title: text(i.title, INSPIRE_LIMITS.title) ?? "",
        direction: text(i.direction, INSPIRE_LIMITS.direction) ?? "",
        image: typeof i.image === "string" && i.image.startsWith("data:image/jpeg;base64,") && i.image.length <= IDEA_IMAGE_BYTES ? i.image : null,
      }))
      .filter((i) => i.title),
  };
}

function randomPattern(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(PATTERN_LENGTH)), (b) => "UDLR"[b & 3]).join("");
}

// ------------------------------------------------------------------ pairing

interface PairOffer { moves: string; code: string; token: string; expires: number }

/** One per pairing pattern (named by it). Holds the session it unlocks until swiped once or expired. */
export class PairSlot extends DurableObject<Env> {
  /** False if another session holds this pattern right now. */
  async offer(moves: string, code: string, token: string, expires: number): Promise<boolean> {
    const cur = await this.ctx.storage.get<PairOffer>("offer");
    if (cur && cur.expires > Date.now() && cur.code !== code) return false;
    await this.ctx.storage.put("offer", { moves, code, token, expires } satisfies PairOffer);
    await this.ctx.storage.setAlarm(expires);
    return true;
  }

  async revoke(code: string) {
    const cur = await this.ctx.storage.get<PairOffer>("offer");
    if (cur?.code === code) await this.ctx.storage.delete("offer");
  }

  async alarm() {
    const cur = await this.ctx.storage.get<PairOffer>("offer");
    if (cur && cur.expires <= Date.now()) await this.ctx.storage.delete("offer");
  }

  /** Claims the offer (single use): the session's code and glasses token, or null if there is none. */
  async claim(): Promise<{ code: string; token: string } | null> {
    const cur = await this.ctx.storage.get<PairOffer>("offer");
    if (!cur || cur.expires <= Date.now()) return null;
    await this.ctx.storage.delete("offer");
    await this.env.ROOM.get(this.env.ROOM.idFromName(cur.code)).paired(cur.moves);
    return { code: cur.code, token: cur.token };
  }
}

// ------------------------------------------------------------------ helpers

/** Parses a JSON body of at most `max` bytes; null if it is larger or isn't JSON. */
async function readJson(req: Request, max: number): Promise<unknown> {
  const raw = await readBody(req, max);
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

/** Reads a request body, giving up (null) as soon as it exceeds `max` bytes. */
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
