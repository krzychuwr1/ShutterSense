// Binary formats the virtual camera writes:
//  - framed records for live view (image / incidental info) and event data:
//      FF 00 <type:1> <size:4, big-endian> <data> FF FF
//    type 0x00 = JPEG, 0x01 = incidental info JSON, 0x02 = event JSON.
//    Big-endian size is our
//    choice, and the client reads either.
//  - the multipart live-view stream (boundary "boundary", LF line ends),
//  - movie files: Motion-JPEG in a QuickTime container (.MOV), which any
//    player that knows QuickTime can open. Frames are the JPEGs the camera
//    renders while recording, each with its real duration,
//  - RAW files: a small container of our own, documented below. Files are
//    named .CR3 because the camera would name them so, but the bytes are NOT
//    the real CR3 format; only this simulator's format.

export const RECORD_JPEG = 0x00;
export const RECORD_INFO = 0x01;
export const RECORD_EVENT = 0x02;

export function record(type: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 9);
  out[0] = 0xff;
  out[1] = 0x00;
  out[2] = type;
  new DataView(out.buffer).setUint32(3, data.length, false);
  out.set(data, 7);
  out[7 + data.length] = 0xff;
  out[8 + data.length] = 0xff;
  return out;
}

export const jsonRecord = (type: number, value: unknown) => record(type, new TextEncoder().encode(JSON.stringify(value)));

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One multipart part per JPEG, LF line ends, then the closing boundary. */
export function multipart(jpegs: Uint8Array[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const j of jpegs) {
    parts.push(enc.encode(`--boundary\nContent-Type: image/jpeg\nContent-Length: ${j.length}\n\n`), j, enc.encode("\n"));
  }
  parts.push(enc.encode("--boundary--\n"));
  return concat(parts);
}

export const MULTIPART_TYPE = "multipart/x-mixed-replace;boundary=boundary";

// ------------------------------------------------------------------ QuickTime (Motion-JPEG)

