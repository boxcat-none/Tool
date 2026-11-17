import { strokeOutline, type Stroke } from "@tool/core/ink/core";
import {
  imagePlacement,
  transformImage,
  transformMatrix,
  transformPoint,
  translation,
  type ClipContent,
  type ContentTransform,
  type ImageOrder,
  type Notebook,
} from "@tool/notes/notebook";
import { MAX_INK_CANVAS_PIXELS } from "../lib/device";
import { fitActions, PageImages, type ImageHost } from "./images";
import { PEN_COLORS } from "./InkToolbar";

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

export type Tool = "read" | "pen" | "highlighter" | "eraser" | "select";

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
    convertToViewportPoint(x: number, y: number): number[];
  };
}

interface PageLayers {
  view: PageView;
  root: HTMLDivElement;
  highlight: HTMLCanvasElement;
  pen: HTMLCanvasElement;
  input: HTMLDivElement;
  live: HTMLCanvasElement;
  /** 其他裝置正在畫、還沒放開的筆畫 */
  remote: HTMLCanvasElement;
  /** 插入的圖片（在筆跡下面） */
  images: PageImages;
  /** 套索選取框（在輸入層裡） */
  lassoBox: HTMLDivElement;
  dpr: number;
}

/** 套索選取：某一頁上選到的筆畫與圖片 */
interface Selection {
  index: number;
  pageId: string;
  strokes: Set<string>;
  images: Set<string>;
}

/** 其他裝置正在畫的筆畫（透過 awareness 即時收到） */
export interface RemoteLiveStroke {
  pageId: string;
  stroke: Stroke;
}

/** 複製下來的選取內容與它原本所在的頁面 */
export interface CopiedSelection {
  clip: ClipContent;
  pageId: string;
}

/** 拖曳套索選取：移動整個選取框、拉右下角等比例縮放、拉下方把手旋轉 */
interface SelectionDrag {
  pointerId: number;
  mode: "move" | "scale" | "rotate";
  start: [number, number];
  /** 縮放：固定不動的對角；旋轉：中心 */
  anchor: [number, number];
  /** 縮放：按下時把手所在的角 */
  handle: [number, number];
  t: ContentTransform;
  moved: boolean;
}

/** 只有筆跡時，旋轉到 0／90／180／270 度附近幾度內就吸附過去 */
const ROTATE_SNAP = 5;
const MIN_SCALE = 0.1;
const MAX_SCALE = 20;

/** 正在畫的筆畫多久送一次給其他裝置（毫秒） */
const LIVE_INTERVAL = 50;

const HIGHLIGHTER_ALPHA = 0.35;
/** 橡皮擦半徑（螢幕 px） */
const ERASER_RADIUS = 10;
/** 手寫層 canvas 的安全上限（正常情況下由 sweep 跟著 pdf.js 釋放，用不到這個上限） */
const MAX_LAYERS = 40;

export class InkController implements ImageHost {
  private layers = new Map<number, PageLayers>();
  private paths = new Map<string, Path2D>();
  private decoded = new Map<string, { stroke: Stroke; bbox: [number, number, number, number] }>();
  /** 每頁的筆畫清單（筆記本有變動就清掉重讀） */
  private pageCache = new Map<string, { id: string; stroke: Stroke }[]>();
  /** 橡皮擦拖曳中，暫時隱藏（放開時才真正刪除，整次拖曳是一個復原步驟） */
  private erasing = new Set<string>();
  private active: {
    index: number;
    pointerId: number;
    pointerType: string;
    l: PageLayers;
    stroke?: Stroke;
    /** 瀏覽器預測的下一段軌跡：只畫在畫面上降低延遲感，不會存進筆記 */
    predicted?: Stroke["points"];
    frame?: number;
  } | null = null;
  private penSeen = false;
  private remoteStrokes: RemoteLiveStroke[] = [];
  private selectedImage: string | null = null;
  /** 套索選取 */
  private selection: Selection | null = null;
  /** 正在畫的套索 */
  private lasso: { index: number; pointerId: number; points: [number, number][] } | null = null;
  /** 拖曳套索選取 */
  private selDrag: SelectionDrag | null = null;
  /** 按「複製」（選取框上的按鈕）時呼叫；剪貼簿由閱讀器保管，才能貼到別頁或別本筆記本 */
  onCopy: ((copied: CopiedSelection) => void) | null = null;
  /** 拖曳中暫時從頁面上拿起來的筆畫（畫在輸入層上跟著移動） */
  private lifted = new Set<string>();
  /** 圖片檔 → 網址（object URL）；null = 讀取中或讀不到（之後重試） */
  private imageUrls = new Map<string, string | null>();
  /** 已經解碼的圖片（畫縮圖用） */
  private imageElements = new Map<string, HTMLImageElement>();
  private liveSentAt = 0;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private offChange: () => void;

