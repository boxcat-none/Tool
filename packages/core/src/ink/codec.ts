import type { InkTool, Stroke } from "./types";

/**
 * 筆跡的精簡二進位格式（存進 PDF 前會再經過 Flate 壓縮）：
 *
 *   "TINK" | 版本 u8 | 筆畫數 varint
 *   每筆：工具 u8 | 顏色 r g b | 粗細×10 varint | 點數 varint
 *         x、y：×10 取整後，與前一點的差值（zigzag varint）；第一點存絕對值
 *         筆壓：0–255 u8
 *
 * 相鄰取樣點距離很近，差值多半落在 ±63 內，只要 1 byte。
 */

const MAGIC = [0x54, 0x49, 0x4e, 0x4b]; // "TINK"
const VERSION = 1;
const TOOLS: InkTool[] = ["pen", "highlighter"];

/** 座標精度：0.1 pt（約 0.035 mm） */
export const COORD_SCALE = 10;

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  varint(v: number) {
    // 只處理非負整數；超過 2^31 的值不會出現在筆跡資料裡
    this.ensure(5);
    let n = v >>> 0;
    while (n >= 0x80) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    this.buf[this.len++] = n;
  }
  zigzag(v: number) {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes() {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  private pos = 0;
  constructor(private buf: Uint8Array) {}
  u8() {
    if (this.pos >= this.buf.length) throw new Error("筆跡資料不完整");
    return this.buf[this.pos++];
  }
  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
      if (shift > 35) throw new Error("筆跡資料格式錯誤");
    }
  }
  zigzag() {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
}

export function encodeStrokes(strokes: Stroke[]): Uint8Array {
  const w = new Writer();
  MAGIC.forEach((b) => w.u8(b));
  w.u8(VERSION);
  w.varint(strokes.length);
  for (const s of strokes) writeStroke(w, s);
  return w.bytes();
}

/** 單一筆畫的編碼（不含檔頭），用於同步資料：每一筆各自存放 */
export function encodeStroke(stroke: Stroke): Uint8Array {
  const w = new Writer();
  writeStroke(w, stroke);
  return w.bytes();
}

function writeStroke(w: Writer, s: Stroke) {
  w.u8(Math.max(0, TOOLS.indexOf(s.tool)));
  const [r, g, b] = parseColor(s.color);
  w.u8(r);
  w.u8(g);
  w.u8(b);
  w.varint(Math.round(s.size * 10));
  w.varint(s.points.length);
  let px = 0;
  let py = 0;
  for (const [x, y, p] of s.points) {
    const qx = Math.round(x * COORD_SCALE);
    const qy = Math.round(y * COORD_SCALE);
    w.zigzag(qx - px);
    w.zigzag(qy - py);
    w.u8(Math.round(Math.max(0, Math.min(1, p)) * 255));
    px = qx;
    py = qy;
  }
}

export function decodeStrokes(bytes: Uint8Array): Stroke[] {
  const r = new Reader(bytes);
  for (const b of MAGIC) if (r.u8() !== b) throw new Error("不是筆跡資料");
  const version = r.u8();
  if (version !== VERSION) throw new Error(`不支援的筆跡資料版本：${version}`);
  const count = r.varint();
  const strokes: Stroke[] = [];
  for (let i = 0; i < count; i++) strokes.push(readStroke(r));
  return strokes;
}

export function decodeStroke(bytes: Uint8Array): Stroke {
  return readStroke(new Reader(bytes));
}

function readStroke(r: Reader): Stroke {
  const tool = TOOLS[r.u8()] ?? "pen";
  const color = toHex(r.u8(), r.u8(), r.u8());
  const size = r.varint() / 10;
  const n = r.varint();
  const points: Stroke["points"] = [];
  let x = 0;
  let y = 0;
  for (let j = 0; j < n; j++) {
    x += r.zigzag();
    y += r.zigzag();
    points.push([x / COORD_SCALE, y / COORD_SCALE, r.u8() / 255]);
  }
  return { tool, color, size, points };
}

export function parseColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
