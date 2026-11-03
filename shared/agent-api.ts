// Contract between the app (Android, or the web demo) and the worker's
// /api/agent proxy. The app runs the agent loop and executes every tool on
// the camera; the worker owns the instructions and tool definitions, adds
// the API key and forwards one stateless model call per step.

export const TOOL_NAMES = [
  "get_camera_state",
  "look",
  "set_settings",
  "focus",
  "detect_flicker",
  "shoot",
  "menu_steps",
  "save_preset",
  "apply_preset",
  "show_ideas",
  "tell_user",
  "ask_user",
  "finish",
] as const;

/** Settings the agent may change. Never storage, formats, network or power. */
export const AGENT_SETTINGS = [
  "shootingmode",
  "av",
  "tv",
  "iso",
  "exposure",
  "wb",
  "colortemperature",
  "metering",
  "afoperation",
  "afmethod",
  "drive",
  "picturestyle",
  "flash",
  "shuttermode",
  "trackingsetting",
  "stillimageaspectratio",
  "wbshift",
  "antiflickershoot",
  "hfantiflickershoot",
  "hfflickertv",
] as const;

/** Picture style fine-tuning the agent may change (on the current style). */
export const STYLE_DETAIL_FIELDS = ["contrast", "saturation", "sharpness_strength", "colortone"] as const;

/** What the app tells the worker about the current run; it ends up in the instructions. */
export interface AgentContext {
  /** The photographer's goal, as they said it. */
  goal: string;
  /** Camera model and lens, e.g. "EOS R6 Mark II, RF 85mm F1.8". */
  camera: string;
  shotsTaken: number;
  maxShots: number;
  /** The photographer approves each shot on the phone. */
  askBeforeShooting: boolean;
  /** Glasses are paired: tell_user lines show on the lens. */
  glasses: boolean;
  /** The photographer's saved presets, for apply_preset (see presetLine). */
  presets?: PresetSummary[];
}

// ------------------------------------------------------------ presets

/** A setting the photographer sets by hand in the camera's menus (the API can't), kept in a preset. */
export interface MenuSetting {
  setting: string;
  value: string;
}

/**
 * Named camera settings the photographer can come back to ("club night").
 * Saved by the agent's save_preset on the phone (never on the server); the
 * agent sees a one-line summary of each and applies one with apply_preset.
 */
export interface Preset {
  name: string;
  /** What it is for, in the agent's words ("Dimmed LED stages, silent shutter"). */
  note: string;
  /** Agent setting -> value, as get_camera_state reports them (wbshift and style_detail are objects). */
  settings: Record<string, unknown>;
  /** Settings the photographer sets by hand; apply_preset hands them back to the agent for menu_steps. */
  menu: MenuSetting[];
  /** ISO date. */
  saved: string;
}

export interface PresetSummary {
  name: string;
  note: string;
  /** "Tv 1/1307 · ISO auto · servo AF …; by hand: HDR Mode Auto". */
  settings: string;
}

export const PRESET_LIMITS = { count: 20, name: 40, note: 120, menu: 4 } as const;

/** Preset names match ignoring case and spacing. */
export const presetKey = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

/** A stored preset made safe (from storage, or an agent's save); null if it isn't one. */
export function cleanPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const name = text(r.name, PRESET_LIMITS.name);
  if (!name) return null;
  const settings: Record<string, unknown> = {};
  const s = r.settings && typeof r.settings === "object" && !Array.isArray(r.settings) ? (r.settings as Record<string, unknown>) : {};
  for (const k of AGENT_SETTINGS) {
    const v = s[k];
    if (typeof v === "string" && v) settings[k] = v.slice(0, 40);
    else if (typeof v === "number" && Number.isFinite(v)) settings[k] = v;
    else if (k === "wbshift" && v && typeof v === "object") {
      const w = v as Record<string, unknown>;
      settings[k] = { ba: Math.round(Number(w.ba) || 0), mg: Math.round(Number(w.mg) || 0) };
    }
  }
  const d = s.style_detail;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const detail = Object.fromEntries(STYLE_DETAIL_FIELDS.filter((f) => Number.isFinite(Number((d as Record<string, unknown>)[f]))).map((f) => [f, Math.round(Number((d as Record<string, unknown>)[f]))]));
    if (Object.keys(detail).length) settings.style_detail = detail;
  }
  const menu = (Array.isArray(r.menu) ? r.menu : [])
    .map((m) => (m && typeof m === "object" ? { setting: text((m as MenuSetting).setting, 60), value: text((m as MenuSetting).value, 40) } : null))
    .filter((m): m is MenuSetting => !!m && !!m.setting && !!m.value)
    .slice(0, PRESET_LIMITS.menu);
  return { name, note: text(r.note, PRESET_LIMITS.note), settings, menu, saved: text(r.saved, 40) || new Date(0).toISOString() };
}

/** A preset's settings in one line, for the agent's instructions and the phone's preset list. */
export function presetLine(p: Preset): string {
  const parts = Object.entries(p.settings).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const line = parts.join(", ");
  return p.menu.length ? `${line}; by hand: ${p.menu.map((m) => `${m.setting} ${m.value}`).join(", ")}` : line;
}

export const presetSummary = (p: Preset): PresetSummary => ({ name: p.name, note: p.note, settings: presetLine(p).slice(0, 400) });

// ------------------------------------------------------------ ideas

/**
 * One picture idea from show_ideas: a pose, composition or angle, with what
 * to tell the subject, and a generated picture of it (null if the image model
 * failed; the idea still shows as text).
 */
export interface Idea {
  title: string;
  /** What to tell the people in the photo, or where to stand. */
  direction: string;
  /** JPEG data URL. */
  image: string | null;
}

/** POST /api/inspire: one picture for one idea. */
export interface InspireRequest {
  session: string;
  /** What the picture shows (from the agent). */
  prompt: string;
  /** A live-view frame (JPEG data URL) to re-imagine; without it the picture is made from the prompt alone. */
  image?: string;
}

export interface InspireResponse {
  /** JPEG data URL (WebP or PNG if the image model ignored the format asked for); the app shrinks it to a small JPEG. */
  image: string;
}

export const INSPIRE_LIMITS = { prompt: 600, maxBytes: 1_500_000, ideas: 4, title: 40, direction: 120 } as const;

export interface AgentRequest {
  /** Random id per app install or browser tab, for rate limiting. */
  session: string;
  /** Responses API input items: messages, function calls and their outputs. */
  input: unknown[];
  context: AgentContext;
}

export interface FunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface AgentResponse {
  calls: FunctionCall[];
  /** Final text, when the model answered without a tool call. */
  text: string;
  /** The model's short note on what it is about to do ("commentary" phase). */
  commentary: string;
}

/** Limits the worker enforces on a request. */
export const AGENT_LIMITS = {
  maxItems: 120,
  maxImages: 6,
  maxBytes: 4_000_000,
  maxGoal: 500,
};

/** Default number of test shots per goal. */
export const DEFAULT_MAX_SHOTS = 5;
