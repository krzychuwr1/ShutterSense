// Glasses app (/g) for Ray-Ban Display: a 600 x 600 HUD of what the agent is
// doing (current step, latest settings change, last shot, the summary), and
// "Tell the agent": Enter opens the system composer, and what the wearer
// dictates goes to the phone's agent as a correction or an answer.
//
// Pairing: the phone shows eight arrows, the wearer swipes them. `/g?sim=<code>`
// is the same app in a 600 x 600 window the phone page opens; it swipes the
// pattern the page hands it.

import { EMPTY_HUD, PATTERN_LENGTH, type HudState, type ServerMessage } from "../../shared/protocol.ts";
import { claimPattern, RoomConn, roomExists, type NewRoom } from "./conn.ts";
import { el, esc, h } from "./dom.ts";

const ROOM_KEY = "secondshooter:glasses";
const KEY_FOR: Record<string, string> = { U: "ArrowUp", D: "ArrowDown", L: "ArrowLeft", R: "ArrowRight" };
const MOVE: Record<string, string> = { ArrowUp: "U", ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R" };
const ARROW: Record<string, string> = { U: "↑", D: "↓", L: "←", R: "→" };

const store = (sim: boolean) => (sim ? sessionStorage : localStorage);

function savedSession(sim: boolean): NewRoom | null {
  try {
    const raw = store(sim).getItem(ROOM_KEY);
    return raw ? (JSON.parse(raw) as NewRoom) : null;
  } catch {
    return null;
  }
}

export async function startGlasses(root: HTMLElement) {
  document.body.className = "glasses-body";
  const fit = () => document.body.style.setProperty("--fit", String(Math.min(innerWidth, innerHeight) / 600 || 1));
  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("scroll", () => window.scrollTo(0, 0));
  const sim = new URLSearchParams(location.search).get("sim")?.toUpperCase() ?? null;
  if (sim) document.title = "Second Shooter glasses (simulated)";

  const lens = el("div", { class: "lens" });
  root.replaceChildren(lens);

  let room = savedSession(!!sim);
  if (room && sim && room.code !== sim) room = null;
  if (room && !(await roomExists(room.code).catch(() => true))) room = null;

  let home = !room;
  let moves = "";
  let checking = false;
  let note = "";
  let hud: HudState = { ...EMPTY_HUD };
  let phones = 0;
  let conn: RoomConn | null = null;
  let online = false;
  let focusIdx = -1;

  // ---------------------------------------------------------------- pairing

  const renderHome = (wrong = false) => {
    const slots = Array.from({ length: PATTERN_LENGTH }, (_, i) => `<span class="${i < moves.length ? "on" : ""}">${i < moves.length ? ARROW[moves[i]] : ""}</span>`).join("");
    lens.replaceChildren(
      h(`<div class="pair">
        <div class="pair-title">Second Shooter</div>
        <div class="pair-label">Pair with your phone</div>
        <div class="pattern${wrong ? " wrong" : ""}">${slots}</div>
        <div class="pair-help">In the phone app, tap <b>Connect glasses</b><br>and swipe the arrows it shows.</div>
        <div class="pair-status${wrong ? " bad" : ""}">${esc(note || (moves ? "Pinch to start over" : room ? "Pinch to go back" : ""))}</div>
      </div>`),
    );
  };

  async function claim() {
    checking = true;
    note = "Checking…";
    renderHome();
    let wrong = false;
    try {
      const got = await claimPattern(moves);
      if (got) {
        try {
          store(!!sim).setItem(ROOM_KEY, JSON.stringify(got));
        } catch {
          // paired for this launch only
        }
        room = got;
        home = false;
        moves = "";
        checking = false;
        connect();
        render();
        return;
      }
      wrong = true;
      note = "That pattern didn't match. Check your phone and try again.";
    } catch (e) {
      note = (e as Error).message;
    }
    checking = false;
    moves = "";
    renderHome(wrong);
  }

  function homeKey(key: string): boolean {
    const move = MOVE[key];
    if (move) {
      if (checking) return true;
      moves += move;
      note = "";
      renderHome();
      if (moves.length === PATTERN_LENGTH) void claim();
      return true;
    }
    if (key !== "Enter" || checking) return false;
    if (moves) {
      moves = "";
      note = "";
      renderHome();
    } else if (room) {
      home = false;
      render();
    }
    return true;
  }

  // ---------------------------------------------------------------- HUD

  const say = (text: string) => {
    const t = text.trim();
    if (!t || !conn) return;
    conn.send({ t: "say", text: t });
    flash(`Sent: “${t}”`);
  };

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = (text: string) => {
    const f = lens.querySelector(".hud-flash");
    if (!f) return;
    f.textContent = text;
    f.classList.add("on");
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => f.classList.remove("on"), 2500);
  };

  function focusables(): HTMLElement[] {
    return Array.from(lens.querySelectorAll<HTMLElement>("[data-focus]"));
  }

  function setFocus(i: number) {
    const list = focusables();
    if (!list.length) return;
    focusIdx = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((n, j) => n.classList.toggle("focus", j === focusIdx));
  }

  function render() {
    if (home) return renderHome();
    const working = hud.phase === "working" || hud.phase === "asking";
    const header = el("div", { class: "hud-head" }, [
      el("span", { class: `hud-dot${online && phones ? " ok" : ""}` }),
      el("span", { class: "hud-title" }, ["Second Shooter"]),
      hud.shots.max ? el("span", { class: "hud-shots" }, [`${hud.shots.taken}/${hud.shots.max}`]) : null,
    ]);
    const parts: Array<HTMLElement | null> = [header];

    if (!online || !phones) {
      parts.push(el("div", { class: "hud-wait" }, [online ? "Paired. Waiting for your phone…" : "Connecting…"]));
    } else if (hud.phase === "idle" && !hud.goal) {
      parts.push(el("div", { class: "hud-wait" }, ["Ready. Set a goal on your phone,", el("br"), "or press Enter and say what you want."]));
    } else {
      if (hud.goal) parts.push(el("div", { class: "hud-goal" }, [`“${hud.goal}”`]));
      if (working && hud.step) parts.push(el("div", { class: "hud-step" }, [el("span", { class: "spin" }), hud.step]));
      if (hud.phase === "done" && hud.summary) parts.push(el("div", { class: "hud-summary" }, [el("b", {}, ["Done. "]), hud.summary]));
      if (hud.phase === "error") parts.push(el("div", { class: "hud-step bad" }, [hud.step || "Stopped"]));
      if (hud.question) {
        parts.push(
          el("div", { class: "hud-question" }, [
            el("div", {}, [hud.question.text]),
            el("div", { class: "hud-options" }, hud.question.options.map((o) => el("button", { "data-focus": "", "data-say": o, type: "button" }, [o]))),
          ]),
        );
      }
      const media = el("div", { class: "hud-media" }, [
        hud.thumb ? el("img", { src: hud.thumb, alt: "" }) : null,
        hud.diff.length || hud.message
          ? el("div", { class: "hud-diff" }, [hud.message ? el("div", { class: "hud-msg" }, [hud.message]) : null, ...hud.diff.slice(0, 4).map((d) => el("div", {}, [d]))])
          : null,
      ]);
      if (hud.phase !== "done" || !hud.summary) parts.push(media);
      else if (hud.thumb) parts.push(el("div", { class: "hud-media small" }, [el("img", { src: hud.thumb, alt: "" })]));
    }
    if (hud.exposure && online && phones) parts.push(el("div", { class: "hud-exposure" }, [hud.exposure]));

    const input = el("input", { class: "hud-input", "data-focus": "", type: "text", placeholder: hud.question ? "Answer (Enter to dictate)" : "Tell the agent… (Enter to dictate)", enterkeyhint: "send" });
    input.addEventListener("change", () => {
      say(input.value);
      input.value = "";
      input.blur();
    });
    parts.push(el("div", { class: "hud-foot" }, [input]), el("div", { class: "hud-flash" }));
    lens.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    const list = focusables();
    setFocus(focusIdx < 0 || focusIdx >= list.length ? list.length - 1 : focusIdx);
  }

  function hudKey(key: string): boolean {
    const list = focusables();
    const cur = list[focusIdx];
    const typing = document.activeElement?.tagName === "INPUT";
    if (typing && key !== "Enter") return false;
    if (key === "ArrowUp" || key === "ArrowLeft") {
      setFocus(focusIdx - 1);
      return true;
    }
    if (key === "ArrowDown" || key === "ArrowRight") {
      setFocus(focusIdx + 1);
      return true;
    }
    if (key !== "Enter" || !cur) return false;
    if (cur.dataset.say) {
      say(cur.dataset.say);
      return true;
    }
    if (cur.tagName === "INPUT") {
      const input = cur as HTMLInputElement;
      if (typing && input.value.trim()) {
        say(input.value);
        input.value = "";
        input.blur();
        return true;
      }
      // Real glasses open the system composer (dictation) on the focused field.
      input.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- connection

  function connect() {
    if (!room) return;
    conn = new RoomConn(
      room.code,
      "glasses",
      (m: ServerMessage) => {
        switch (m.t) {
          case "hello":
            hud = m.hud;
            phones = m.presence.phones;
            break;
          case "hud": {
            const was = hud;
            hud = m.hud;
            if (m.hud.message && m.hud.message !== was.message) speak(m.hud.message);
            if (m.hud.phase === "done" && was.phase !== "done") speak("Done.");
            break;
          }
          case "presence":
            phones = m.presence.phones;
            break;
          default:
            return;
        }
        if (!home) render();
      },
      (state) => {
        online = state === "online";
        if (!home) render();
      },
      room.token,
    );
    conn.start();
  }

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  };

  // Back: from the HUD to the pairing screen, then out.
  window.addEventListener("popstate", () => {
    if (!home) {
      home = true;
      render();
    }
  });

  document.addEventListener("keydown", (e) => {
    const handled = home ? e.repeat || homeKey(e.key) : hudKey(e.key);
    if (handled) e.preventDefault();
  });

  if (room) {
    history.pushState({ hud: 1 }, "");
    connect();
  }
  render();

  if (sim) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !home) history.back();
    });
    window.addEventListener("message", async (e) => {
      const data = e.data as { type?: string; moves?: string };
      if (e.origin !== location.origin || e.source !== window.opener || data?.type !== "sim-pair") return;
      if (!home || checking || !/^[UDLR]+$/.test(data.moves ?? "")) return;
      moves = "";
      for (const m of data.moves!) {
        await new Promise((r) => setTimeout(r, 200));
        homeKey(KEY_FOR[m]);
      }
    });
    if (home && window.opener) (window.opener as Window).postMessage({ type: "sim-ready" }, location.origin);
  }
}