  constructor(
    readonly nb: Notebook,
    private pageIdAt: (index: number) => string | undefined,
    private settings: () => InkSettings,
    readonly origin: unknown,
    /** 第一次偵測到觸控筆（用來自動開啟「只用觸控筆」） */
    private onPenDetected?: () => void,
    /** 正在畫的筆畫（給其他裝置即時顯示）；放開或取消時傳 null */
    private onLive?: (live: RemoteLiveStroke | null) => void,
    /** 讀取圖片檔（檔案庫） */
    private getBlob?: (fileId: string) => Promise<Uint8Array | undefined>,
    /** 選取改變：圖片代號、"lasso"（套索選取）或 null */
    private onSelect?: (selection: string | null) => void,
  ) {
    this.offChange = nb.onChange(() => {
      this.pageCache.clear();
      this.pruneSelection();
      this.redrawAll();
    });
  }

  destroy() {
    this.offChange();
    for (const url of this.imageUrls.values()) if (url) URL.revokeObjectURL(url);
    this.imageUrls.clear();
    this.imageElements.clear();
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
      if (l) this.release(l);
      l = this.createLayers(view);
    }
    this.layers.delete(index);
    this.layers.set(index, l); // 移到最後 = 最近使用
    this.sweep(index);
    const canvasWrapper = view.div.querySelector(".canvasWrapper");
    if (!l.root.isConnected) {
      if (canvasWrapper) canvasWrapper.after(l.root);
      else view.div.append(l.root);
    }
    if (!l.input.isConnected) view.div.append(l.input);
    this.resize(l);
    this.applyTool(l);
    this.redraw(index);
    this.drawRemote(index);
    this.renderLasso(index);
  }

  // ── 圖片（ImageHost） ───────────────────────────────

  selectMode() {
    return this.settings().tool === "select";
  }

  selected() {
    return this.selectedImage;
  }

  select(id: string | null) {
    if (id) this.setSelection(null);
    if (id === this.selectedImage) return;
    this.selectedImage = id;
    for (const l of this.layers.values()) l.images.render();
    this.onSelect?.(id ?? (this.selection ? "lasso" : null));
  }

  /** 取消所有選取（Esc） */
  clearSelection() {
    this.select(null);
    this.setSelection(null);
  }

  /** 刪除選取的圖片或套索選取的內容（Delete 鍵） */
  deleteSelection(): boolean {
    const sel = this.selection;
    if (sel) {
      this.setSelection(null);
      this.nb.doc.transact(() => {
        this.nb.removeStrokes(sel.pageId, sel.strokes);
        this.nb.removeImages(sel.images);
      }, this.origin);
      return true;
    }
    for (const l of this.layers.values()) if (l.images.deleteSelected()) return true;
    return false;
  }

  /** 套索選取的筆畫改顏色 */
  recolorSelection(color: string) {
    const sel = this.selection;
    if (!sel || !sel.strokes.size) return;
    this.nb.doc.transact(() => this.nb.updateStrokes(sel.pageId, sel.strokes, (s) => ({ ...s, color })), this.origin);
  }

  /** 複製目前的選取（套索選取或選取的圖片）；沒有選取時回傳 null */
  copySelection(): CopiedSelection | null {
    const sel = this.selection;
    if (sel) return { clip: this.nb.copyContent(sel.pageId, sel.strokes, sel.images), pageId: sel.pageId };
    const img = this.selectedImage ? this.nb.getImage(this.selectedImage) : undefined;
    if (img) return { clip: this.nb.copyContent(img.pageId, [], [img.id]), pageId: img.pageId };
    return null;
  }

  /** 選取框上的「複製」按鈕 */
  requestCopy() {
    const copied = this.copySelection();
    if (copied) this.onCopy?.(copied);
  }

  /** 調整選取的圖片（套索選取裡的圖片，或選取的那張）的上下順序 */
  reorderSelection(order: ImageOrder): boolean {
    const ids = this.selection ? [...this.selection.images] : this.selectedImage ? [this.selectedImage] : [];
    if (!ids.length) return false;
    this.nb.doc.transact(() => this.nb.reorderImages(ids, order), this.origin);
    return true;
  }

  /** 選取指定的筆畫與圖片（例如剛貼上的內容） */
  selectContent(index: number, pageId: string, strokes: Iterable<string>, images: Iterable<string>) {
    this.select(null);
    this.pageCache.delete(pageId);
    this.setSelection({ index, pageId, strokes: new Set(strokes), images: new Set(images) });
  }

  // ── 套索選取 ─────────────────────────────────────────

  private setSelection(sel: Selection | null) {
    const old = this.selection;
    this.selection = sel && (sel.strokes.size || sel.images.size) ? sel : null;
    if (old) this.renderLasso(old.index);
    if (this.selection) this.renderLasso(this.selection.index);
    if (old || this.selection) this.onSelect?.(this.selection ? "lasso" : this.selectedImage);
  }

  /** 筆記本改變後（例如另一台裝置刪了某筆），拿掉已經不存在的項目 */
  private pruneSelection() {
    const sel = this.selection;
    if (!sel) return;
    if (!this.nb.getPage(sel.pageId)) return this.setSelection(null);
    const strokes = new Set(this.pageStrokes(sel.pageId).map((s) => s.id));
    const images = new Set(this.nb.images(sel.pageId).map((i) => i.id));
    const next = { ...sel, strokes: new Set([...sel.strokes].filter((id) => strokes.has(id))), images: new Set([...sel.images].filter((id) => images.has(id))) };
    if (next.strokes.size !== sel.strokes.size || next.images.size !== sel.images.size) this.setSelection(next);
  }

  /** 選取範圍（PDF 座標 [x0, y0, x1, y1]），含筆畫粗細；`t` = 拖曳中的預覽變換 */
  private selectionBounds(sel: Selection, t?: ContentTransform): [number, number, number, number] | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };
    for (const { id, stroke } of this.pageStrokes(sel.pageId)) {
      if (!sel.strokes.has(id)) continue;
      const m = (stroke.size / 2) * (t?.scale ?? 1) + 2;
      if (t && t.angle % 360 !== 0) {
        // 旋轉中：用轉過之後的點算（把外框轉過去會比實際大很多）
        for (const [x, y] of stroke.points) {
          const [px, py] = transformPoint(t, x, y);
          add(px - m, py - m);
          add(px + m, py + m);
        }
        continue;
      }
      let [a, b, c, d] = this.decoded.get(id)?.bbox ?? bounds(stroke);
      if (t) {
        [a, b] = transformPoint(t, a, b);
        [c, d] = transformPoint(t, c, d);
      }
      add(Math.min(a, c) - m, Math.min(b, d) - m);
      add(Math.max(a, c) + m, Math.max(b, d) + m);
    }
    for (const info of this.nb.images(sel.pageId)) {
      if (!sel.images.has(info.id)) continue;
      const img = t ? transformImage(info, t) : info;
      add(img.x, img.y);
      add(img.x + img.width, img.y + img.height);
    }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  }

  private renderLasso(index: number) {
    const l = this.layers.get(index);
    if (!l) return;
    const sel = this.selection;
    const box = sel && sel.index === index && this.selectMode() ? this.selectionBounds(sel, this.selDrag?.t) : null;
    if (!box) {
      l.lassoBox.hidden = true;
      return;
    }
    const [ax, ay] = l.view.viewport.convertToViewportPoint(box[0], box[1]);
    const [bx, by] = l.view.viewport.convertToViewportPoint(box[2], box[3]);
    Object.assign(l.lassoBox.style, {
      left: `${Math.min(ax, bx)}px`,
      top: `${Math.min(ay, by)}px`,
      width: `${Math.abs(bx - ax)}px`,
      height: `${Math.abs(by - ay)}px`,
    });
    l.lassoBox.querySelector<HTMLElement>(".lasso-select__colors")!.hidden = !sel!.strokes.size;
    // 有圖片時「上下順序」才有意義
    for (const b of l.lassoBox.querySelectorAll<HTMLElement>("[data-order]")) b.hidden = !sel!.images.size;
    l.lassoBox.hidden = false;
    fitActions(l.lassoBox.querySelector(".lasso-select__actions")!, Math.min(ax, bx), Math.abs(bx - ax), l.view.div.clientWidth, "left");
  }

  private insideSelection(index: number, [x, y]: [number, number]): boolean {
    const sel = this.selection;
    if (!sel || sel.index !== index) return false;
    const b = this.selectionBounds(sel);
    return !!b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  }

  /** 畫完套索：選取大部分在圈內的筆畫，以及中心在圈內的圖片 */
  private finishLasso(l: PageLayers) {
    const lasso = this.lasso;
    this.lasso = null;
    this.clearLive(l);
    const pageId = lasso && this.pageIdAt(lasso.index);
    if (!lasso || !pageId || lasso.points.length < 3) return;
    const poly = lasso.points;
    const strokes = new Set<string>();
    for (const { id, stroke } of this.pageStrokes(pageId)) {
      const pts = stroke.points;
      let inside = 0;
      for (const [x, y] of pts) if (pointInPolygon(x, y, poly)) inside++;
      if (inside > 0 && inside >= pts.length / 2) strokes.add(id);
    }
    const images = new Set(
      this.nb.images(pageId).filter((i) => pointInPolygon(i.x + i.width / 2, i.y + i.height / 2, poly)).map((i) => i.id),
    );
    this.setSelection({ index: lasso.index, pageId, strokes, images });
  }

  private drawLasso(l: PageLayers) {
    const lasso = this.lasso;
    if (!lasso) return;
    const ctx = this.clearLive(l);
    this.setTransform(ctx, l);
    const scale = l.view.viewport.scale || 1;
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([6 / scale, 4 / scale]);
    ctx.strokeStyle = "#2563eb";
    ctx.fillStyle = "rgba(37, 99, 235, 0.06)";
    ctx.beginPath();
    lasso.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 拖曳套索選取時：拿起來的筆畫畫在輸入層上，跟著移動 */
  private drawLifted(l: PageLayers) {
    const sel = this.selection;
    const drag = this.selDrag;
    if (!sel || !drag) return;
    const ctx = this.clearLive(l);
    this.setTransform(ctx, l);
    ctx.transform(...transformMatrix(drag.t));
    for (const { id, stroke } of this.pageStrokes(sel.pageId)) {
      if (!sel.strokes.has(id)) continue;
      ctx.globalAlpha = stroke.tool === "highlighter" ? HIGHLIGHTER_ALPHA : 1;
      ctx.fillStyle = stroke.color;
      ctx.fill(this.pathFor(id, stroke));
    }
    ctx.globalAlpha = 1;
  }

  /** 選取工具的按下：選取框的把手 → 縮放／旋轉；選取框內 → 拖曳選取；圖片 → 選取圖片；空白處 → 開始畫套索 */
  private selectDown(l: PageLayers, e: PointerEvent): boolean {
    const index = l.view.id - 1;
    const p = this.toPdf(l, e);
    const start: [number, number] = [p[0], p[1]];
    const handle = (e.target as HTMLElement | null)?.dataset?.lasso;
    const sel = this.selection;
    const box = sel && sel.index === index ? this.selectionBounds(sel) : null;
    if (box && (handle === "scale" || handle === "rotate")) {
      const corners: [number, number][] = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
      // 把手在畫面上的右下角（頁面旋轉時對應到不同的 PDF 角）；錨點是它的對角
      const screen = corners.map(([x, y]) => l.view.viewport.convertToViewportPoint(x, y));
      const k = screen.reduce((best, [x, y], i) => (x + y > screen[best][0] + screen[best][1] ? i : best), 0);
      const center: [number, number] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const anchor = handle === "scale" ? corners[(k + 2) % 4] : center;
      this.selDrag = { pointerId: e.pointerId, mode: handle, start, anchor, handle: corners[k], t: translation(0, 0), moved: false };
    } else if (this.insideSelection(index, start)) {
      this.selDrag = { pointerId: e.pointerId, mode: "move", start, anchor: start, handle: start, t: translation(0, 0), moved: false };
    }
    if (this.selDrag) {
      for (const id of this.selection!.strokes) this.lifted.add(id);
      return true;
    }
    if (l.images.pointerDown(e)) return true;
    this.setSelection(null);
    // 「只用觸控筆」時手指在空白處是捲動，不畫套索
    if (e.pointerType === "touch" && this.settings().penOnly) return false;
    this.lasso = { index, pointerId: e.pointerId, points: [[p[0], p[1]]] };
    return true;
  }

  private selectMove(l: PageLayers, e: PointerEvent) {
    if (this.lasso && e.pointerId === this.lasso.pointerId) {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const [x, y] = this.toPdf(l, ev);
        this.lasso.points.push([x, y]);
      }
      this.drawLasso(l);
      return;
    }
    const drag = this.selDrag;
    if (drag && e.pointerId === drag.pointerId) {
      const [x, y] = this.toPdf(l, e);
      if (!drag.moved && Math.hypot(x - drag.start[0], y - drag.start[1]) < 1) return;
      drag.t = this.dragTransform(drag, x, y);
      if (!drag.moved) {
        drag.moved = true;
        this.redraw(l.view.id - 1); // 拿起來：頁面上先不畫這些筆畫
      }
      this.drawLifted(l);
      l.images.setGroupTransform(this.selection!.images, drag.t);
      this.renderLasso(l.view.id - 1);
      return;
    }
    l.images.pointerMove(e);
  }

  /** 拖曳到 (x, y) 時的變換 */
  private dragTransform(drag: SelectionDrag, x: number, y: number): ContentTransform {
    const [ax, ay] = drag.anchor;
    if (drag.mode === "move") return translation(x - drag.start[0], y - drag.start[1]);
    if (drag.mode === "scale") {
      // 等比例：把指標投影到「錨點 → 把手」的對角線上
      const vx = drag.handle[0] - ax, vy = drag.handle[1] - ay;
      const len2 = vx * vx + vy * vy || 1;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, ((x - ax) * vx + (y - ay) * vy) / len2));
      return { cx: ax, cy: ay, scale, angle: 0, dx: 0, dy: 0 };
    }
    // 旋轉：y 向上的座標裡，順時針 = 數學角度變小
    const a0 = Math.atan2(drag.start[1] - ay, drag.start[0] - ax);
    const a1 = Math.atan2(y - ay, x - ax);
    let angle = (-(a1 - a0) * 180) / Math.PI;
    angle = ((angle % 360) + 360) % 360;
    const nearest = Math.round(angle / 90) * 90;
    // 圖片只能轉 90 度的倍數；只有筆跡時自由角度，接近直角時吸附
    if (this.selection?.images.size || Math.abs(angle - nearest) < ROTATE_SNAP) angle = nearest % 360;
    return { cx: ax, cy: ay, scale: 1, angle, dx: 0, dy: 0 };
  }

  /** 回傳是否處理了這次放開 */
  private selectUp(l: PageLayers, e: PointerEvent): boolean {
    if (this.lasso && e.pointerId === this.lasso.pointerId) {
      if (e.type === "pointercancel") {
        this.lasso = null;
        this.clearLive(l);
      } else {
        this.finishLasso(l);
      }
      return true;
    }
    const drag = this.selDrag;
    const sel = this.selection;
    if (drag && e.pointerId === drag.pointerId) {
      this.selDrag = null;
      this.lifted.clear();
      this.clearLive(l);
      l.images.setGroupTransform(null);
      const t = drag.t;
      const identity = t.scale === 1 && t.angle === 0 && t.dx === 0 && t.dy === 0;
      if (sel && drag.moved && !identity && e.type !== "pointercancel") {
        this.nb.doc.transact(() => this.nb.transformContent(sel.pageId, sel.strokes, sel.images, t), this.origin);
      } else {
        this.redraw(l.view.id - 1);
      }
      this.renderLasso(l.view.id - 1);
      return true;
    }
    return false;
  }

  imageUrl(fileId: string): string | undefined {
    const cached = this.imageUrls.get(fileId);
    if (cached) return cached;
    if (cached === null || !this.getBlob) return undefined; // 讀取中
    this.imageUrls.set(fileId, null);
    void this.getBlob(fileId).then((bytes) => {
      if (!bytes) {
        // 還沒有這個檔案（例如其他裝置還在傳）：下次重畫時再試
        this.imageUrls.delete(fileId);
        return;
      }
      const mime = this.nb.getFile(fileId)?.mime ?? (bytes[0] === 0x89 ? "image/png" : "image/jpeg");
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
      this.imageUrls.set(fileId, url);
      const el = new Image();
      el.src = url;
      void el.decode().then(() => this.imageElements.set(fileId, el), () => {});
      for (const l of this.layers.values()) l.images.render();
    });
    return undefined;
  }

  /** 縮圖用：把某頁的圖片畫到 canvas 上（transform：PDF 座標 → canvas 像素）；還沒解碼的圖片略過 */
  paintImages(ctx: CanvasRenderingContext2D, transform: number[], pageId: string) {
    const list = this.nb.images(pageId);
    if (!list.length) return;
    ctx.save();
    const [a, b, c, d, e, f] = transform;
    for (const img of list) {
      const el = this.imageElements.get(img.fileId);
      if (!el) {
        this.imageUrl(img.fileId);
        continue;
      }
      // 原圖座標 → PDF（含旋轉）→ 縮圖
      const { naturalWidth, naturalHeight, matrix } = imagePlacement(img);
      ctx.setTransform(a, b, c, d, e, f);
      ctx.transform(...matrix);
      ctx.drawImage(el, 0, 0, naturalWidth, naturalHeight);
    }
    ctx.restore();
  }

  /** 其他裝置正在畫的筆畫改變了 */
  setRemoteLive(strokes: RemoteLiveStroke[]) {
    const pages = new Set([...this.remoteStrokes, ...strokes].map((r) => r.pageId));
    this.remoteStrokes = strokes;
    for (const index of this.layers.keys()) {
      const id = this.pageIdAt(index);
      if (id && pages.has(id)) this.drawRemote(index);
    }
  }

  private drawRemote(index: number) {
    const l = this.layers.get(index);
    if (!l) return;
    const ctx = l.remote.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, l.remote.width, l.remote.height);
    const pageId = this.pageIdAt(index);
    const mine = this.remoteStrokes.filter((r) => r.pageId === pageId);
    if (!mine.length) return;
    this.setTransform(ctx, l);
    for (const { stroke } of mine) {
      ctx.globalAlpha = stroke.tool === "highlighter" ? HIGHLIGHTER_ALPHA : 1;
      ctx.fillStyle = stroke.color;
      ctx.fill(outlinePath(stroke));
    }
  }

  /** 把正在畫的筆畫送給其他裝置（限制頻率，最後一次一定送出） */
  private sendLive(index: number, stroke: Stroke | null) {
    if (!this.onLive) return;
    clearTimeout(this.liveTimer);
    const pageId = this.pageIdAt(index);
    if (!stroke || !pageId) {
      this.onLive(null);
      return;
    }
    const send = () => {
      this.liveSentAt = performance.now();
      this.onLive?.({ pageId, stroke });
    };
    const wait = LIVE_INTERVAL - (performance.now() - this.liveSentAt);
    if (wait <= 0) send();
    else this.liveTimer = setTimeout(send, wait);
  }

  /**
   * 釋放不需要的手寫層：pdf.js 清掉離畫面太遠的頁面時，會一併移除我們的元素（不在 DOM 上了），
   * 這些頁面的 canvas 就可以釋放；記憶體因此跟著 pdf.js 自己的頁面緩衝。另外保留安全上限。
   */
  private sweep(keep: number) {
    for (const [i, l] of this.layers) {
      if (i === keep || this.active?.index === i) continue;
      if (!l.root.isConnected || this.layers.size > MAX_LAYERS) {
        this.release(l);
        this.layers.delete(i);
      }
    }
  }

  /** 移除頁面元素並釋放 canvas 記憶體（iOS Safari 要把尺寸設為 0 才會真正釋放） */
  private release(l: PageLayers) {
    l.root.remove();
    l.input.remove();
    for (const c of [l.highlight, l.pen, l.live, l.remote]) c.width = c.height = 0;
    l.images.overlay.remove();
  }

  /** 顯示用的 PDF 換了（插頁、刪頁等），舊的頁面元素都作廢 */
  reset() {
    this.selection = null;
    this.lasso = null;
    this.selDrag = null;
    this.lifted.clear();
    for (const l of this.layers.values()) this.release(l);
    this.layers.clear();
    this.pageCache.clear();
  }

  /** 工具改變時更新游標與輸入層 */
  refreshTool() {
    if (!this.selectMode()) this.clearSelection();
    for (const l of this.layers.values()) {
      this.applyTool(l);
      l.images.render();
    }
  }

  redrawAll() {
    for (const index of this.layers.keys()) this.redraw(index);
    if (this.selection) this.renderLasso(this.selection.index);
  }

  private createLayers(view: PageView): PageLayers {
    const root = document.createElement("div");
    root.className = "ink-layer";
    const highlight = document.createElement("canvas");
    highlight.className = "ink-layer__highlight";
    const pen = document.createElement("canvas");
    pen.className = "ink-layer__pen";
    const remote = document.createElement("canvas");
    remote.className = "ink-layer__remote";
    const index = view.id - 1;
    const images = new PageImages(this, view, () => this.pageIdAt(index));
    root.append(images.el, highlight, pen, remote);

    const input = document.createElement("div");
    input.className = "ink-input";
    const live = document.createElement("canvas");
    live.className = "ink-input__live";
    // 低延遲模式：正在畫的線不必等整個畫面合成（支援的瀏覽器才有效）
    live.getContext("2d", { desynchronized: true });
    const lassoBox = document.createElement("div");
    lassoBox.className = "lasso-select";
    lassoBox.hidden = true;
    lassoBox.innerHTML =
      '<span class="lasso-select__actions"><span class="lasso-select__colors">' +
      PEN_COLORS.map((c) => `<button type="button" class="lasso-select__color" data-color="${c}" style="background:${c}" aria-label="改成這個顏色"></button>`).join("") +
      '</span><button type="button" class="lasso-select__button" data-action="copy">複製</button>' +
      '<button type="button" class="lasso-select__button" data-order="front" aria-label="圖片移到最上層">置頂</button>' +
      '<button type="button" class="lasso-select__button" data-order="back" aria-label="圖片移到最下層">置底</button>' +
      '<button type="button" class="lasso-select__delete">刪除</button></span>' +
      '<span class="lasso-select__handle" data-lasso="scale" title="拖曳縮放"></span>' +
      '<span class="lasso-select__rotate" data-lasso="rotate" title="拖曳旋轉"></span>';
    for (const btn of lassoBox.querySelectorAll<HTMLButtonElement>("button")) {
      // 按鈕：不要讓輸入層把這次點擊當成「在選取框外按下」
      btn.addEventListener("pointerdown", (e) => e.stopPropagation());
      btn.addEventListener("click", () => {
        if (btn.dataset.color) this.recolorSelection(btn.dataset.color);
        else if (btn.dataset.action === "copy") this.requestCopy();
        else if (btn.dataset.order) this.reorderSelection(btn.dataset.order as ImageOrder);
        else this.deleteSelection();
      });
    }
    input.append(live, images.overlay, lassoBox);

    const l: PageLayers = { view, root, highlight, pen, input, live, remote, images, lassoBox, dpr: 1 };
    input.addEventListener("pointerdown", (e) => this.onDown(l, e));
    input.addEventListener("pointermove", (e) => this.onMove(l, e));
    input.addEventListener("pointerup", (e) => this.onUp(l, e));
    input.addEventListener("pointercancel", (e) => this.onUp(l, e));
    // Apple Pencil：在第一個觸控事件就取消瀏覽器的預設行為，
    // 否則 Safari 會把筆的拖曳當成「長按選取文字」或捲動頁面
    const stopStylus = (e: TouchEvent) => {
      const tool = this.settings().tool;
      if (tool === "read") return;
      const touches = Array.from(e.changedTouches);
      if (touches.some((t) => (t as Touch & { touchType?: string }).touchType === "stylus")) {
        e.preventDefault();
      } else if (tool === "select" && e.type === "touchstart" && e.touches.length === 1) {
        // 選取工具：手指按在圖片或套索選取框上 → 拖曳；按在空白處 → 照常捲動（「只用觸控筆」時）
        const t = touches[0];
        const rect = l.input.getBoundingClientRect();
        const [x, y] = l.view.viewport.convertToPdfPoint(t.clientX - rect.left, t.clientY - rect.top);
        const onHandle = (e.target as HTMLElement | null)?.dataset?.lasso !== undefined;
        if (onHandle || l.images.hits(t.clientX, t.clientY, e.target) || this.insideSelection(l.view.id - 1, [x, y])) e.preventDefault();
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
    if (width * height * dpr * dpr > MAX_INK_CANVAS_PIXELS) dpr = Math.sqrt(MAX_INK_CANVAS_PIXELS / (width * height));
    l.dpr = dpr;
    for (const c of [l.highlight, l.pen, l.live, l.remote]) {
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
    l.input.classList.toggle("ink-input--select", tool === "select");
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
    l.images.render();
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
      if (this.erasing.has(id) || this.lifted.has(id)) continue;
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
        const prev = this.decoded.get(id);
        // 同一個代號的筆畫被修改過（套索移動、改顏色）：外框與範圍要重算
        if (!prev || !sameStroke(prev.stroke, stroke)) {
          this.decoded.set(id, { stroke, bbox: bounds(stroke) });
          this.paths.delete(id);
        }
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
    this.sendLive(a.index, null);
  }

  private onDown(l: PageLayers, e: PointerEvent) {
    const s = this.settings();
    if (s.tool === "read") return;
    if (s.penOnly && e.pointerType === "touch" && s.tool !== "select") return;
    if (this.active) {
      // 第二根手指放下：這是縮放手勢，不是書寫
      if (e.pointerType === "touch" && this.active.pointerType === "touch") this.cancelTouchStroke();
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (s.tool === "select") {
      // 選取工具：套索圈選、拖曳選取；點圖片選取、拖曳移動，拉角縮放
      if (this.selectDown(l, e)) {
        e.preventDefault();
        l.input.setPointerCapture(e.pointerId);
      }
      return;
    }
    e.preventDefault();
    l.input.setPointerCapture(e.pointerId);
    if (e.pointerType === "pen" && !this.penSeen) {
      this.penSeen = true;
      this.onPenDetected?.();
    }
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
    if (s.tool === "select") return this.selectMove(l, e);
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
    // 預測點：觸控筆移動時先把線畫到「接下來會到的位置」，看起來更跟手
    const predicted = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents() : [];
    this.active.predicted = predicted.map((ev) => this.toPdf(l, ev));
    this.scheduleLive(l);
  }

  private onUp(l: PageLayers, e: PointerEvent) {
    if (this.selectUp(l, e)) return;
    if (l.images.dragging) return l.images.pointerUp(e, e.type === "pointercancel");
    const active = this.active;
    if (!active || e.pointerId !== active.pointerId) return;
    this.active = null;
    if (active.frame) cancelAnimationFrame(active.frame);
    const pageId = this.pageIdAt(active.index);
    // 先寫進筆記本（同步給對方），再清掉對方畫面上的「正在畫」，才不會閃一下
    const hadLive = !!active.stroke;
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
    if (hadLive) this.sendLive(active.index, null);
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
      const predicted = this.active.predicted ?? [];
      ctx.fill(outlinePath(predicted.length ? { ...stroke, points: [...stroke.points, ...predicted] } : stroke));
      this.sendLive(this.active.index, stroke);
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

/** 點是否在多邊形內（射線法） */
function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 是否是同一筆的同一個版本（修改過的筆畫：顏色、粗細或位置一定不同） */
function sameStroke(a: Stroke, b: Stroke): boolean {
  if (a.color !== b.color || a.size !== b.size || a.tool !== b.tool || a.points.length !== b.points.length) return false;
  // 頭、中間、尾三個點（旋轉、縮放後至少有一個會不同）
  return [0, a.points.length >> 1, a.points.length - 1].every((i) => a.points[i][0] === b.points[i][0] && a.points[i][1] === b.points[i][1]);
}
