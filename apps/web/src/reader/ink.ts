import { strokeOutline, type Stroke } from "@tool/core/ink/core";
import type { Notebook } from "@tool/notes/notebook";

/**
 * 閱讀器上的手寫層。
 *
 * 每一頁疊三層：
 *   螢光筆層（CSS mix-blend-mode: multiply，和底下的頁面相乘，不會蓋住字）
 *   鋼筆層
 *   輸入層（最上層，畫筆模式時接收觸控筆／滑鼠，裡面放「正在畫的那一筆」）
 *
 * 筆跡座標是 PDF 使用者空間（pt），用 pdf.js viewport 的轉換矩陣畫到畫面上，
 * 所以縮放、旋轉都會對齊。已完成的筆畫外框會快取成 Path2D，重畫整頁很快。
 */

export type Tool = "read" | "pen" | "highlighter" | "eraser";

export interface InkSettings {
  tool: Tool;
  penColor: string;
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
  /** 只接受觸控筆書寫（手指、手掌不會畫線） */
  penOnly: boolean;
}

/** pdf.js PDFPageView 中用到的部分 */
interface PageView {
  id: number; // 頁碼（1 起算）
  div: HTMLDivElement;
  viewport: {
    width: number;
    height: number;
    scale: number;
    transform: number[];
    convertToPdfPoint(x: number, y: number): number[];
  };
}

interface PageLayers {
  view: PageView;
  root: HTMLDivElement;
  highlight: HTMLCanvasElement;
  pen: HTMLCanvasElement;
  input: HTMLDivElement;
  live: HTMLCanvasElement;
  dpr: number;
}

const HIGHLIGHTER_ALPHA = 0.35;
/** 橡皮擦半徑（螢幕 px） */
const ERASER_RADIUS = 10;
const MAX_CANVAS_PIXELS = 16_000_000;

export class InkController {
  private layers = new Map<number, PageLayers>();
  private paths = new Map<string, Path2D>();
  private decoded = new Map<string, { stroke: Stroke; bbox: [number, number, number, number] }>();
  /** 每頁的筆畫清單（筆記本有變動就清掉重讀） */
  private pageCache = new Map<string, { id: string; stroke: Stroke }[]>();
  /** 橡皮擦拖曳中，暫時隱藏（放開時才真正刪除，整次拖曳是一個復原步驟） */
  private erasing = new Set<string>();
  private active: { index: number; pointerId: number; pointerType: string; l: PageLayers; stroke?: Stroke; frame?: number } | null = null;
  private offChange: () => void;

  constructor(
    private nb: Notebook,
    private pageIdAt: (index: number) => string | undefined,
    private settings: () => InkSettings,
    private origin: unknown,
  ) {
    this.offChange = nb.onChange(() => {
      this.pageCache.clear();
      this.redrawAll();
    });
  }

  destroy() {
    this.offChange();
    for (const l of this.layers.values()) {
      l.root.remove();
      l.input.remove();
    }
    this.layers.clear();
  }

  /** pdf.js 每次畫好一頁（包含縮放後重畫）都會呼叫；pdf.js 重設頁面時會移除我們的元素，所以每次都重新掛上 */
  attach(view: PageView) {
    const index = view.id - 1;
    let l = this.layers.get(index);
    if (!l || l.view !== view) {
      l = this.createLayers(view);
      this.layers.set(index, l);
    }
    const canvasWrapper = view.div.querySelector(".canvasWrapper");
    if (!l.root.isConnected) {
      if (canvasWrapper) canvasWrapper.after(l.root);
      else view.div.append(l.root);
    }
    if (!l.input.isConnected) view.div.append(l.input);
    this.resize(l);
    this.applyTool(l);
    this.redraw(index);
  }

  /** 顯示用的 PDF 換了（插頁、刪頁等），舊的頁面元素都作廢 */
  reset() {
    for (const l of this.layers.values()) {
      l.root.remove();
      l.input.remove();
    }
    this.layers.clear();
    this.pageCache.clear();
  }

