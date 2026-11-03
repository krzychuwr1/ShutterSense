// Draws camera menu screens (see shared/menu.ts) the way the camera itself
// shows them: the row of tab icons with the current tab lit in its colour,
// the tab's page numbers, every row of the page with its value on the right,
// and the cursor on the row to pick; sub-screens show the setting's title and
// its options, the current one in blue. Used by the phone app's guide card,
// the glasses lens and the web demo. The icons are our own simple drawings.

import "./styles/camera-menu.css";
import { MENU_TAB_NAMES, MENU_TABS, type MenuScreen, type MenuTab } from "../../shared/menu.ts";
import { el } from "./dom.ts";

const ICON: Record<MenuTab, string> = {
  shoot: '<path d="M3.5 8.5h3.6l1.8-2.6h6.2l1.8 2.6h3.6v10h-17z" fill="currentColor" stroke="none"/><circle cx="12" cy="13.2" r="3.1" fill="#000" stroke="none"/><circle cx="12" cy="13.2" r="1.9" fill="currentColor" stroke="none"/>',
  af: '<text x="12" y="16.8" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">AF</text>',
  play: '<rect x="4" y="5.5" width="16" height="13" rx="0.8"/><path d="M10 9v6l5-3z" fill="currentColor"/>',
  wireless: '<path d="M3 15.5 7.5 10l4 5 4.5-6.5L20.5 14"/><path d="M3 12.6v3.4h3.3M20.5 10.8v3.6h-3.4"/>',
  setup: '<path d="M8.8 4.5v4.2a3.2 3.2 0 0 0 2.2 3V19.5h2V11.7a3.2 3.2 0 0 0 2.2-3V4.5l-1.5 1.4v2.6h-3.4V5.9z" fill="currentColor" stroke="none"/>',
  custom: '<path d="M4.5 7.5h3.2l1.6-2.2h5.4l1.6 2.2h3.2v8.5h-15z" fill="currentColor" stroke="none"/><circle cx="12" cy="11.6" r="2.6" fill="#000" stroke="none"/><path d="M5 19h.01M8 19h.01M11 19h.01M14 19h.01M17 19h.01" stroke-width="2"/>',
  mymenu: '<path d="m12 4.2 2.3 4.8 5.3.6-3.9 3.6 1.1 5.2L12 15.8l-4.8 2.6 1.1-5.2-3.9-3.6 5.3-.6z" fill="currentColor" stroke="none"/>',
};

