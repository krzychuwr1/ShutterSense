// The memory card: folders and files with their metadata, as the contents
// API (ver120 layout: /contents/<storage>/<folder>/<file>) browses, reads and
// modifies them. Files hold real bytes: JPEGs, the simulator's RAW container
// (named .CR3) and Motion-JPEG movies (.MOV); see formats.ts.

import type { SimResponse } from "./camera.ts";

export const CONTENTS = "/ccapi/ver120/contents";
export const STORAGE = "card1";
const PAGE = 100;

export type FileKind = "jpeg" | "cr3" | "mov";

export interface CardFile {
  dir: string;
  name: string;
  kind: FileKind;
  main: Uint8Array;
  thumb: Uint8Array;
  /** Screen-size JPEG; absent where the camera can't give one (small JPEGs, movies). */
  display?: Uint8Array;
  /** The JPEG inside a RAW file. */
  embedded?: Uint8Array;
  protect: "enable" | "disable";
  archive: "enable" | "disable";
  rotate: "0" | "90" | "180" | "270";
  rating: "off" | "1" | "2" | "3" | "4" | "5";
  /** RFC 1123, GMT. */
  modified: string;
  /** Seconds, movies only. */
  playtime: number | null;
  gps?: unknown;
  /** Files from one exposure share this (IMG_0001.JPG and IMG_0001.CR3). */
  capture: number;
}

export type ContentEvent = { type: "added" | "deleted" | "updated" | "cardformat"; path: string };

const TYPES: Record<string, FileKind | null> = { all: null, jpeg: "jpeg", cr3: "cr3", mov: "mov", cr2: null, wav: null, mp4: null, hif: null, crm: null };
const CONTENT_TYPE: Record<FileKind, string> = { jpeg: "image/jpeg", cr3: "application/octet-stream", mov: "video/quicktime" };

const json = (status: number, body: unknown): SimResponse => ({ status, json: body });
const msg = (status: number, message: string) => json(status, { message });
const BAD_QUERY = msg(400, "Illegal query parameter");
const NOT_FOUND = msg(404, "URL not found");

export class Card {
  /** Capacity in bytes. A small card: everything is held in memory. */
  readonly maxsize = 256 * 1024 * 1024;
  dirs: string[] = ["100CANON"];
  current = "100CANON";
  files: CardFile[] = [];
  /** DCF file number for the next file (continuous numbering, 0001-9999). */
  private next = 1;
  private onEvent: (e: ContentEvent) => void;
  /** The camera clock (ms since the epoch), for modification dates. */
  private now: () => number;

  constructor(onEvent: (e: ContentEvent) => void, now: () => number = Date.now) {
    this.onEvent = onEvent;
    this.now = now;
  }

  storagePath() {
    return `${CONTENTS}/${STORAGE}`;
  }
  dirPath(dir: string) {
    return `${CONTENTS}/${STORAGE}/${dir}`;
  }
  path(f: CardFile) {
    return `${this.dirPath(f.dir)}/${f.name}`;
  }

  used() {
    return this.files.reduce((n, f) => n + f.main.length, 0);
  }
  free() {
    return this.maxsize - this.used();
  }

  storageInfo() {
    return { name: STORAGE, path: this.storagePath(), accesscapability: "readwrite", maxsize: this.maxsize, spacesize: this.free(), contentsnumber: this.files.length };
  }

  /** Takes the next file number (all files of one capture share it). */
  takeNumber(): number {
    const n = this.next;
    this.next = (this.next % 9999) + 1;
    return n;
  }

  add(f: Omit<CardFile, "dir" | "protect" | "archive" | "rotate" | "rating">): CardFile {
    if (!this.dirs.includes(this.current)) {
      this.dirs.push(this.current);
      this.dirs.sort();
      this.onEvent({ type: "added", path: this.dirPath(this.current) });
    }
    const file: CardFile = { ...f, dir: this.current, protect: "disable", archive: "disable", rotate: "0", rating: "off" };
    this.files.push(file);
    this.onEvent({ type: "added", path: this.path(file) });
    return file;
  }

  find(path: string): CardFile | undefined {
    return this.files.find((f) => this.path(f) === path);
  }

  /** Erases everything, protected files included, and starts an empty folder. */
  format() {
    this.files = [];
    this.current = `100${this.current.slice(3)}`;
    this.dirs = [this.current];
    this.onEvent({ type: "cardformat", path: this.storagePath() });
  }

