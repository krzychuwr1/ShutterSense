// Camera menu screens for settings the control API can't change. The worker
// looks the setting up in a camera menu map (shared/menus/) and turns it
// into screens: the tab page with every row in order, then each sub-screen
// down to the value. The phone, the glasses and the web demo draw them in
// the style of the camera's own menus, so the photographer can follow along
// on the body.

import { MIRRORLESS } from "./menus/mirrorless.ts";

export const MENU_TABS = ["shoot", "af", "play", "wireless", "setup", "custom", "mymenu"] as const;
export type MenuTab = (typeof MENU_TABS)[number];

/** How each tab is named in hints. */
export const MENU_TAB_NAMES: Record<MenuTab, string> = {
  shoot: "SHOOT",
  af: "AF",
  play: "PLAY",
  wireless: "NETWORK",
  setup: "SET UP",
  custom: "CUSTOM",
  mymenu: "MY MENU",
};

/** How each tab is named in the written steps: the camera's name and the tab's colour. */
const TAB_STEP: Record<MenuTab, string> = {
  shoot: "Shooting (red)",
  af: "AF (pink)",
  play: "Playback (blue)",
  wireless: "Communication functions (purple)",
  setup: "Set-up (yellow)",
  custom: "Custom Functions (orange)",
  mymenu: "My Menu (green)",
};

export interface MenuScreen {
  tab: MenuTab;
  /** A tab page: its number, 1-based. Absent on a sub-screen. */
  page?: number;
  /** How many pages the tab has, for the page row. */
  pages?: number;
  /** A sub-screen's title (the setting), or a page's own heading (e.g. "Servo AF"). */
  title?: string;
  /** Rows on this page or option list, in menu order (at most 8). */
  items: string[];
  /** What each row shows on the right ("" for nothing), aligned with `items`. */
  values?: string[];
  /** Rows the camera shows greyed out. */
  dim?: string[];
  /** The option currently set (the camera shows it in blue). */
  current?: string;
  /** The row to pick; one of `items`. */
  select: string;
  /** The options drop down beside the row instead of filling the screen. */
  popup?: boolean;
  /** The camera model the screens come from (on the first screen). */
  model?: string;
}

/** Most screens a guide may have, rows per screen, and characters per row and value. */
export const MENU_LIMITS = { screens: 6, items: 8, text: 40, value: 24 } as const;

/** A screen list (from the worker, or relayed to the glasses) made safe to draw: known tabs, bounded text, the selection among the rows. */
export function cleanMenu(raw: unknown): MenuScreen[] {
  if (!Array.isArray(raw)) return [];
  const clip = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const text = (v: unknown) => clip(v, MENU_LIMITS.text);
  const count = (v: unknown) => {
    const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 && n < 20 ? n : undefined;
  };
  const out: MenuScreen[] = [];
  for (const s of raw.slice(0, MENU_LIMITS.screens)) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const tab = MENU_TABS.find((t) => t === r.tab);
    const rawItems = Array.isArray(r.items) ? r.items.slice(0, MENU_LIMITS.items) : [];
    const rawValues = Array.isArray(r.values) ? r.values : [];
    const items: string[] = [];
    const values: string[] = [];
    rawItems.forEach((it, i) => {
      const t = text(it);
      if (!t) return;
      items.push(t);
      values.push(clip(rawValues[i], MENU_LIMITS.value));
    });
    const select = text(r.select);
    if (!tab || !select) continue;
    if (!items.includes(select)) {
      if (items.length >= MENU_LIMITS.items) {
        items.pop();
        values.pop();
      }
      items.push(select);
      values.push("");
    }
    const screen: MenuScreen = { tab, items, select };
    const page = count(r.page);
    if (page) screen.page = page;
    const pages = count(r.pages);
    if (pages && page && pages >= page) screen.pages = pages;
    const title = text(r.title);
    if (title) screen.title = title;
    if (values.some(Boolean)) screen.values = values;
    const dim = Array.isArray(r.dim) ? r.dim.map(text).filter((d) => d && d !== select && items.includes(d)) : [];
    if (dim.length) screen.dim = dim;
    const current = text(r.current);
    if (current && items.includes(current)) screen.current = current;
    if (r.popup === true) screen.popup = true;
    const model = text(r.model);
    if (model) screen.model = model;
    out.push(screen);
  }
  return out;
}

// ------------------------------------------------------------ menu maps

