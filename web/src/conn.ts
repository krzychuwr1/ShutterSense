// Room connection: WebSocket first, with an SSE (down) + fetch POST (up)
// fallback for webviews where WebSockets are unavailable. Same messages either
// way.

import type { ClientMessage, Role, ServerMessage } from "../../shared/protocol.ts";

export type ConnState = "connecting" | "online" | "offline";

const WS_OPEN_TIMEOUT = 6000;
const PING_EVERY = 20_000;
/** No message at all (not even a pong) for this long means the link is dead. */
const SILENCE_LIMIT = 45_000;

export class RoomConn {
  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  private mode: "ws" | "sse";
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsEverOpened = false;
  private outbox: ClientMessage[] = [];
  private query: string;
  state: ConnState = "connecting";

  constructor(
    private code: string,
    role: Role,
    private onMessage: (m: ServerMessage) => void,
    private onState: (s: ConnState) => void = () => {},
    token: string,
  ) {
    this.query = `role=${role}&token=${encodeURIComponent(token)}`;
    const forced = new URLSearchParams(location.search).get("transport");
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem("shuttersense:transport");
    } catch {
      // storage unavailable
    }
    this.mode = forced === "sse" || forced === "ws" ? forced : remembered === "sse" ? "sse" : "ws";
  }

  start() {
    this.connect();
    window.addEventListener("online", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.reconnectNow();
    });
  }

  send(msg: ClientMessage) {
    if (this.mode === "ws") {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
      else this.outbox.push(msg);
      return;
    }
    fetch(`/api/rooms/${this.code}/send?${this.query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    }).then(
      (res) => res.status >= 500 && this.outbox.push(msg),
      () => this.outbox.push(msg),
    );
  }

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }

  private connect() {
    if (this.mode === "ws") this.openWs();
    else this.openSse();
  }

  /** Detach and close whatever is open, so there is never more than one live link. */
  private teardown() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    this.es?.close();
    this.es = null;
  }

  private openWs() {
    this.teardown();
    this.setState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/rooms/${this.code}/ws?${this.query}`);
    } catch {
      return this.fallBackToSse();
    }
    this.ws = ws;
    let opened = false;
    let lastSeen = Date.now();
    let ping: ReturnType<typeof setInterval> | null = null;
    const openTimeout = setTimeout(() => {
      if (opened || this.ws !== ws) return;
      // A slow first connection on a webview that may not support WebSockets.
      if (this.wsEverOpened) ws.close();
      else this.fallBackToSse();
    }, WS_OPEN_TIMEOUT);

    ws.onopen = () => {
      opened = true;
      this.wsEverOpened = true;
      this.retry = 0;
      clearTimeout(openTimeout);
      this.setState("online");
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
      ping = setInterval(() => {
        if (Date.now() - lastSeen > SILENCE_LIMIT) return ws.close(); // half-open link
        ws.send("ping");
      }, PING_EVERY);
    };
    ws.onmessage = (e) => {
      lastSeen = Date.now();
      if (e.data === "pong") return;
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      clearTimeout(openTimeout);
      if (ping) clearInterval(ping);
      if (this.ws !== ws) return;
      this.ws = null;
      // Failed twice without ever connecting: this webview probably can't do
      // WebSockets. After a successful connection, failures are just outages.
      if (!opened && !this.wsEverOpened && this.retry >= 1) return this.fallBackToSse();
      this.scheduleReconnect();
    };
  }

  private fallBackToSse() {
    this.mode = "sse";
    try {
      sessionStorage.setItem("shuttersense:transport", "sse");
    } catch {
      // storage unavailable
    }
    this.openSse();
  }

  private openSse() {
    this.teardown();
    this.setState("connecting");
    const es = new EventSource(`/api/rooms/${this.code}/events?${this.query}`);
    this.es = es;
    es.onopen = () => {
      this.retry = 0;
      this.setState("online");
      for (const m of this.outbox.splice(0)) this.send(m);
    };
    es.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (this.es !== es) return;
      this.es = null;
      es.close();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    this.setState(navigator.onLine ? "connecting" : "offline");
    if (this.reconnectTimer) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Reconnect immediately, but only if nothing is open or opening. */
  private reconnectNow() {
    if (this.ws || this.es) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retry = 0;
    this.connect();
  }
}

export interface NewRoom { code: string; token: string }

/** Creates a session; its token lets this phone (and only it) act as the phone. */
export async function createRoom(): Promise<NewRoom> {
  const res = await fetch("/api/rooms", { method: "POST" });
  if (!res.ok) throw new Error(res.status === 429 ? "Too many sessions. Wait a few minutes and try again." : "Could not create a session");
  return (await res.json()) as NewRoom;
}

/** Glasses: trade a swiped pattern for its session. Null if no phone shows it; throws on rate limit or outage. */
export async function claimPattern(pattern: string): Promise<NewRoom | null> {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pattern }),
  });
  if (res.ok) return (await res.json()) as NewRoom;
  if (res.status === 404) return null;
  throw new Error(res.status === 429 ? "Too many tries. Wait a few minutes and try again." : "Can't reach the server. Try again.");
}

/** True/false for found/not found; throws when the server can't answer (rate limit, outage). */
export async function roomExists(code: string): Promise<boolean> {
  const res = await fetch(`/api/rooms/${code}`);
  if (res.ok || res.status === 404 || res.status === 400) return res.ok;
  throw new Error(res.status === 429 ? "Too many requests. Wait a few minutes and try again." : "Can't reach the server.");
}
