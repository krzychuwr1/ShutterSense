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
import { menuScreen, screenHint } from "./camera-menu.ts";
import { el, esc, h } from "./dom.ts";

const ROOM_KEY = "shuttersense:glasses";
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
  if (sim) document.title = "Shutter Sense glasses (simulated)";
  // Simulated glasses run in a pop-up or embedded in the demo page; either way the page that opened them drives pairing.
  const embedded = window.parent !== window;
  const host: Window | null = sim ? ((window.opener as Window | null) ?? (embedded ? window.parent : null)) : null;

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
  /** Which menu screen of the current guide the lens shows; it steps on by itself. */
  let guideIdx = 0;
  let guideKey = "";

  // ---------------------------------------------------------------- pairing

  const renderHome = (wrong = false) => {
    const slots = Array.from({ length: PATTERN_LENGTH }, (_, i) => `<span class="${i < moves.length ? "on" : ""}">${i < moves.length ? ARROW[moves[i]] : ""}</span>`).join("");
    lens.replaceChildren(
      h(`<div class="pair">
        <div class="pair-title">Shutter Sense</div>
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

  // One input for the life of the HUD: rebuilding it on every update would drop its focus mid-dictation.
  const input = el("input", { class: "hud-input", "data-focus": "", type: "text", enterkeyhint: "send" });
  input.addEventListener("change", () => {
    say(input.value);
    input.value = "";
    input.blur();
  });

  function setFocus(i: number) {
    const list = focusables();
    if (!list.length) return;
    focusIdx = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((n, j) => n.classList.toggle("focus", j === focusIdx));
    // The field takes real focus as soon as the D-pad lands on it, so a single
    // pinch opens the glasses' dictation (a pinch on an unfocused field only focuses it).
    if (list[focusIdx] === input) {
      if (document.activeElement !== input) input.focus({ preventScroll: true });
    } else if (document.activeElement === input) input.blur();
  }

  function render() {
    if (home) return renderHome();
    const working = hud.phase === "working" || hud.phase === "asking";
    const header = el("div", { class: "hud-head" }, [
      el("span", { class: `hud-dot${online && phones ? " ok" : ""}` }),
      el("span", { class: "hud-title" }, ["Shutter Sense"]),
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
      if (hud.guide) {
        const menu = hud.guide.menu ?? [];
        const key = hud.guide.setting + menu.length;
        if (key !== guideKey) {
          guideKey = key;
          guideIdx = 0;
        }
        const i = menu.length ? guideIdx % menu.length : 0;
        parts.push(
          el("div", { class: "hud-guide" }, [
            el("div", { class: "hud-guide-title" }, [`On the camera: ${hud.guide.setting}`]),
            menu.length
              ? el("div", { class: "hud-guide-menu" }, [menuScreen(menu[i]), el("div", { class: "hud-guide-hint" }, [`${i + 1}/${menu.length} · ${screenHint(menu[i], i)}`])])
              : el("ol", {}, hud.guide.steps.slice(0, 6).map((st) => el("li", {}, [st]))),
          ]),
        );
      }
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

    input.placeholder = hud.question ? "Answer (pinch to dictate)" : "Tell the agent… (pinch to dictate)";
    parts.push(el("div", { class: "hud-foot" }, [input]), el("div", { class: "hud-flash" }));
    lens.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    const list = focusables();
    setFocus(focusIdx < 0 || focusIdx >= list.length ? list.length - 1 : focusIdx);
  }

  function hudKey(key: string): boolean {
    const list = focusables();
    const cur = list[focusIdx];
    const typing = document.activeElement?.tagName === "INPUT";
    // With text in the field, arrows move the caret; an empty field lets the D-pad move on.
    if (typing && key !== "Enter" && input.value) return false;
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
    if (cur === input) {
      if (typing && input.value.trim()) {
        say(input.value);
        input.value = "";
        input.blur();
        return true;
      }
      // Real glasses open the system composer (dictation) when a focused field is
      // activated: focus it and let the pinch through instead of swallowing it.
      input.focus({ preventScroll: true });
      input.click();
      return false;
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
            if (m.hud.message && m.hud.message !== was.message) void speak(m.hud.message);
            if (m.hud.phase === "done" && was.phase !== "done") void speak(m.hud.summary ? `Done. ${m.hud.summary}` : "Done.");
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

  // The lens speaks the agent's notes: a natural voice from the worker (Wit.ai)
  // when one is set up, else the best voice the device has. Embedded in the
  // demo page it stays quiet until the page turns sound on.
  let voiceOn = !embedded;
  let serverVoice = true;
  let playing: HTMLAudioElement | null = null;
  const browserSpeak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voices.find((v) => /natural|neural|online/i.test(v.name)) ?? voices.find((v) => /google/i.test(v.name)) ?? null;
    u.rate = 1.02;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };
  const speak = async (text: string) => {
    if (!voiceOn || !text) return;
    if (serverVoice) {
      try {
        const res = await fetch("/api/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
        if (res.ok) {
          playing?.pause();
          playing = new Audio(URL.createObjectURL(await res.blob()));
          await playing.play();
          return;
        }
        // No voice configured on the server: stop asking.
        if (res.status === 503) serverVoice = false;
      } catch {
        // offline: the device voice still works
      }
    }
    browserSpeak(text);
  };

  // Back: from the HUD to the pairing screen, then out.
  const back = () => {
    if (!home) {
      home = true;
      render();
    }
  };
  window.addEventListener("popstate", back);

  const press = (key: string, repeat = false) => (home ? repeat || homeKey(key) : hudKey(key));
  document.addEventListener("keydown", (e) => {
    if (press(e.key, e.repeat)) e.preventDefault();
  });

  // An embedded lens must not add entries to the demo page's history.
  if (room) {
    if (!embedded) history.pushState({ hud: 1 }, "");
    connect();
  }
  render();

  // Step the lens through a guide's menu screens.
  setInterval(() => {
    if (home || !hud.guide || (hud.guide.menu?.length ?? 0) < 2) return;
    guideIdx++;
    render();
  }, 2600);

  if (sim) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || home) return;
      if (embedded) back();
      else history.back();
    });
    window.addEventListener("message", async (e) => {
      const data = e.data as { type?: string; moves?: string; key?: string };
      if (e.origin !== location.origin || !host || e.source !== host) return;
      // The demo page's on-screen D-pad.
      if (data?.type === "sim-sound") {
        voiceOn = (data as { on?: unknown }).on === true;
        if (!voiceOn) {
          playing?.pause();
          if ("speechSynthesis" in window) speechSynthesis.cancel();
        }
        return;
      }
      if (data?.type === "sim-key" && typeof data.key === "string") {
        if (data.key === "Escape") back();
        else press(data.key);
        return;
      }
      if (data?.type !== "sim-pair" || !home || checking || !/^[UDLR]+$/.test(data.moves ?? "")) return;
      moves = "";
      for (const m of data.moves!) {
        await new Promise((r) => setTimeout(r, 200));
        homeKey(KEY_FOR[m]);
      }
    });
    if (home) host?.postMessage({ type: "sim-ready" }, location.origin);
  }
}
