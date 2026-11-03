// The camera's menu functions under /functions: names written into files,
// the clock, card formatting, beeps and power saving, CORS, card and folder
// choice, file naming, Wi-Fi settings, sensor cleaning and disconnecting.
// Values are kept and validated like a real body; the ones that matter to
// the simulation act on it (formatting erases the card, the clock dates the
// files, CORS decides which browser origins may call, file naming names the
// files, disconnect and power-off take the camera offline).

import type { SimResponse } from "./camera.ts";
import type { Card } from "./card.ts";

const ok = (json: unknown = {}): SimResponse => ({ status: 200, json });
const msg = (status: number, message: string): SimResponse => ({ status, json: { message } });
const INVALID = msg(400, "Invalid parameter");
const NOT_ALLOWED = msg(405, "Method not allowed");

/** What the functions need from the camera. */
export interface FunctionsContext {
  card: Card;
  /** A 503 message when shooting or recording, else null. */
  busy(): string | null;
  /** Report a changed item in event polling. */
  changed(key: string, value: unknown): void;
  /** The camera leaves the network (Wi-Fi disconnect, power off after sensor cleaning). */
  goOffline(): void;
}

interface ListFn {
  key: string;
  values: string[];
  value: string;
}

const printable = (s: unknown, max: number, min = 0): s is string => typeof s === "string" && s.length >= min && s.length <= max && /^[\x20-\x7e]*$/.test(s);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

const WIFI_FIELDS = [
  "ssid", "method", "channel", "authentication", "encryption", "keyindex", "password",
  "ipv4_ipaddressset", "ipv4_ipaddress", "ipv4_subnetmask", "ipv4_gateway",
  "ipv6_useipv6", "ipv6_manual_setting", "ipv6_manual_address", "ipv6_prefixlength", "ipv6_gateway",
];
const emptyWifi = () => Object.fromEntries(WIFI_FIELDS.map((k) => [k, ""])) as Record<string, string>;

export class CameraFunctions {
  readonly names: Record<string, string> = { copyright: "", author: "", ownername: "", nickname: "SIMCAM" };
  private readonly nameLimits: Record<string, [number, number]> = { copyright: [0, 63], author: [0, 63], ownername: [0, 31], nickname: [1, 16] };
  /** Camera clock minus the real clock, ms; the time zone in minutes east of UTC. */
  private clockOffset = 0;
  private zone = 0;
  private dst = false;
  readonly lists: Record<string, ListFn> = {};
  readonly text: Record<string, string> = { "cors/origin": "*", "filename/stills/usersetting1": "IMG_", "filename/stills/usersetting2": "IMG", "filename/movies/index": "A_", "filename/movies/userdefined": "SIMCM" };
  readonly counters: Record<string, { value: number; min: number; max: number }> = {
    "filename/movies/reelnum": { value: 1, min: 1, max: 9999 },
    "filename/movies/clipnum": { value: 1, min: 1, max: 999 },
  };
  readonly wifi: Record<string, Record<string, string>> = {
    set1: { ...emptyWifi(), ssid: "SIMCAM-AP", method: "cameraap", channel: "auto", encryption: "aes", password: "12345678", ipv4_ipaddressset: "auto", ipv6_useipv6: "disable" },
    set2: emptyWifi(),
    set3: emptyWifi(),
  };