  /** 工具改變時更新游標與輸入層 */
  refreshTool() {
    for (const l of this.layers.values()) this.applyTool(l);
  }

  redrawAll() {
    for (const index of this.layers.keys()) this.redraw(index);
  }

  private createLayers(view: PageView): PageLayers {
    const root = document.createElement("div");
    root.className = "ink-layer";
    const highlight = document.createElement("canvas");
    highlight.className = "ink-layer__highlight";
    const pen = document.createElement("canvas");
    pen.className = "ink-layer__pen";
    root.append(highlight, pen);

    const input = document.createElement("div");
    input.className = "ink-input";
    const live = document.createElement("canvas");
    live.className = "ink-input__live";
    input.append(live);

    const l: PageLayers = { view, root, highlight, pen, input, live, dpr: 1 };
    input.addEventListener("pointerdown", (e) => this.onDown(l, e));
    input.addEventListener("pointermove", (e) => this.onMove(l, e));
    input.addEventListener("pointerup", (e) => this.onUp(l, e));
    input.addEventListener("pointercancel", (e) => this.onUp(l, e));
    // Apple Pencil：在第一個觸控事件就取消瀏覽器的預設行為，
    // 否則 Safari 會把筆的拖曳當成「長按選取文字」或捲動頁面
    const stopStylus = (e: TouchEvent) => {
      if (this.settings().tool === "read") return;
      if (Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === "stylus")) {
        e.preventDefault();
      }
    };
    input.addEventListener("touchstart", stopStylus, { passive: false });
    input.addEventListener("touchmove", stopStylus, { passive: false });
    input.addEventListener("pointerleave", () => {
      if (!this.active) this.clearLive(l);
    });
    return l;
  }

  private resize(l: PageLayers) {
    const { width, height } = l.view.viewport;
    let dpr = window.devicePixelRatio || 1;
    if (width * height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
    l.dpr = dpr;
    for (const c of [l.highlight, l.pen, l.live]) {
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
  }

  private applyTool(l: PageLayers) {
    const { tool } = this.settings();
    l.input.dataset.tool = tool;
    // 閱讀模式：輸入層不攔截滑鼠，才能選取文字、點連結
    l.input.style.pointerEvents = tool === "read" ? "none" : "auto";
    // 「只用觸控筆」：手指交給瀏覽器捲動（兩指縮放由 gestures.ts 處理）；否則手指也用來書寫
    l.input.style.touchAction = this.settings().penOnly ? "pan-x pan-y" : "none";
    if (tool === "read") this.clearLive(l);
  }

  /** 設定 canvas 的轉換：PDF 座標 → 裝置像素 */
  private setTransform(ctx: CanvasRenderingContext2D, l: PageLayers) {
    const [a, b, c, d, e, f] = l.view.viewport.transform;
    const s = l.dpr;
    ctx.setTransform(a * s, b * s, c * s, d * s, e * s, f * s);
  }

  private redraw(index: number) {
    const l = this.layers.get(index);
    if (!l) return;
    const pageId = this.pageIdAt(index);
    const hl = l.highlight.getContext("2d")!;
    const pen = l.pen.getContext("2d")!;
    for (const ctx of [hl, pen]) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, l.pen.width, l.pen.height);
      this.setTransform(ctx, l);
    }
    if (!pageId) return;
    hl.globalAlpha = HIGHLIGHTER_ALPHA;
    for (const { id, stroke } of this.pageStrokes(pageId)) {
      if (this.erasing.has(id)) continue;
      const ctx = stroke.tool === "highlighter" ? hl : pen;
      ctx.fillStyle = stroke.color;
      ctx.fill(this.pathFor(id, stroke));
    }
  }

  /** 讀出某頁的筆畫（依頁快取；解碼結果與範圍依筆畫代號快取） */
  private pageStrokes(pageId: string) {
    let list = this.pageCache.get(pageId);
    if (!list) {
      list = this.nb.strokes(pageId);
      for (const { id, stroke } of list) {
        if (!this.decoded.has(id)) this.decoded.set(id, { stroke, bbox: bounds(stroke) });
      }
      this.pageCache.set(pageId, list);
    }
    return list;
  }

  private pathFor(id: string, stroke: Stroke): Path2D {
    let p = this.paths.get(id);
    if (!p) {
      p = outlinePath(stroke);
      this.paths.set(id, p);
    }
    return p;
  }

  // ── 輸入 ───────────────────────────────────────────

  private toPdf(l: PageLayers, e: PointerEvent): [number, number, number] {
    const rect = l.input.getBoundingClientRect();
    const [x, y] = l.view.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
    // 只有觸控筆有真正的筆壓；滑鼠、手指用固定值
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return [x, y, pressure];
  }

  /** 正在用手指畫的那一筆作廢（例如變成兩指縮放） */
  cancelTouchStroke() {
    const a = this.active;
    if (!a || a.pointerType !== "touch") return;
    if (a.frame) cancelAnimationFrame(a.frame);
    this.active = null;
    if (this.erasing.size) {
      this.erasing.clear();
      this.redraw(a.index);
    }
    this.clearLive(a.l);
  }

  private onDown(l: PageLayers, e: PointerEvent) {
    const s = this.settings();
    if (s.tool === "read") return;
    if (s.penOnly && e.pointerType === "touch") return;
    if (this.active) {
      // 第二根手指放下：這是縮放手勢，不是書寫
      if (e.pointerType === "touch" && this.active.pointerType === "touch") this.cancelTouchStroke();
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    l.input.setPointerCapture(e.pointerId);
    const index = l.view.id - 1;
    this.active = { index, pointerId: e.pointerId, pointerType: e.pointerType, l };
    if (s.tool === "eraser") {
      this.eraseAt(l, this.toPdf(l, e));
      this.drawEraserCursor(l, e);
    } else {
      const highlighter = s.tool === "highlighter";
      this.active.stroke = {
        tool: highlighter ? "highlighter" : "pen",
        color: highlighter ? s.highlighterColor : s.penColor,
        size: highlighter ? s.highlighterSize : s.penSize,
        points: [this.toPdf(l, e)],
      };
      this.scheduleLive(l);
    }
  }

  private onMove(l: PageLayers, e: PointerEvent) {
    const s = this.settings();
    if (s.tool === "read") return;
    if (!this.active) {
      if (s.tool === "eraser") this.drawEraserCursor(l, e);
      return;
    }
    if (e.pointerId !== this.active.pointerId) return;
    // 一次取得兩次畫面更新之間的所有取樣點（觸控筆每秒 120–240 點），快速書寫才不會變成折線
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples = events.length ? events : [e];
    if (s.tool === "eraser") {
      for (const ev of samples) this.eraseAt(l, this.toPdf(l, ev));
      this.drawEraserCursor(l, e);
      return;
    }
    const stroke = this.active.stroke;
    if (!stroke) return;
    for (const ev of samples) stroke.points.push(this.toPdf(l, ev));
    this.scheduleLive(l);
  }

  private onUp(l: PageLayers, e: PointerEvent) {
    const active = this.active;
    if (!active || e.pointerId !== active.pointerId) return;
    this.active = null;
    if (active.frame) cancelAnimationFrame(active.frame);
    const pageId = this.pageIdAt(active.index);
    if (pageId && active.stroke) {
      const stroke = active.stroke;
      this.nb.doc.transact(() => this.nb.addStroke(pageId, stroke), this.origin);
    }
    if (pageId && this.erasing.size) {
      const ids = [...this.erasing];
      this.erasing.clear();
      this.nb.doc.transact(() => this.nb.removeStrokes(pageId, ids), this.origin);
    }
    this.clearLive(l);
    if (this.settings().tool === "eraser" && e.pointerType !== "touch") this.drawEraserCursor(l, e);
  }

  private scheduleLive(l: PageLayers) {
    if (!this.active || this.active.frame) return;
    this.active.frame = requestAnimationFrame(() => {
      if (!this.active) return;
      this.active.frame = undefined;
      const stroke = this.active.stroke;
      if (!stroke) return;
      const ctx = this.clearLive(l);
      this.setTransform(ctx, l);
      const highlighter = stroke.tool === "highlighter";
      l.live.classList.toggle("ink-input__live--highlighter", highlighter);
      ctx.globalAlpha = highlighter ? HIGHLIGHTER_ALPHA : 1;
      ctx.fillStyle = stroke.color;
      ctx.fill(outlinePath(stroke));
    });
  }

  private clearLive(l: PageLayers): CanvasRenderingContext2D {
    const ctx = l.live.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, l.live.width, l.live.height);
    return ctx;
  }

  private drawEraserCursor(l: PageLayers, e: PointerEvent) {
    const ctx = this.clearLive(l);
    const rect = l.input.getBoundingClientRect();
    ctx.scale(l.dpr, l.dpr);
    ctx.beginPath();
    ctx.arc(e.clientX - rect.left, e.clientY - rect.top, ERASER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgb(255 255 255 / 0.5)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgb(0 0 0 / 0.55)";
    ctx.stroke();
  }

  /** 整筆擦除：橡皮擦碰到的筆畫暫時隱藏，放開時一起刪除 */
  private eraseAt(l: PageLayers, [x, y]: [number, number, number]) {
    const pageId = this.pageIdAt(l.view.id - 1);
    if (!pageId) return;
    const r = ERASER_RADIUS / l.view.viewport.scale;
    let changed = false;
    for (const { id } of this.pageStrokes(pageId)) {
      if (this.erasing.has(id)) continue;
      const d = this.decoded.get(id)!;
      const [x0, y0, x1, y1] = d.bbox;
      const pad = r + d.stroke.size;
      if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
      if (distanceToStroke(d.stroke, x, y) <= r + d.stroke.size * 0.6) {
        this.erasing.add(id);
        changed = true;
      }
    }
    if (changed) this.redraw(l.view.id - 1);
  }
}