/** A growable big-endian byte writer for QuickTime atoms. */
class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private room(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.room(1);
    this.view.setUint8(this.length++, v);
  }
  u16(v: number) {
    this.room(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }
  u32(v: number) {
    this.room(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
  }
  /** Writes an atom: size placeholder, type, body, then patches the size. */
  atom(type: string, body: () => void) {
    const start = this.length;
    this.u32(0);
    this.str(type);
    body();
    this.view.setUint32(start, this.length - start);
  }
  matrix() {
    for (const v of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) this.u32(v);
  }
  done() {
    return this.buf.slice(0, this.length);
  }
}

export interface MovieFrame {
  jpeg: Uint8Array;
  /** Display time of this frame in milliseconds. */
  ms: number;
}

/** A QuickTime movie with one Motion-JPEG ("jpeg") video track, timescale 1 ms. */
export function quicktimeMjpeg(frames: MovieFrame[], width: number, height: number): Uint8Array {
  const w = new Writer();
  const duration = frames.reduce((n, f) => n + f.ms, 0);
  w.atom("ftyp", () => {
    w.str("qt  ");
    w.u32(0x200);
    w.str("qt  ");
  });
  const dataStart = w.length + 8;
  w.atom("mdat", () => frames.forEach((f) => w.bytes(f.jpeg)));
  w.atom("moov", () => {
    w.atom("mvhd", () => {
      w.u32(0); // version, flags
      w.u32(0); // created
      w.u32(0); // modified
      w.u32(1000); // timescale
      w.u32(duration);
      w.u32(0x10000); // rate 1.0
      w.u16(0x100); // volume 1.0
      w.zeros(10);
      w.matrix();
      w.zeros(24); // preview, poster, selection, current time
      w.u32(2); // next track id
    });
    w.atom("trak", () => {
      w.atom("tkhd", () => {
        w.u32(0x3); // enabled, in movie
        w.u32(0);
        w.u32(0);
        w.u32(1); // track id
        w.u32(0);
        w.u32(duration);
        w.zeros(8);
        w.u16(0); // layer
        w.u16(0); // alternate group
        w.u16(0); // volume (video)
        w.u16(0);
        w.matrix();
        w.u32(width << 16);
        w.u32(height << 16);
      });
      w.atom("mdia", () => {
        w.atom("mdhd", () => {
          w.u32(0);
          w.u32(0);
          w.u32(0);
          w.u32(1000);
          w.u32(duration);
          w.u16(0x55c4); // language "und"
          w.u16(0);
        });
        w.atom("hdlr", () => {
          w.u32(0);
          w.str("mhlr");
          w.str("vide");
          w.zeros(12);
          w.u8(0); // empty name
        });
        w.atom("minf", () => {
          w.atom("vmhd", () => {
            w.u32(0x1);
            w.u16(0x40); // dither copy
            w.u16(0x8000);
            w.u16(0x8000);
            w.u16(0x8000);
          });
          w.atom("hdlr", () => {
            w.u32(0);
            w.str("dhlr");
            w.str("alis");
            w.zeros(12);
            w.u8(0);
          });
          w.atom("dinf", () =>
            w.atom("dref", () => {
              w.u32(0);
              w.u32(1);
              w.atom("alis", () => w.u32(0x1)); // data is in this file
            }),
          );
          w.atom("stbl", () => {
            w.atom("stsd", () => {
              w.u32(0);
              w.u32(1);
              w.atom("jpeg", () => {
                w.zeros(6);
                w.u16(1); // data reference index
                w.u16(0); // version
                w.u16(0); // revision
                w.u32(0); // vendor
                w.u32(0); // temporal quality
                w.u32(0x200); // spatial quality: normal
                w.u16(width);
                w.u16(height);
                w.u32(72 << 16);
                w.u32(72 << 16);
                w.u32(0); // data size
                w.u16(1); // frames per sample
                const name = "Photo - JPEG";
                w.u8(name.length);
                w.str(name);
                w.zeros(31 - name.length);
                w.u16(24); // depth
                w.u16(0xffff); // no colour table
              });
            });
            w.atom("stts", () => {
              w.u32(0);
              w.u32(frames.length);
              for (const f of frames) {
                w.u32(1);
                w.u32(Math.max(1, Math.round(f.ms)));
              }
            });
            w.atom("stsc", () => {
              w.u32(0);
              w.u32(1);
              w.u32(1); // first chunk
              w.u32(frames.length); // samples per chunk: all in one
              w.u32(1);
            });
            w.atom("stsz", () => {
              w.u32(0);
              w.u32(0);
              w.u32(frames.length);
              for (const f of frames) w.u32(f.jpeg.length);
            });
            w.atom("stco", () => {
              w.u32(0);
              w.u32(1);
              w.u32(dataStart);
            });
          });
        });
      });
    });
  });
  return w.done();
}

// ------------------------------------------------------------------ RAW container

/**
 * The simulator's RAW format (little-endian):
 *
 *   offset size  field
 *   0      8     magic "SIMRAW01"
 *   8      4     header size (64)
 *   12     4     width
 *   16     4     height
 *   20     2     bits per sample (14, or 12 for compact RAW)
 *   22     2     colour filter layout: 0 = RGGB Bayer
 *   24     4     black level
 *   28     4     white level
 *   32     12    as-shot white balance gains R, G, B (float32)
 *   44     4     embedded JPEG offset
 *   48     4     embedded JPEG length
 *   52     12    reserved (0)
 *   64     ...   mosaic, uint16 per photosite, row by row; then the JPEG
 *
 * Values are linear sensor data after exposure and noise, before white balance.
 */
export function simRaw(linear: Float32Array, w: number, h: number, wbGains: [number, number, number], jpeg: Uint8Array, compact: boolean): Uint8Array {
  const bits = compact ? 12 : 14;
  const black = compact ? 128 : 512;
  const white = (1 << bits) - 1;
  const header = 64;
  const mosaicBytes = w * h * 2;
  const out = new Uint8Array(header + mosaicBytes + jpeg.length);
  const v = new DataView(out.buffer);
  "SIMRAW01".split("").forEach((c, i) => (out[i] = c.charCodeAt(0)));
  v.setUint32(8, header, true);
  v.setUint32(12, w, true);
  v.setUint32(16, h, true);
  v.setUint16(20, bits, true);
  v.setUint16(22, 0, true);
  v.setUint32(24, black, true);
  v.setUint32(28, white, true);
  wbGains.forEach((g, i) => v.setFloat32(32 + i * 4, g, true));
  v.setUint32(44, header + mosaicBytes, true);
  v.setUint32(48, jpeg.length, true);
  const range = white - black;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // RGGB: even rows R G, odd rows G B.
      const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : (x & 1) === 0 ? 1 : 2;
      const lin = Math.min(1, Math.max(0, linear[(y * w + x) * 3 + c]));
      v.setUint16(header + (y * w + x) * 2, black + Math.round(lin * range), true);
    }
  }
  out.set(jpeg, header + mosaicBytes);
  return out;
}
