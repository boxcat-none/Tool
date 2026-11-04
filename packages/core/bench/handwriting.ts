import type { Stroke } from "../src/ink";

/**
 * 模擬中文手寫，用於容量測試。
 *
 * 參數依 Apple Pencil 的實際條件設定：
 * - 取樣頻率 240 Hz（Safari 的 getCoalescedEvents 可以拿到全部取樣點）
 * - 書寫速度 25–60 mm/s
 * - 感測器雜訊 σ = 0.08 pt
 * - 筆壓：下筆漸重、收筆漸輕，加上小幅波動
 * 每個字 8–14 筆（橫、豎、撇、點、折），字框 24 pt（約 8.5 mm，一般筆記字的大小）。
 */

const MM = 72 / 25.4;
const SAMPLE_HZ = 240;

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  return { next, gauss, range: (a: number, b: number) => a + (b - a) * next() };
}

type Rand = ReturnType<typeof rng>;

/** 沿著控制點（二次貝茲曲線串接）依書寫速度取樣 */
function sampleStroke(r: Rand, path: [number, number][], color: string, size: number): Stroke {
  const speed = r.range(25, 60) * MM; // pt/s
  // 先用細分估計路徑長度
  const dense: [number, number][] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [x0, y0] = path[i];
    const [x1, y1] = path[i + 1];
    const bend = r.range(-0.15, 0.15);
    const cx = (x0 + x1) / 2 - (y1 - y0) * bend;
    const cy = (y0 + y1) / 2 + (x1 - x0) * bend;
    for (let t = 0; t < 1; t += 0.01) {
      const u = 1 - t;
      dense.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
    }
  }
  dense.push(path[path.length - 1]);
  let length = 0;
  for (let i = 1; i < dense.length; i++) length += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
  const n = Math.max(3, Math.round((length / speed) * SAMPLE_HZ));

  const peak = r.range(0.45, 0.85);
  const points: Stroke["points"] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const [x, y] = dense[Math.min(dense.length - 1, Math.round(t * (dense.length - 1)))];
    const envelope = Math.min(1, t * 6) * Math.min(1, (1 - t) * 4 + 0.4);
    const p = Math.max(0.05, Math.min(1, 0.15 + (peak - 0.15) * envelope + r.gauss() * 0.02));
    points.push([x + r.gauss() * 0.08, y + r.gauss() * 0.08, p]);
  }
  return { tool: "pen", color, size, points };
}

/** 在字框內產生一個「字」的筆畫（左下角 x0, y0，邊長 s） */
function character(r: Rand, x0: number, y0: number, s: number, color: string): Stroke[] {
  const strokes: Stroke[] = [];
  const count = Math.round(r.range(8, 14));
  const P = (u: number, v: number): [number, number] => [x0 + u * s, y0 + v * s];
  for (let i = 0; i < count; i++) {
    const kind = r.next();
    const u = r.range(0.1, 0.6);
    const v = r.range(0.15, 0.9);
    let path: [number, number][];
    if (kind < 0.3) path = [P(u, v), P(u + r.range(0.25, 0.7), v + r.range(-0.02, 0.06))]; // 橫
    else if (kind < 0.55) path = [P(u + 0.1, v), P(u + 0.1 + r.range(-0.03, 0.03), v - r.range(0.3, 0.75))]; // 豎
    else if (kind < 0.7) path = [P(u + 0.3, v), P(u + 0.1, v - 0.25), P(u - 0.05, v - r.range(0.35, 0.6))]; // 撇
    else if (kind < 0.85) path = [P(u, v), P(u + r.range(0.05, 0.12), v - r.range(0.06, 0.14))]; // 點
    else path = [P(u, v), P(u + r.range(0.3, 0.5), v), P(u + r.range(0.3, 0.5) - 0.03, v - r.range(0.3, 0.6))]; // 折
    strokes.push(sampleStroke(r, path, color, 1.6));
  }
  return strokes;
}

export interface PageSpec {
  chars: number;
  highlights?: number;
}

/** 產生一頁 A4 筆記：由上往下、由左往右書寫，偶爾換紅筆，加上幾條螢光筆 */
export function handwrittenPage(seed: number, spec: PageSpec): Stroke[] {
  const r = rng(seed);
  const strokes: Stroke[] = [];
  const box = 24;
  const lineGap = 32;
  const left = 50;
  const cols = Math.floor((595 - left * 2) / box);
  let color = "#1e3a8a";
  for (let i = 0; i < spec.chars; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (r.next() < 0.03) color = color === "#1e3a8a" ? "#b91c1c" : "#1e3a8a";
    strokes.push(...character(r, left + col * box, 790 - (row + 1) * lineGap, box * 0.85, color));
  }
  for (let i = 0; i < (spec.highlights ?? 0); i++) {
    const row = Math.floor(r.range(0, Math.max(1, Math.ceil(spec.chars / cols))));
    const y = 790 - (row + 1) * lineGap + box * 0.4;
    const x0 = left + r.range(0, 100);
    const s = sampleStroke(r, [[x0, y], [x0 + r.range(120, 300), y + r.range(-2, 2)]], "#facc15", 14);
    strokes.push({ ...s, tool: "highlighter", points: s.points.map(([x, y]) => [x, y, 0.5]) });
  }
  return strokes;
}