/** One row of a menu: a plain entry, a setting with options, or a sub-menu. */
export interface MenuNode {
  /** The row as the camera labels it. */
  name: string;
  /** What the row shows on the right at the default setting. */
  value?: string;
  /** A setting's choices in screen order; an option can open a list of its own (Manual → speeds). */
  options?: (string | MenuNode)[];
  /** The short code the camera shows beside each option (ON, OFF, D+…), aligned with `options`. */
  codes?: string[];
  /** The default choice. */
  default?: string;
  /** The choices drop down beside the row. */
  popup?: boolean;
  /** A sub-menu's rows. */
  items?: MenuNode[];
  /** Not listed in the default state (another setting hides it). */
  hidden?: boolean;
  /** Greyed out in the default state. */
  dim?: boolean;
  /** One line on what it does, for the agent: settings with it are offered by name. */
  does?: string;
  /** Other names the agent may use for it. */
  aka?: string[];
  /** A condition worth telling the photographer ("Tv or M mode only."). */
  note?: string;
}

/** A page whose rows are themselves the choices (the Servo AF cases). */
export interface MenuChoice {
  name: string;
  options: string[];
  default?: string;
  does?: string;
  aka?: string[];
}

export interface MenuPageDef {
  tab: MenuTab;
  page: number;
  /** A heading the page shows under the page numbers. */
  title?: string;
  items: MenuNode[];
  choice?: MenuChoice;
}

export interface CameraMenuMap {
  /** A short name for the map. */
  model: string;
  /** Lower-case name fragments that identify it in a CCAPI product name. */
  match: string[];
  /** Pages per tab. */
  pages: Record<MenuTab, number>;
  menu: MenuPageDef[];
}

/** Every model with a map. The first is used for cameras not listed. */
export const MENU_MAPS: CameraMenuMap[] = [MIRRORLESS];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();

/** The menu map for a camera ("Canon EOS R6 Mark II, lens RF24-105mm…"); `exact` is false when it fell back to the default model. */
export function menuMapFor(camera: string): { map: CameraMenuMap; exact: boolean } {
  const c = ` ${norm(camera)} `;
  for (const map of MENU_MAPS) if (map.match.some((m) => c.includes(` ${norm(m)} `))) return { map, exact: true };
  return { map: MENU_MAPS[0], exact: false };
}

/** A row with choices. */
type Setting = (MenuNode & { options: (string | MenuNode)[] }) | MenuChoice;

/** A setting found in a map: the page it starts on, the rows down to it, and its choices. */
interface Found {
  page: MenuPageDef;
  /** Rows from the page down to the setting (empty for a page choice). */
  chain: MenuNode[];
  setting: Setting;
}

const label = (o: string | MenuNode) => (typeof o === "string" ? o : o.name);

function walk(map: CameraMenuMap): Found[] {
  const out: Found[] = [];
  const visit = (page: MenuPageDef, node: MenuNode, chain: MenuNode[]) => {
    if (node.options) out.push({ page, chain, setting: { ...node, options: node.options } });
    for (const child of node.items ?? []) visit(page, child, [...chain, child]);
  };
  for (const page of map.menu) {
    if (page.choice) out.push({ page, chain: [], setting: page.choice });
    for (const item of page.items) visit(page, item, [item]);
  }
  return out;
}

/** The settings a map offers the agent, in menu order. */
export function knownSettings(map: CameraMenuMap) {
  return walk(map)
    .filter((f) => f.setting.does)
    .map((f) => ({
      name: f.setting.name,
      tab: f.page.tab,
      page: f.page.page,
      does: f.setting.does!,
      options: f.setting.options.map(label),
      nested: (f.setting.options as (string | MenuNode)[]).filter((o): o is MenuNode => typeof o !== "string"),
      default: f.setting.default,
      note: "note" in f.setting ? f.setting.note : undefined,
    }));
}

function findSetting(map: CameraMenuMap, name: string): Found | null {
  const q = norm(name);
  if (!q) return null;
  const all = walk(map);
  const names = (f: Found) => [f.setting.name, ...(f.setting.aka ?? [])].map(norm);
  // Exact name first (offered settings before the rest), then a name that contains the other.
  const exact = all.filter((f) => names(f).includes(q));
  if (exact.length) return exact.find((f) => f.setting.does) ?? exact[0];
  if (q.length < 4) return null;
  return all.find((f) => f.setting.does && names(f).some((n) => n.includes(q) || q.includes(n))) ?? null;
}

const ON = ["on", "enable", "enabled", "yes", "true"];
const OFF = ["off", "disable", "disabled", "no", "false", "none"];

