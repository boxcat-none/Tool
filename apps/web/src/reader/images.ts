import type { ImageInfo, ImagePatch, Notebook } from "@tool/notes/notebook";

/**
 * 頁面上的圖片（每頁一個 PageImages）。
 *
 * 圖片用 <img> 疊在 PDF 頁面上、筆跡下面，不畫進顯示用的 PDF：移動、縮放時不必重新產生 PDF，拖曳才會跟手。
 * 位置用 pdf.js viewport 的轉換矩陣換算（和筆跡一樣），所以縮放、旋轉頁面都會對齊。
 *
 * 「選取」工具時圖片可以點選：拖曳移動、拉四個角等比例縮放、按「刪除」或 Delete 鍵刪除。
 * 拖曳中只改畫面，放開時才寫進筆記本（一次拖曳 = 一個復原步驟、同步一次）。
 *
 * 點選由最上層的輸入層（InkController）收到後轉給這裡（pointerDown/Move/Up）：
 * 圖片本身在筆跡下面，不能直接接收點擊，否則會蓋住筆跡或被文字層擋住。
 */

interface PageView {
  div: HTMLDivElement;
  viewport: {
    transform: number[];
    convertToPdfPoint(x: number, y: number): number[];
    convertToViewportPoint(x: number, y: number): number[];
  };
}

export interface ImageHost {
  readonly nb: Notebook;
  readonly origin: unknown;
  /** 圖片檔的網址；還沒載入時回傳 undefined（載入後會重畫） */
  imageUrl(fileId: string): string | undefined;
  selectMode(): boolean;
  selected(): string | null;
  select(id: string | null): void;
}

const MIN_SIZE = 12; // pt
type Corner = 0 | 1 | 2 | 3; // 左上、右上、右下、左下（以 PDF 座標的圖片框而言）

export class PageImages {
  /** 圖片（插在 PDF 畫布之後、筆跡之前） */
  readonly el = document.createElement("div");
  /** 選取框（在最上層，才按得到四個角和刪除鈕） */
  readonly overlay = document.createElement("div");
  private imgs = new Map<string, HTMLImageElement>();
  /** 拖曳中的暫時位置 */
  private preview: { id: string; rect: Rect } | null = null;
  private drag: {
    id: string;
    pointerId: number;
    mode: "move" | Corner;
    start: [number, number];
    rect: Rect;
    moved: boolean;
  } | null = null;

  constructor(
    private host: ImageHost,
    private view: PageView,
    private pageId: () => string | undefined,
  ) {
    this.el.className = "note-images";
    this.overlay.className = "image-select";
    this.overlay.hidden = true;
    this.overlay.innerHTML =
      '<span class="image-select__handle" data-corner="0"></span><span class="image-select__handle" data-corner="1"></span>' +
      '<span class="image-select__handle" data-corner="2"></span><span class="image-select__handle" data-corner="3"></span>' +
      '<button type="button" class="image-select__delete">刪除</button>';
    const del = this.overlay.querySelector("button")!;
    // 刪除鈕：不要讓輸入層把這次點擊當成「點到空白處、取消選取」
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", () => this.deleteSelected());
  }

  setView(view: PageView) {
    this.view = view;
  }

  /** 依筆記本內容更新圖片與選取框 */
  render() {
    const pageId = this.pageId();
    const list = pageId ? this.host.nb.images(pageId) : [];
    const keep = new Set(list.map((i) => i.id));
    for (const [id, img] of this.imgs) {
      if (!keep.has(id)) {
        img.remove();
        this.imgs.delete(id);
      }
    }
    list.forEach((info, z) => {
      let img = this.imgs.get(info.id);
      if (!img) {
        img = document.createElement("img");
        img.className = "note-image";
        img.alt = "";
        img.draggable = false;
        img.dataset.id = info.id;
        this.imgs.set(info.id, img);
      }
      const url = this.host.imageUrl(info.fileId);
      if (url && img.src !== url) img.src = url;
      img.style.zIndex = String(z);
      if (img.parentElement !== this.el || this.el.children[z] !== img) this.el.insertBefore(img, this.el.children[z] ?? null);
      this.place(img, this.preview?.id === info.id ? this.preview.rect : rectOf(info));
    });
    this.renderSelection();
  }