  /** A new folder, numbered after the highest one; it becomes the recording folder. */
  createDirectory(name: string): string | null {
    const top = Math.max(99, ...this.dirs.map((d) => Number(d.slice(0, 3))));
    if (top >= 999) return null;
    const dir = `${top + 1}${name || this.current.slice(3)}`;
    this.dirs.push(dir);
    this.dirs.sort();
    this.current = dir;
    this.onEvent({ type: "added", path: this.dirPath(dir) });
    return dir;
  }

  // ---------------------------------------------------------------- contents API

  /** GET/PUT/DELETE under /contents. `rest` is the path after /contents. */
  handle(method: string, rest: string, params: URLSearchParams, headers: Record<string, string>, body: unknown): SimResponse {
    const parts = rest.split("/").filter(Boolean);
    if (!parts.length) return method === "GET" ? json(200, { path: [this.storagePath()] }) : msg(405, "Method not allowed");
    if (parts[0] !== STORAGE) return NOT_FOUND;
    if (parts.length === 1) return method === "GET" ? json(200, { path: this.dirs.map((d) => this.dirPath(d)) }) : msg(405, "Method not allowed");
    const dir = parts[1];
    if (!this.dirs.includes(dir)) return NOT_FOUND;
    if (parts.length === 2) {
      if (method === "GET") return this.list(dir, params);
      if (method === "DELETE") return this.deleteDir(dir);
      return msg(405, "Method not allowed");
    }
    if (parts.length !== 3) return NOT_FOUND;
    const file = this.files.find((f) => f.dir === dir && f.name === parts[2]);
    if (!file) return NOT_FOUND;
    if (method === "GET") return this.read(file, params, headers);
    if (method === "PUT") return this.modify(file, body);
    if (method === "DELETE") return this.deleteFile(file);
    return msg(405, "Method not allowed");
  }

  private list(dir: string, params: URLSearchParams): SimResponse {
    const type = params.get("type") ?? "all";
    const kind = params.get("kind") ?? "list";
    if (!(type in TYPES) || !["list", "chunked", "number"].includes(kind)) return BAD_QUERY;
    if (params.has("page") && kind !== "list") return BAD_QUERY;
    if (params.has("order") && kind !== "chunked") return BAD_QUERY;
    const want = TYPES[type];
    let paths = this.files.filter((f) => f.dir === dir && (type === "all" || f.kind === want)).map((f) => this.path(f));
    if (kind === "number") return json(200, { contentsnumber: paths.length, pagenumber: Math.ceil(paths.length / PAGE) });
    if (kind === "chunked") {
      const order = params.get("order") ?? "asc";
      if (order !== "asc" && order !== "desc") return BAD_QUERY;
      if (order === "desc") paths = paths.reverse();
      // The camera sends one JSON object per HTTP chunk; once de-chunked they follow each other.
      const chunks: string[] = [];
      for (let i = 0; i < paths.length || i === 0; i += PAGE) chunks.push(JSON.stringify({ path: paths.slice(i, i + PAGE) }));
      return { status: 200, bytes: new TextEncoder().encode(chunks.join("")), contentType: "application/octet-stream" };
    }
    const page = params.has("page") ? Number(params.get("page")) : 1;
    if (!Number.isInteger(page) || page < 1) return BAD_QUERY;
    return json(200, { path: paths.slice((page - 1) * PAGE, page * PAGE) });
  }

  private read(f: CardFile, params: URLSearchParams, headers: Record<string, string>): SimResponse {
    const kind = params.get("kind") ?? "main";
    if (kind === "info") {
      return json(200, { filesize: f.main.length, protect: f.protect, archive: f.archive, rotate: f.rotate, rating: f.rating, lastmodifieddate: f.modified, playtime: f.playtime, hdr: "off" });
    }
    const pick: Record<string, Uint8Array | undefined> = { main: f.main, thumbnail: f.thumb, display: f.display, embedded: f.embedded };
    if (!(kind in pick)) return BAD_QUERY;
    const bytes = pick[kind];
    if (!bytes) return BAD_QUERY;
    const contentType = kind === "main" ? CONTENT_TYPE[f.kind] : "image/jpeg";
    const range = headers.range;
    // Responses get their own copy: a host may transfer the buffer to another
    // thread (a Web Worker's postMessage), which empties it for the sender, and
    // the card must still hold the file for the next download.
    if (!range) return { status: 200, bytes: bytes.slice(), contentType, headers: { "accept-ranges": "bytes" } };
    const r = parseRange(range, bytes.length);
    if (!r) return { status: 416, json: { message: "Requested range not satisfiable" }, headers: { "content-range": `bytes */${bytes.length}` } };
    return {
      status: 206,
      bytes: bytes.slice(r[0], r[1] + 1),
      contentType,
      headers: { "accept-ranges": "bytes", "content-range": `bytes ${r[0]}-${r[1]}/${bytes.length}` },
    };
  }

