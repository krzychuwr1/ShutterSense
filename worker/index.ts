// Second Shooter backend (one Cloudflare Worker, static assets alongside):
//   POST /api/agent        one stateless agent step, proxied to Muse (the key never leaves here)
//   POST /api/transcribe   push-to-talk audio -> text (Muse Voice Transcribe)
//   /api/rooms/...         the phone <-> glasses relay, one Durable Object per session
//   POST /api/pair         glasses trade a swiped arrow pattern for their session

import { DurableObject } from "cloudflare:workers";
import { AGENT_LIMITS, TOOL_NAMES, type AgentContext, type AgentResponse } from "../shared/agent-api.ts";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_RE,
  EMPTY_HUD,
  HUD_THUMB_BYTES,
  PATTERN_LENGTH,
  PATTERN_RE,
  PATTERN_TTL_MS,
  type ClientMessage,
  type HudState,
  type Presence,
  type Role,
  type ServerMessage,
} from "../shared/protocol.ts";
import { createResponse, MODELS, MuseError, transcribe } from "./muse.ts";
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (e) {
      console.error("api error", e);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
};

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const route = parts[1];

  if (route === "agent" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    return agent(request, env);
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
      return json({ error: e instanceof MuseError ? e.message : "Transcription failed" }, 502);
    }
  }

  // Glasses swiped a pattern: trade it (once) for the session's code and glasses token.
  if (route === "pair" && parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const tooMany = await limited(env, request, "pair");
    if (tooMany) return tooMany;
    const body = (await request.json().catch(() => null)) as { pattern?: unknown } | null;
    const pattern = typeof body?.pattern === "string" ? body.pattern : "";
    if (!PATTERN_RE.test(pattern)) return json({ error: `Patterns are ${PATTERN_LENGTH} moves` }, 400);
    const res = await env.PAIR.get(env.PAIR.idFromName(pattern)).fetch("https://pair/claim", { method: "POST" });
    return json(await res.json(), res.status);
  }

  if (route !== "rooms") return json({ error: "not found" }, 404);

  if (parts.length === 2) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const tooMany = await limited(env, request, "create");
    if (tooMany) return tooMany;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const res = await roomStub(env, code).fetch("https://room/init", { method: "POST", headers: { "x-room-code": code } });
      if (res.ok) return json(await res.json());
    }
    return json({ error: "could not allocate a room" }, 503);
  }

  const code = (parts[2] ?? "").toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: `Session codes are ${CODE_LENGTH} letters` }, 400);
  const sub = parts.slice(3).join("/");
  if (sub === "init") return json({ error: "not found" }, 404);
  const action = sub === "ws" || sub === "events" ? "connect" : sub === "send" ? "send" : "lookup";
  const tooMany = await limited(env, request, action);
  if (tooMany) return tooMany;
  const target = new URL("https://room/" + sub);
  target.search = url.search;
  const headers = new Headers(request.headers);
  headers.set("x-room-code", code);
  return roomStub(env, code).fetch(target.toString(), {
    method: request.method,
    headers,
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
      // Only tools that exist reach the app.
      calls: result.calls.filter((c) => (TOOL_NAMES as readonly string[]).includes(c.name)),
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

function context(raw: unknown): AgentContext | string {
  if (!isObj(raw)) return "context is required";
  const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const goal = text(raw.goal, AGENT_LIMITS.maxGoal);
  if (!goal) return "context.goal is required";
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  const maxShots = n(raw.maxShots, 1, 10, 5);
  return {
    goal,
    camera: text(raw.camera, 120) || "Camera",
    shotsTaken: n(raw.shotsTaken, 0, 50, 0),
    maxShots,
    askBeforeShooting: raw.askBeforeShooting === true,
    glasses: raw.glasses === true,
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
    if (typeof c === "string") return [{ type: "input_text", text: c.slice(0, 20_000) }];
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
  const items: unknown[] = [];
  for (const item of raw) {
    if (!isObj(item)) return "bad input item";
    if (item.type === "function_call") {
      items.push({ type: "function_call", call_id: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? "{}").slice(0, 10_000) });
    } else if (item.type === "function_call_output") {
      let output: unknown;
      if (typeof item.output === "string") output = item.output.slice(0, 20_000);
      else {
        const parts = content(item.output, false);
        if (typeof parts === "string") return parts;
        output = parts;
      }
      items.push({ type: "function_call_output", call_id: String(item.call_id), output });
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
}

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const defaults: Stored = { code: "", created: 0, phoneToken: "", glassesToken: "", hud: EMPTY_HUD, pattern: null };
      this.s = { ...defaults, ...(await ctx.storage.get<Stored>("state")) };
    });
  }

  private save() {
    return this.ctx.storage.put("state", this.s);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/init" && req.method === "POST") {
      if (this.s.created) return json({ error: "exists" }, 409);
      this.s.code = req.headers.get("x-room-code") ?? "";
      this.s.created = Date.now();
      this.s.phoneToken = crypto.randomUUID();
      this.s.glassesToken = crypto.randomUUID();
      await this.save();
      return json({ code: this.s.code, token: this.s.phoneToken });
    }
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
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/events" && req.method === "GET") {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const client: SseClient = { role, writer: writable.getWriter() };
      this.sse.add(client);
      this.writeSse(client, JSON.stringify(this.hello(role)));
      this.ensureHeartbeat();
      this.broadcastPresence();
      return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
    }

    if (path === "/send" && req.method === "POST") {
      await this.handle(role, await req.json().catch(() => null), clientIp(req));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string") return;
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
    if (this.s.pattern?.moves === moves) this.s.pattern = null;
    await this.save();
    this.broadcast({ t: "pairing", pattern: null, expiresIn: 0 }, "phone");
  }

  private async handle(role: Role, raw: unknown, ip: string) {
    if (!isObj(raw)) return;
    const msg = raw as ClientMessage;
    switch (msg.t) {
      case "hud": {
        if (role !== "phone") return;
        const hud = cleanHud(msg.hud);
        if (!hud) return;
        this.s.hud = hud;
        await this.save();
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
    client.writer.write(enc.encode(`data: ${data}\n\n`)).catch(() => this.dropSse(client));
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
      for (const c of this.sse) c.writer.write(enc.encode(`: ping\n\n`)).catch(() => this.dropSse(c));
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

  /** POST claims the offer (single use). */
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const cur = await this.ctx.storage.get<PairOffer>("offer");
    if (!cur || cur.expires <= Date.now()) return json({ error: "No phone is showing that pattern" }, 404);
    await this.ctx.storage.delete("offer");
    await this.env.ROOM.get(this.env.ROOM.idFromName(cur.code)).paired(cur.moves);
    return json({ code: cur.code, token: cur.token });
  }
}

// ------------------------------------------------------------------ helpers

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