  private renderSelection() {
    const id = this.host.selected();
    const info = id ? this.host.nb.getImage(id) : undefined;
    if (!info || info.pageId !== this.pageId() || !this.host.selectMode()) {
      this.overlay.hidden = true;
      return;
    }
    const r = this.preview?.id === id ? this.preview.rect : rectOf(info);
    const [x0, y0] = this.view.viewport.convertToViewportPoint(r.x, r.y);
    const [x1, y1] = this.view.viewport.convertToViewportPoint(r.x + r.width, r.y + r.height);
    Object.assign(this.overlay.style, {
      left: `${Math.min(x0, x1)}px`,
      top: `${Math.min(y0, y1)}px`,
      width: `${Math.abs(x1 - x0)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
    // 四個角：依 PDF 座標的角換算到畫面（頁面旋轉時角的位置跟著轉）
    const corners = cornerPoints(r).map(([x, y]) => this.view.viewport.convertToViewportPoint(x, y));
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    this.overlay.querySelectorAll<HTMLElement>(".image-select__handle").forEach((h, i) => {
      h.style.left = `${corners[i][0] - left}px`;
      h.style.top = `${corners[i][1] - top}px`;
    });
    this.overlay.hidden = false;
  }

  /** <img> 的元素座標 (u 向右, v 向下) → PDF → 畫面：CSS matrix = viewport.transform × [1 0 0 -1 x y+h] */
  private place(img: HTMLImageElement, r: Rect) {
    const [a, b, c, d, e, f] = this.view.viewport.transform;
    const tx = a * r.x + c * (r.y + r.height) + e;
    const ty = b * r.x + d * (r.y + r.height) + f;
    img.style.width = `${r.width}px`;
    img.style.height = `${r.height}px`;
    img.style.transform = `matrix(${a}, ${b}, ${-c}, ${-d}, ${tx}, ${ty})`;
  }

  deleteSelected(): boolean {
    const id = this.host.selected();
    const info = id ? this.host.nb.getImage(id) : undefined;
    if (!id || !info || info.pageId !== this.pageId()) return false;
    this.host.select(null);
    this.host.nb.doc.transact(() => this.host.nb.removeImages([id]), this.host.origin);
    return true;
  }

  // ── 拖曳 ────────────────────────────────────────────

  private toPdf(e: PointerEvent): [number, number] {
    const rect = this.view.div.getBoundingClientRect();
    const [x, y] = this.view.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
    return [x, y];
  }

  /**
   * 選取工具按下：點到選取框的角 → 縮放；點到圖片 → 選取並開始移動（上面的圖優先）；點到空白處 → 取消選取。
   * 回傳是否開始拖曳（呼叫端要 setPointerCapture）。
   */
  pointerDown(e: PointerEvent): boolean {
    const corner = (e.target as HTMLElement).dataset?.corner;
    const selected = this.host.selected();
    if (corner !== undefined && selected) return this.startDrag(e, selected, Number(corner) as Corner);
    const [x, y] = this.toPdf(e);
    const pageId = this.pageId();
    const hit = pageId
      ? this.host.nb
          .images(pageId)
          .reverse()
          .find((i) => x >= i.x && x <= i.x + i.width && y >= i.y && y <= i.y + i.height)
      : undefined;
    this.host.select(hit?.id ?? null);
    return hit ? this.startDrag(e, hit.id, "move") : false;
  }

  /** 這個螢幕位置是否按在圖片或選取框的角上（觸控時用來決定要拖曳圖片還是捲動頁面） */
  hits(clientX: number, clientY: number, target: EventTarget | null): boolean {
    if ((target as HTMLElement | null)?.dataset?.corner !== undefined && this.host.selected()) return true;
    const pageId = this.pageId();
    if (!pageId) return false;
    const rect = this.view.div.getBoundingClientRect();
    const [x, y] = this.view.viewport.convertToPdfPoint(clientX - rect.left, clientY - rect.top);
    return this.host.nb.images(pageId).some((i) => x >= i.x && x <= i.x + i.width && y >= i.y && y <= i.y + i.height);
  }

  private startDrag(e: PointerEvent, id: string, mode: "move" | Corner): boolean {
    const info = this.host.nb.getImage(id);
    if (!info) return false;
    this.drag = { id, pointerId: e.pointerId, mode, start: this.toPdf(e), rect: rectOf(info), moved: false };
    return true;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  pointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const [px, py] = this.toPdf(e);
    const dx = px - d.start[0];
    const dy = py - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) < 1) return;
    d.moved = true;
    let rect: Rect;
    if (d.mode === "move") {
      rect = { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy };
    } else {
      // 等比例縮放：對角固定不動
      const anchor = cornerPoints(d.rect)[(d.mode + 2) % 4];
      const scale = Math.max(Math.abs(px - anchor[0]) / d.rect.width, Math.abs(py - anchor[1]) / d.rect.height);
      const w = Math.max(MIN_SIZE, d.rect.width * scale);
      const h = (w / d.rect.width) * d.rect.height;
      const right = d.mode === 1 || d.mode === 2;
      const topEdge = d.mode === 0 || d.mode === 1;
      rect = { x: right ? anchor[0] : anchor[0] - w, y: topEdge ? anchor[1] : anchor[1] - h, width: w, height: h };
    }
    this.preview = { id: d.id, rect };
    const img = this.imgs.get(d.id);
    if (img) this.place(img, rect);
    this.renderSelection();
  }

  pointerUp(e: PointerEvent, cancel = false) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    const preview = this.preview;
    this.preview = null;
    if (!cancel && d.moved && preview) {
      const patch: ImagePatch = { x: preview.rect.x, y: preview.rect.y, width: preview.rect.width, height: preview.rect.height };
      this.host.nb.doc.transact(() => this.host.nb.updateImage(d.id, patch), this.host.origin);
    }
    this.render();
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectOf = (i: ImageInfo): Rect => ({ x: i.x, y: i.y, width: i.width, height: i.height });

/** 圖片框的四個角（PDF 座標）：左上、右上、右下、左下 */
function cornerPoints(r: Rect): [number, number][] {
  return [
    [r.x, r.y + r.height],
    [r.x + r.width, r.y + r.height],
    [r.x + r.width, r.y],
    [r.x, r.y],
  ];
}