/** The labels to pick for `value`, e.g. ["Enable"] or ["Manual", "1/250"]; null when it isn't one of the choices. */
function resolveValue(setting: Setting, value: string): string[] | null {
  const v = norm(value);
  if (!v) return null;
  const opts = setting.options.map((o) => (typeof o === "string" ? { label: o, node: undefined } : { label: o.name, node: o }));
  const codes = "codes" in setting ? (setting.codes ?? []) : [];
  // Numbers, with thirds as the camera writes them: "+1", "-0.7", "-2/3", "+1 1/3", "+1⅓ EV".
  const num = (s: string) => {
    const m = s.replace(/[\s_]|ev$/gi, "").replace(/[−–]/g, "-").match(/^([+-]?)(\d+(?:\.\d+)?)?(⅓|⅔|1\/3|2\/3)?$/);
    if (!m || (!m[2] && !m[3])) return NaN;
    const n = Number(m[2] ?? 0) + (m[3] ? (m[3] === "⅓" || m[3] === "1/3" ? 1 / 3 : 2 / 3) : 0);
    return m[1] === "-" ? -n : n;
  };
  const same = (label: string, i: number) => {
    // Numbers by value: written as text, "-1⅔" and "-1" would both read "1".
    if (!Number.isNaN(num(value)) && !Number.isNaN(num(label))) return Math.abs(num(value) - num(label)) < 0.01;
    const l = norm(label);
    if (l === v || (codes[i] && norm(codes[i]) === v)) return true;
    return (ON.includes(v) && ON.includes(l)) || (OFF.includes(v) && OFF.includes(l));
  };
  for (const [i, o] of opts.entries()) if (same(o.label, i)) return [o.label];
  // "On" for a setting without an On option (Eye detection: Auto): its default, or the first option that isn't off.
  if (ON.includes(v)) {
    const on = opts.find((o) => o.label === setting.default && !OFF.includes(norm(o.label))) ?? opts.find((o) => !OFF.includes(norm(o.label)));
    if (on) return [on.label];
  }
  for (const o of opts) {
    for (const sub of o.node?.options ?? []) {
      const label = typeof sub === "string" ? sub : sub.name;
      if (norm(label) === v) return [o.label, label];
    }
  }
  if (v.length < 3) return null;
  for (const o of opts) if (norm(o.label).includes(v) || v.includes(norm(o.label))) return [o.label];
  for (const o of opts) {
    for (const sub of o.node?.options ?? []) {
      const label = typeof sub === "string" ? sub : sub.name;
      if (v.includes(norm(label))) return [o.label, label];
    }
  }
  return null;
}

/** At most MENU_LIMITS.items rows, scrolled so the selection shows (the camera scrolls long lists too). */
function windowed<T>(rows: T[], selected: number): { rows: T[]; start: number } {
  if (rows.length <= MENU_LIMITS.items) return { rows, start: 0 };
  const start = Math.max(0, Math.min(rows.length - MENU_LIMITS.items, selected - 3));
  return { rows: rows.slice(start, start + MENU_LIMITS.items), start };
}

/** A list of rows as a screen: names, right-hand values, greyed-out rows. */
function rowsScreen(tab: MenuTab, nodes: MenuNode[], select: string): Pick<MenuScreen, "tab" | "items" | "values" | "dim" | "select"> {
  const shown = nodes.filter((n) => !n.hidden || n.name === select);
  const { rows } = windowed(shown, shown.findIndex((n) => n.name === select));
  const screen: Pick<MenuScreen, "tab" | "items" | "values" | "dim" | "select"> = { tab, items: rows.map((n) => n.name), select };
  if (rows.some((n) => n.value)) screen.values = rows.map((n) => n.value ?? "");
  const dim = rows.filter((n) => n.dim && n.name !== select).map((n) => n.name);
  if (dim.length) screen.dim = dim;
  return screen;
}

/** An option list as a screen. */
function optionsScreen(tab: MenuTab, title: string, options: (string | MenuNode)[], codes: string[] | undefined, current: string | undefined, select: string, popup: boolean): MenuScreen {
  const labels = options.map(label);
  const { rows, start } = windowed(labels, Math.max(0, labels.indexOf(select)));
  const screen: MenuScreen = { tab, title, items: rows, select };
  if (codes?.length) screen.values = rows.map((_, i) => codes[start + i] ?? "");
  if (current && rows.includes(current)) screen.current = current;
  if (popup) screen.popup = true;
  return screen;
}

export interface MenuPath {
  /** The model whose menus these are. */
  model: string;
  /** False when the camera isn't in a map and the default model's menus stand in. */
  exact: boolean;
  /** The setting as the camera names it. */
  setting: string;
  /** The option chosen, when the value matched one. */
  value?: string;
  screens: MenuScreen[];
  /** The same path in words, one step per press. */
  steps: string[];
}