  private modify(f: CardFile, body: unknown): SimResponse {
    const b = (body ?? {}) as Record<string, unknown>;
    const values: Record<string, string[]> = {
      rotate: ["0", "90", "180", "270"],
      protect: ["enable", "disable"],
      archive: ["enable", "disable"],
      rating: ["off", "1", "2", "3", "4", "5"],
    };
    if (b.action === "gps") {
      if (!validGps(b.gps)) return msg(400, "Invalid parameter");
      f.gps = b.gps;
    } else {
      const allowed = typeof b.action === "string" ? values[b.action] : undefined;
      if (!allowed || typeof b.value !== "string" || !allowed.includes(b.value)) return msg(400, "Invalid parameter");
      (f as unknown as Record<string, string>)[b.action as string] = b.value;
    }
    f.modified = httpDate(this.now());
    this.onEvent({ type: "updated", path: this.path(f) });
    return json(200, {});
  }

  private deleteFile(f: CardFile): SimResponse {
    if (f.protect === "enable") return msg(409, "File protected");
    this.files = this.files.filter((x) => x !== f);
    this.onEvent({ type: "deleted", path: this.path(f) });
    return json(200, {});
  }

  /** Deletes a folder with its files; protected files stay, and so does the folder then. */
  private deleteDir(dir: string): SimResponse {
    const inDir = this.files.filter((f) => f.dir === dir);
    const kept = inDir.filter((f) => f.protect === "enable");
    for (const f of inDir) if (f.protect !== "enable") this.onEvent({ type: "deleted", path: this.path(f) });
    this.files = this.files.filter((f) => f.dir !== dir || f.protect === "enable");
    if (kept.length) return msg(409, "Partial deletion");
    this.dirs = this.dirs.filter((d) => d !== dir);
    this.onEvent({ type: "deleted", path: this.dirPath(dir) });
    // Shooting recreates the recording folder if it was this one.
    return json(200, {});
  }
}

/** "bytes=a-b", "bytes=a-" or "bytes=-n" as [first, last], or null if unusable. */
function parseRange(header: string, size: number): [number, number] | null {
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let first: number;
  let last: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!n) return null;
    first = Math.max(0, size - n);
    last = size - 1;
  } else {
    first = Number(m[1]);
    last = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  }
  if (first >= size || last < first) return null;
  return [first, last];
}

/** Rough shape check of a GPS object: refs, rationals as [numerator, denominator]. */
function validGps(g: unknown): boolean {
  if (!g || typeof g !== "object") return false;
  const o = g as Record<string, unknown>;
  const rational = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0) && v[1] !== 0;
  const dms = (v: unknown) => !!v && typeof v === "object" && ["degree", "minute", "second"].every((k) => rational((v as Record<string, unknown>)[k]));
  const hms = (v: unknown) => !!v && typeof v === "object" && ["hour", "minute", "second"].every((k) => rational((v as Record<string, unknown>)[k]));
  return (
    (o.latitude_ref === "N" || o.latitude_ref === "S") && dms(o.latitude) &&
    (o.longitude_ref === "E" || o.longitude_ref === "W") && dms(o.longitude) &&
    (o.altitude_ref === undefined || o.altitude_ref === "P" || o.altitude_ref === "M") &&
    (o.altitude === undefined || rational(o.altitude)) &&
    (o.timestamp === undefined || hms(o.timestamp)) &&
    (o.mapdatum === undefined || (typeof o.mapdatum === "string" && o.mapdatum.length <= 255)) &&
    (o.status === undefined || o.status === "A" || o.status === "V") &&
    (o.datestamp === undefined || (typeof o.datestamp === "string" && /^\d{4}:\d{2}:\d{2}$/.test(o.datestamp)))
  );
}

/** RFC 1123 date in GMT, e.g. "Wed, 04 Jul 2018 12:34:56 GMT". */
export const httpDate = (ms: number) => new Date(ms).toUTCString();