const svg = (inner: string) => {
  const span = el("span", { class: "cm-icon", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return span;
};

/** "Press MENU, open the AF tab, page 1, select Subject to detect" for the first screen, "Select Animals" after. */
export function screenHint(s: MenuScreen, i: number): string {
  const tab = MENU_TAB_NAMES[s.tab];
  if (i === 0) return `Press MENU, open the ${tab} tab${s.page ? `, page ${s.page}` : ""}, select ${s.select}`;
  return `Select ${s.select}`;
}

/** Short codes (ON, OFF, AUTO, D+, 1/3): the camera draws them at the row's right edge; words go in the value column. */
const isCode = (v: string) => /^[A-Z0-9+\-±./★]{1,5}$/.test(v);

/** A row's value, placed as on the camera. */
const valueCell = (v: string) => el("span", { class: `cm-val${isCode(v) ? " r" : ""}` }, [v]);

/** One row of a list. */
function row(s: MenuScreen, item: string, i: number): HTMLElement {
  const cls = [item === s.select ? "on" : "", item === s.current ? "cur" : "", s.dim?.includes(item) ? "dim" : ""].filter(Boolean).join(" ");
  const v = s.values?.[i] ?? "";
  return el("li", { class: cls }, [el("span", { class: "cm-label" }, [item]), ...(v ? [valueCell(v)] : [])]);
}

/** A tab page: tab icons, the page numbers, all rows of the page. */
function pageView(s: MenuScreen): HTMLElement[] {
  const tabs = el(
    "div",
    { class: "cm-tabs" },
    MENU_TABS.map((t) => el("span", { class: `cm-tab${t === s.tab ? " on" : ""}` }, [svg(ICON[t])])),
  );
  const count = Math.max(s.pages ?? s.page ?? 1, s.page ?? 1);
  const pages = el(
    "div",
    { class: "cm-pages" },
    Array.from({ length: count }, (_, i) => el("span", { class: i + 1 === s.page ? "on" : "" }, [String(i + 1)])),
  );
  const slots = Math.max(7, s.items.length);
  const rows = el("ol", { class: "cm-rows", style: `--cm-slots: ${slots}` }, [
    ...s.items.map((item, i) => row(s, item, i)),
    ...Array.from({ length: slots - s.items.length }, () => el("li", { class: "empty" })),
  ]);
  return [tabs, pages, ...(s.title ? [el("div", { class: "cm-heading" }, [s.title])] : []), rows];
}

/** A sub-screen: the setting's title, its rows or options, and the button hint. */
function subView(s: MenuScreen): HTMLElement[] {
  const head = el("div", { class: "cm-head" }, [s.title ?? ""]);
  const foot = el("div", { class: "cm-foot" }, [s.current ? el("span", { class: "cm-key" }, [el("b", {}, ["SET"]), "OK"]) : el("span", { class: "cm-key" }, [el("b", {}, ["MENU"]), "↩"])]);
  if (s.popup) {
    // The options drop down beside the row, the cursor's option level with it.
    const box = el("ol", { class: "cm-popup" }, s.items.map((item, i) => row(s, item, i)));
    const at = Math.max(0, s.items.indexOf(s.select));
    const body = el("div", { class: "cm-popbody", style: `--cm-at: ${at}` }, [el("div", { class: "cm-poprow" }, [s.title ?? ""]), box]);
    return [head, body, foot];
  }
  const slots = Math.max(6, s.items.length);
  const rows = el("ol", { class: "cm-rows sub", style: `--cm-slots: ${slots}` }, s.items.map((item, i) => row(s, item, i)));
  return [head, rows, foot];
}

/** One menu screen. */
export function menuScreen(s: MenuScreen): HTMLElement {
  const sub = s.page === undefined && !!s.title;
  const panel = el("div", { class: `cm-panel${sub ? " sub" : ""}` }, sub ? subView(s) : pageView(s));
  const where = sub ? s.title : `${MENU_TAB_NAMES[s.tab]} ${s.page ?? ""}`.trim();
  return el("div", { class: "cm-screen", "data-tab": s.tab, role: "img", "aria-label": `${where} menu, ${s.select} selected` }, [panel]);
}

/** The screens one after another, with step controls; it advances by itself until the viewer takes over. */
export function menuGuide(screens: MenuScreen[]): HTMLElement {
  let i = 0;
  let auto = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stage = el("div", { class: "cm-stage" });
  const hint = el("div", { class: "cm-hint" });
  const dots = el("div", { class: "cm-dots" });
  const prev = el("button", { class: "cm-nav", type: "button", "aria-label": "Previous step" }, ["‹"]);
  const next = el("button", { class: "cm-nav", type: "button", "aria-label": "Next step" }, ["›"]);
  const show = () => {
    stage.replaceChildren(menuScreen(screens[i]));
    hint.replaceChildren(el("b", {}, [`${i + 1}/${screens.length}`]), " ", screenHint(screens[i], i));
    dots.replaceChildren(...screens.map((_, j) => el("span", { class: j === i ? "on" : "" })));
    prev.disabled = i === 0;
    next.disabled = i === screens.length - 1;
  };
  const go = (d: number) => {
    auto = false;
    i = Math.max(0, Math.min(screens.length - 1, i + d));
    show();
  };
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  const note = "Menus differ a little between camera models.";
  const root = el("div", { class: "cm-guide" }, [stage, el("div", { class: "cm-controls" }, [prev, dots, next]), hint, el("div", { class: "cm-note" }, [note])]);
  show();
  if (auto && screens.length > 1) {
    const timer = setInterval(() => {
      if (!auto || !root.isConnected) return clearInterval(timer);
      i = (i + 1) % screens.length;
      show();
    }, 2600);
  }
  return root;
}
