// Messages between the room (one Durable Object per session) and its two
// kinds of client: the phone app, which runs the agent, and the glasses,
// which show the HUD and send dictated instructions. Identical over
// WebSocket and over the SSE + POST fallback.

import type { MenuScreen } from "./menu.ts";

export type Role = "glasses" | "phone";

export type HudPhase = "idle" | "working" | "asking" | "done" | "error";

/** Everything the lens shows. The phone sends a fresh copy whenever it changes. */
export interface HudState {
  phase: HudPhase;
  goal: string | null;
  /** Current step: "Looking…", "Shooting 2/5", "Changing settings". */
  step: string;
  shots: { taken: number; max: number };
  /** Latest settings changes, e.g. "ISO 3200 → 800". */
  diff: string[];
  /** Last shot as a small JPEG data URL (at most HUD_THUMB_BYTES). */
  thumb: string | null;
  /** Current exposure in one line: "Av f/2.8 · 1/500 · ISO 400 · +1". */
  exposure: string | null;
  /** The agent's latest note to the photographer. */
  message: string | null;
  summary: string | null;
  question: { text: string; options: string[] } | null;
  /** A setting the photographer changes by hand, with the path through the camera's menus. */
  guide: { setting: string; steps: string[]; menu: MenuScreen[] } | null;
}

export const EMPTY_HUD: HudState = {
  phase: "idle",
  goal: null,
  step: "",
  shots: { taken: 0, max: 0 },
  diff: [],
  thumb: null,
  exposure: null,
  message: null,
  summary: null,
  question: null,
  guide: null,
};

export interface Presence { glasses: number; phones: number }

export type ServerMessage =
  | { t: "hello"; role: Role; hud: HudState; presence: Presence }
  | { t: "hud"; hud: HudState }
  | { t: "presence"; presence: Presence }
  /** To the phone: what the wearer dictated (an instruction, or an answer to a question). */
  | { t: "say"; text: string }
  /** To the phone: the pattern the glasses can swipe to pair (null once used). */
  | { t: "pairing"; pattern: string | null; expiresIn: number };

export type ClientMessage =
  | { t: "hud"; hud: HudState }
  | { t: "say"; text: string }
  | { t: "pair" };

/** Session codes, six letters (24^6 ≈ 191M): short enough to type, too many to guess. */
export const CODE_LENGTH = 6;
export const CODE_RE = /^[A-Z]{6}$/;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Glasses pair by swiping a pattern the phone shows: eight moves of U/D/L/R.
 * Only 4^8 = 65,536 patterns, so each one lives a few minutes, works once,
 * and guesses are rate-limited per client.
 */
export const PATTERN_LENGTH = 8;
export const PATTERN_RE = /^[UDLR]{8}$/;
export const PATTERN_TTL_MS = 5 * 60_000;

/** Largest HUD thumbnail the room accepts (data URL length). */
export const HUD_THUMB_BYTES = 60_000;