  constructor() {
    const add = (path: string, values: string[], value: string) => (this.lists[path] = { key: path.replace(/\//g, "_"), values, value });
    add("beep", ["enable", "disable", "disabletouch"], "enable");
    add("displayoff", ["10", "20", "30", "60", "120", "180"], "60");
    // "immediately" (sleep at once) is left out: the simulator has no way to wake up again.
    add("autopoweroff", ["30", "60", "120", "180", "300", "600", "disable"], "60");
    add("screendimmer", ["5", "10", "15", "20", "25", "30", "disable"], "10");
    add("viewfinderoff", ["1", "3", "off"], "1");
    add("cors/corssetting", ["enable", "disable"], "disable");
    add("recordfunctions/separate", ["enable", "disable"], "disable");
    // One card slot is filled, so only the single-card options apply.
    add("recordfunctions/stillimage", ["standard", "auto_switch_card"], "standard");
    add("recordfunctions/movie", ["standard", "auto_switch_card"], "standard");
    add("cardselection/stillimage", ["card1"], "card1");
    add("cardselection/movie", ["card1"], "card1");
    add("filename/stills/filename", ["preset_code", "usersetting1", "usersetting2"], "preset_code");
  }

  /** Paths this module serves, with methods, for the discovery list. */
  static endpoints(): Array<[string, string, string]> {
    const gp = "GP";
    return [
      ...["copyright", "author", "ownername", "nickname"].map((n) => ["ver100", `registeredname/${n}`, "GPD"] as [string, string, string]),
      ["ver100", "datetime", gp], ["ver100", "cardformat", "O"], ["ver100", "sensorcleaning", "O"],
      ["ver100", "beep", gp], ["ver100", "displayoff", gp], ["ver100", "autopoweroff", gp], ["ver100", "wificonnection", "O"],
      ["ver100", "cors/corssetting", gp], ["ver100", "cors/origin", "GPD"],
      ["ver100", "recordfunctions/separate", gp], ["ver100", "recordfunctions/stillimage", gp], ["ver100", "recordfunctions/movie", gp],
      ["ver100", "cardselection/stillimage", gp], ["ver100", "cardselection/movie", gp],
      ["ver100", "screendimmer", gp], ["ver100", "viewfinderoff", gp],
      ["ver100", "directory/createdirectory", "O"], ["ver100", "directory/directoryselection", gp],
      ["ver100", "filename/stills/filename", gp], ["ver100", "filename/stills/usersetting1", gp], ["ver100", "filename/stills/usersetting2", gp],
      ["ver100", "filename/movies/index", gp], ["ver100", "filename/movies/reelnum", gp], ["ver100", "filename/movies/clipnum", gp], ["ver100", "filename/movies/userdefined", gp],
      ["ver110", "wifisetting", "G"], ["ver110", "wifisetting/set1", "GPD"], ["ver110", "wifisetting/set2", "GPD"], ["ver110", "wifisetting/set3", "GPD"],
    ];
  }

  /** The camera clock, ms since the epoch. */
  now() {
    return Date.now() + this.clockOffset;
  }

  /** The 4-character prefix for still image names (the first becomes "_" in Adobe RGB). */
  stillPrefix(sizeLetter: string, adobe: boolean): string {
    const mode = this.lists["filename/stills/filename"].value;
    let p = mode === "usersetting1" ? this.text["filename/stills/usersetting1"] : mode === "usersetting2" ? this.text["filename/stills/usersetting2"] + sizeLetter : "IMG_";
    if (adobe) p = `_${p.slice(1)}`;
    return p;
  }

  corsOrigin(): string | null {
    return this.lists["cors/corssetting"].value === "enable" ? this.text["cors/origin"] : null;
  }

  /** Items for event polling (keys as the camera reports them). */
  eventItems(): Record<string, unknown> {
    const out: Record<string, unknown> = { copyright: { copyright: this.names.copyright }, author: { author: this.names.author } };
    for (const [path, l] of Object.entries(this.lists)) {
      if (/^(beep|displayoff|autopoweroff|recordfunctions\/|cardselection\/)/.test(path)) out[l.key] = { value: l.value, ability: l.values };
    }
    return out;
  }

  datetime() {
    const local = new Date(this.now() + this.zone * 60_000);
    const sign = this.zone < 0 ? "-" : "+";
    const z = Math.abs(this.zone);
    const datetime = `${DAYS[local.getUTCDay()]}, ${pad(local.getUTCDate())} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${sign}${pad(Math.floor(z / 60))}${pad(z % 60)}`;
    return { datetime, dst: this.dst };
  }

  handle(method: string, sub: string, body: Record<string, unknown>, ctx: FunctionsContext): SimResponse | null {
    const busy = method !== "GET" ? ctx.busy() : null;
    const name = sub.match(/^registeredname\/(copyright|author|ownername|nickname)$/)?.[1];
    if (name) {
      if (method === "GET") return ok({ [name]: this.names[name] });
      if (busy) return msg(503, busy);
      if (method === "PUT") {
        const [min, max] = this.nameLimits[name];
        if (!printable(body[name], max, min)) return INVALID;
        this.names[name] = body[name] as string;
      } else if (method === "DELETE") this.names[name] = name === "nickname" ? "SIMCAM" : "";
      else return NOT_ALLOWED;
      if (name === "copyright" || name === "author") ctx.changed(name, { [name]: this.names[name] });
      return ok({ [name]: this.names[name] });
    }

    if (sub === "datetime") {
      if (method === "GET") return ok(this.datetime());
      if (method !== "PUT") return NOT_ALLOWED;
      if (busy) return msg(503, busy);
      const t = parseDate(body.datetime);
      if (t === null || typeof body.dst !== "boolean") return INVALID;
      this.clockOffset = t.utc - Date.now();
      this.zone = t.zone;
      this.dst = body.dst;
      ctx.changed("datetime", this.datetime());
      return ok({ datetime: body.datetime, dst: body.dst });
    }

    if (sub === "cardformat") {
      if (method !== "POST") return NOT_ALLOWED;
      if (typeof body.name !== "string") return INVALID;
      if (busy) return msg(503, busy);
      if (body.name !== "card1") return msg(409, "Card not available");
      ctx.card.format();
      return ok();
    }

    if (sub === "sensorcleaning") {
      if (method !== "POST") return NOT_ALLOWED;
      if (typeof body.autopoweroff !== "boolean") return INVALID;
      if (busy) return msg(503, busy);
      if (body.autopoweroff) ctx.goOffline();
      return ok();
    }

    if (sub === "wificonnection") {
      if (method !== "POST") return NOT_ALLOWED;
      if (body.action !== "disconnect") return INVALID;
      ctx.goOffline();
      return { status: 202, json: {} };
    }

    if (sub === "directory/createdirectory") {
      if (method !== "POST") return NOT_ALLOWED;
      const dn = body.directoryname;
      if (typeof dn !== "string" || !(dn === "" || /^[A-Z0-9_]{5}$/.test(dn))) return INVALID;
      if (busy) return msg(503, busy);
      const dir = ctx.card.createDirectory(dn);
      if (!dir) return msg(503, "Device busy");
      ctx.changed("currentdirectory", null);
      return ok({ directoryname: dn });
    }

    if (sub === "directory/directoryselection") {
      const card = ctx.card;
      if (method === "GET") return ok({ value: card.current, ability: card.dirs });
      if (method !== "PUT") return NOT_ALLOWED;
      if (typeof body.value !== "string" || !card.dirs.includes(body.value)) return INVALID;
      if (busy) return msg(503, busy);
      card.current = body.value;
      ctx.changed("currentdirectory", null);
      return ok({ value: body.value });
    }

    const list = this.lists[sub];
    if (list) {
      if (method === "GET") return ok({ value: list.value, ability: list.values });
      if (method !== "PUT") return NOT_ALLOWED;
      if (typeof body.value !== "string" || !list.values.includes(body.value)) return INVALID;
      if (busy) return msg(503, busy);
      list.value = body.value;
      ctx.changed(list.key, { value: list.value, ability: list.values });
      return ok({ value: list.value });
    }

    const textRules: Record<string, RegExp> = {
      "cors/origin": /^[\x20-\x7e]{0,1023}$/,
      "filename/stills/usersetting1": /^[A-Z0-9][A-Z0-9_]{3}$/,
      "filename/stills/usersetting2": /^[A-Z0-9][A-Z0-9_]{2}$/,
      "filename/movies/index": /^[A-Z0-9][A-Z0-9_]$/,
      "filename/movies/userdefined": /^[A-Z0-9]{5}$/,
    };
    if (sub in this.text) {
      const field = sub.split("/").pop()!;
      if (method === "GET") return ok({ [field]: this.text[sub] });
      if (busy) return msg(503, busy);
      if (method === "PUT") {
        const v = body[field];
        if (typeof v !== "string" || !textRules[sub].test(v)) return INVALID;
        this.text[sub] = v;
      } else if (method === "DELETE" && sub === "cors/origin") this.text[sub] = "";
      else return NOT_ALLOWED;
      return ok({ [field]: this.text[sub] });
    }

    const counter = this.counters[sub];
    if (counter) {
      const ability = { min: counter.min, max: counter.max, step: 1 };
      if (method === "GET") return ok({ value: counter.value, ability });
      if (method !== "PUT") return NOT_ALLOWED;
      const v = body.value;
      if (typeof v !== "number" || !Number.isInteger(v) || v < counter.min || v > counter.max) return INVALID;
      if (busy) return msg(503, busy);
      counter.value = v;
      return ok({ value: v });
    }

    if (sub === "wifisetting") {
      if (method !== "GET") return NOT_ALLOWED;
      return ok(Object.fromEntries(Object.entries(this.wifi).map(([k, v]) => [`wifisetting_${k}`, v])));
    }
    const set = sub.match(/^wifisetting\/(set[123])$/)?.[1];
    if (set) {
      if (method === "GET") return ok(this.wifi[set]);
      if (busy) return msg(503, busy);
      if (method === "DELETE") {
        this.wifi[set] = emptyWifi();
        return ok(this.wifi[set]);
      }
      if (method !== "PUT") return NOT_ALLOWED;
      const others = Object.entries(this.wifi).filter(([k]) => k !== set).map(([, v]) => v.ssid);
      const clean = validWifi(body, others);
      if (!clean) return INVALID;
      this.wifi[set] = clean;
      return ok(clean);
    }
    return null;
  }
}

/** Strict RFC 1123 date with a numeric zone: UTC ms and zone minutes, or null. */
function parseDate(v: unknown): { utc: number; zone: number } | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const [day, month, year, hh, mm, ss, zh, zm] = [Number(m[2]), MONTHS.indexOf(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]), Number(m[9]), Number(m[10])];
  if (year < 1900 || hh > 23 || mm > 59 || ss > 59 || zh > 14 || zm % 15 || zm > 45) return null;
  const local = Date.UTC(year, month, day, hh, mm, ss);
  const d = new Date(local);
  if (d.getUTCDate() !== day || DAYS[d.getUTCDay()] !== m[1]) return null;
  const zone = (m[8] === "-" ? -1 : 1) * (zh * 60 + zm);
  return { utc: local - zone * 60_000, zone };
}

const ipv4 = (s: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((n) => Number(n) <= 255);
const ipv6 = (s: string) => /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");

/** A Wi-Fi setting if every field is acceptable, following the camera's rules. */
function validWifi(b: Record<string, unknown>, otherSsids: string[]): Record<string, string> | null {
  if (!WIFI_FIELDS.every((k) => typeof b[k] === "string")) return null;
  const s = Object.fromEntries(WIFI_FIELDS.map((k) => [k, b[k] as string])) as Record<string, string>;
  if (!printable(s.ssid, 32, 1) || otherSsids.includes(s.ssid)) return null;
  if (!["infrastructure", "cameraap"].includes(s.method) || !["auto", "manual"].includes(s.ipv4_ipaddressset)) return null;
  if (s.ipv4_ipaddressset === "manual" && ![s.ipv4_ipaddress, s.ipv4_subnetmask, s.ipv4_gateway].every(ipv4)) return null;
  if (!["enable", "disable"].includes(s.ipv6_useipv6)) return null;
  if (s.ipv6_useipv6 === "enable") {
    if (!["enable", "disable"].includes(s.ipv6_manual_setting)) return null;
    const p = Number(s.ipv6_prefixlength);
    if (s.ipv6_manual_setting === "enable" && (!ipv6(s.ipv6_manual_address) || !ipv6(s.ipv6_gateway) || !Number.isInteger(p) || p < 0 || p > 128)) return null;
  }
  const pass8to63 = (p: string) => printable(p, 63, 8) || /^[0-9a-fA-F]{64}$/.test(p);
  if (s.method === "cameraap") {
    if (!["auto", ...Array.from({ length: 11 }, (_, i) => String(i + 1))].includes(s.channel)) return null;
    if (!["none", "aes"].includes(s.encryption)) return null;
    if (s.encryption === "aes" && !printable(s.password, 8, 8)) return null;
  } else {
    const auths = ["open", "sharedkey", "wpawpa2psk", "wpa2wpa3personal", "wpawpa2wpa3personal", "wpawpa2wpa3enterprize"];
    if (!auths.includes(s.authentication)) return null;
    if (s.authentication === "open" && !["none", "wep"].includes(s.encryption)) return null;
    if (s.encryption === "wep" || s.authentication === "sharedkey") {
      if (!["1", "2", "3", "4"].includes(s.keyindex) || !(printable(s.password, 13, 13) || /^[0-9a-fA-F]{64}$/.test(s.password))) return null;
    }
    if (["wpawpa2psk", "wpa2wpa3personal", "wpawpa2wpa3personal"].includes(s.authentication) && !pass8to63(s.password)) return null;
  }
  return s;
}