function outlinePath(stroke: Stroke): Path2D {
  const outline = strokeOutline(stroke);
  const p = new Path2D();
  outline.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  p.closePath();
  return p;
}

function bounds(stroke: Stroke): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** 點到筆畫中心線（折線）的最短距離 */
function distanceToStroke(stroke: Stroke, x: number, y: number): number {
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}

/**
 * 在縮圖等其他 canvas 上畫出某頁的筆跡（transform：PDF 座標 → 該 canvas 像素）。
 * `minPx`：筆畫在這個 canvas 上至少多寬（像素）。縮圖很小，細筆縮小後幾乎看不見，
 * 加粗一點才看得出哪一頁有筆記。
 */
export function paintStrokes(ctx: CanvasRenderingContext2D, transform: number[], strokes: Stroke[], minPx = 0) {
  const [a, b, c, d, e, f] = transform;
  const scale = Math.hypot(a, b) || 1;
  ctx.save();
  ctx.setTransform(a, b, c, d, e, f);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const s of strokes) {
    const highlighter = s.tool === "highlighter";
    ctx.globalAlpha = highlighter ? HIGHLIGHTER_ALPHA : 1;
    ctx.globalCompositeOperation = highlighter ? "multiply" : "source-over";
    ctx.fillStyle = s.color;
    const path = outlinePath(s);
    ctx.fill(path);
    if (minPx > 0 && !highlighter && s.size * scale < minPx) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = minPx / scale - s.size * 0.5;
      ctx.stroke(path);
    }
  }
  ctx.restore();
}
