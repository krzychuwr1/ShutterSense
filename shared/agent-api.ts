// Contract between the app (Android, or the web demo) and the worker's
// /api/agent proxy. The app runs the agent loop and executes every tool on
// the camera; the worker owns the instructions and tool definitions, adds
// the API key and forwards one stateless model call per step.

export const TOOL_NAMES = ["get_camera_state", "look", "set_settings", "shoot", "tell_user", "ask_user", "finish"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

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
] as const;
export type AgentSetting = (typeof AGENT_SETTINGS)[number];

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
}

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