/**
 * The way to a setting on a camera, from its menu map: the tab page with all
 * its rows and the right one selected, each sub-menu, then the option list
 * with `value` selected. Null when the map doesn't know the setting.
 */
export function menuPath(camera: string, setting: string, value = ""): MenuPath | null {
  const { map, exact } = menuMapFor(camera);
  const found = findSetting(map, setting);
  if (!found) return null;
  const { page, chain, setting: target } = found;
  const tab = page.tab;
  const picked = resolveValue(target, value);
  const options: (string | MenuNode)[] = target.options;
  const choice = picked?.[0] ?? target.default ?? label(options[0]);
  const codes = "codes" in target ? target.codes : undefined;
  const popup = "popup" in target && target.popup === true;

  const screens: MenuScreen[] = [];
  const steps = ["Press MENU", `Open the ${TAB_STEP[tab]} tab, page ${page.page}`];
  const pageScreen = (select: string): MenuScreen => {
    const s: MenuScreen = { ...rowsScreen(tab, page.items, select), page: page.page, pages: map.pages[tab] };
    if (page.title) s.title = page.title;
    return s;
  };
  if (chain.length === 0) {
    // The page's rows are the choices.
    const s = pageScreen(choice);
    if (target.default && s.items.includes(target.default)) s.current = target.default;
    screens.push(s);
  } else {
    screens.push(pageScreen(chain[0].name));
    steps.push(`Select ${chain[0].name}`);
    for (let i = 1; i < chain.length; i++) {
      screens.push({ ...rowsScreen(tab, chain[i - 1].items ?? [], chain[i].name), title: chain[i - 1].name });
      steps.push(`Select ${chain[i].name}`);
    }
    screens.push(optionsScreen(tab, target.name, options, codes, target.default, choice, popup));
  }
  if (picked) {
    const last = picked[picked.length - 1];
    if (picked.length > 1) {
      const opener = options.find((o): o is MenuNode => typeof o !== "string" && o.name === picked[0]);
      if (opener?.options) screens.push(optionsScreen(tab, target.name, opener.options, undefined, opener.default, last, false));
      steps.push(`Choose ${picked[0]}`);
    }
    steps.push(`Choose ${last} and press SET`);
  } else {
    steps.push(`Choose the option you need (${options.map(label).join(", ")}) and press SET`);
  }
  if ("note" in target && target.note) steps.push(target.note);
  screens[0].model = map.model;
  return {
    model: map.model,
    exact,
    setting: target.name,
    value: picked ? picked[picked.length - 1] : undefined,
    screens: screens.slice(0, MENU_LIMITS.screens),
    steps: steps.slice(0, 8).map((s) => s.slice(0, 80)),
  };
}

/** The settings the agent may walk the photographer to on this camera, for its instructions. */
export function menuSettingsText(camera: string): string {
  const { map, exact } = menuMapFor(camera);
  const tabShort: Record<MenuTab, string> = { shoot: "SHOOT", af: "AF", play: "PLAY", wireless: "NETWORK", setup: "SET-UP", custom: "C.Fn", mymenu: "MY MENU" };
  const lines = knownSettings(map).map((s) => {
    const opts = s.options
      .map((o) => {
        const nested = s.nested.find((n) => n.name === o);
        const sub = nested?.options?.map(label) ?? [];
        return sub.length ? `${o} (then a value from ${sub[0]} to ${sub[sub.length - 1]})` : o;
      })
      .join(" | ");
    return `- ${s.name} [${tabShort[s.tab]}${s.page}]: ${s.does} Values: ${opts}${s.default ? ` (default ${s.default})` : ""}.`;
  });
  const head = exact
    ? "Menu paths on this camera:"
    : "This camera's menus aren't mapped; these paths are typical of recent mirrorless bodies:";
  return [head, ...lines].join("\n");
}

/**
 * Rewrites a menu_steps call's arguments: the screens and steps come from the
 * menu map, never from the model. A setting the map doesn't know keeps the
 * model's own steps, without screens, marked unverified.
 */
export function rewriteMenuSteps(argsJson: string, camera: string): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return argsJson;
    args = parsed as Record<string, unknown>;
  } catch {
    return argsJson;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const path = menuPath(camera, str(args.setting), str(args.value));
  if (!path) {
    const rest: Record<string, unknown> = { ...args, verified: false };
    delete rest.screens;
    return JSON.stringify(rest);
  }
  return JSON.stringify({
    setting: path.setting,
    value: path.value ?? str(args.value),
    why: str(args.why),
    steps: path.steps,
    screens: path.screens,
    verified: true,
    menu_model: path.model,
  });
}
