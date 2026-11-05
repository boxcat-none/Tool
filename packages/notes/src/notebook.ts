import { decodeStroke, encodeStroke, normalizeStroke, type Stroke } from "@tool/core/ink/core";
import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import type { FileInfo, ImageInfo, ImagePatch, NewImage, NewPage, PageInfo, PageSource } from "./types";

/**
 * 筆記本資料模型（Yjs 文件）。多台裝置各自修改後可以自動合併，不會互相覆蓋。
 *
 *   meta     Y.Map     { schema, id, title, createdAt }
 *   pages    Y.Map     pageId → Y.Map { order, source, width, height, rotation }
 *   strokes  Y.Map     pageId → Y.Array<Uint8Array>（每筆 = 8 bytes 代號 + 單筆二進位編碼；陣列順序 = 疊放順序）
 *   files    Y.Map     fileId → FileInfo（檔案本身在 BlobStore）
 *   images   Y.Map     imageId → Y.Map { page, file, x, y, w, h, r, z }（r = 旋轉；z = 疊放順序，fractional indexing）
 *
 * 頁面順序用 fractional indexing（order 字串排序）：
 * 兩台裝置同時移動同一頁時，只有最後的位置生效，不會像清單「刪除再插入」那樣出現兩份。
 */

export const SCHEMA_VERSION = 1;

export interface StrokeEntry {
  id: string;
  stroke: Stroke;
}

/** 每筆存成一個 Uint8Array：前 8 bytes 是筆畫代號，後面是筆跡編碼（比 {id, data} 物件省空間） */
type StoredStroke = Uint8Array;
const ID_BYTES = 8;

function packStroke(id: string, stroke: Stroke): StoredStroke {
  const body = encodeStroke(stroke);
  const out = new Uint8Array(ID_BYTES + body.length);
  for (let i = 0; i < ID_BYTES; i++) out[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  out.set(body, ID_BYTES);
  return out;
}

function strokeId(stored: StoredStroke): string {
  let id = "";
  for (let i = 0; i < ID_BYTES; i++) id += stored[i].toString(16).padStart(2, "0");
  return id;
}

export class Notebook {
  readonly doc: Y.Doc;
  private readonly meta: Y.Map<unknown>;
  private readonly pages: Y.Map<Y.Map<unknown>>;
  private readonly strokesMap: Y.Map<Y.Array<StoredStroke>>;
  private readonly files: Y.Map<FileInfo>;
  private readonly imagesMap: Y.Map<Y.Map<unknown>>;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.meta = doc.getMap("meta");
    this.pages = doc.getMap("pages");
    this.strokesMap = doc.getMap("strokes");
    this.files = doc.getMap("files");
    this.imagesMap = doc.getMap("images");
  }

  static create(title: string): Notebook {
    const nb = new Notebook();
    nb.doc.transact(() => {
      nb.meta.set("schema", SCHEMA_VERSION);
      nb.meta.set("id", newId());
      nb.meta.set("title", title);
      nb.meta.set("createdAt", Date.now());
    });
    return nb;
  }

  /** 筆記本代號（建立時產生，之後不變；同一本筆記本在不同裝置上代號相同） */
  get id(): string {
    return (this.meta.get("id") as string) ?? "";
  }

  get title(): string {
    return (this.meta.get("title") as string) ?? "";
  }

  set title(value: string) {
    this.meta.set("title", value);
  }

  // ── 頁面 ───────────────────────────────────────────

  /** 依順序排列的頁面代號 */
  get pageIds(): string[] {
    return [...this.pages.entries()]
      .map(([id, m]) => ({ id, order: m.get("order") as string }))
      // order 相同（兩台裝置同時插在同一個位置）時用 id 決定順序，所有裝置結果一致
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))
      .map((p) => p.id);
  }

  getPage(id: string): PageInfo | undefined {
    const m = this.pages.get(id);
    if (!m) return undefined;
    return {
      id,
      source: m.get("source") as PageSource,
      width: m.get("width") as number,
      height: m.get("height") as number,
      rotation: (m.get("rotation") as PageInfo["rotation"]) ?? 0,
    };
  }

  get pageList(): PageInfo[] {
    return this.pageIds.map((id) => this.getPage(id)!);
  }

  /** 在第 `index` 個位置（0 起算）插入頁面，回傳新頁面的代號 */
  insertPages(index: number, pages: NewPage[]): string[] {
    const ids = this.pageIds;
    const clamped = Math.max(0, Math.min(index, ids.length));
    let before = clamped > 0 ? this.order(ids[clamped - 1]) : null;
    const after = clamped < ids.length ? this.order(ids[clamped]) : null;
    const created: string[] = [];
    this.doc.transact(() => {
      for (const p of pages) {
        const id = newId();
        const order = generateKeyBetween(before, after);
        const m = new Y.Map<unknown>();
        m.set("order", order);
        m.set("source", p.source);
        m.set("width", p.width);
        m.set("height", p.height);
        m.set("rotation", p.rotation ?? 0);
        this.pages.set(id, m);
        this.strokesMap.set(id, new Y.Array<StoredStroke>());
        before = order;
        created.push(id);
      }
    });
    return created;
  }

  /** 把頁面移到第 `index` 個位置（以移動後的順序計算） */
  movePage(id: string, index: number): void {
    const others = this.pageIds.filter((p) => p !== id);
    const clamped = Math.max(0, Math.min(index, others.length));
    const before = clamped > 0 ? this.order(others[clamped - 1]) : null;
    const after = clamped < others.length ? this.order(others[clamped]) : null;
    this.pages.get(id)?.set("order", generateKeyBetween(before, after));
  }

  deletePages(ids: string[]): void {
    this.doc.transact(() => {
      const remove = new Set(ids);
      for (const id of ids) {
        this.pages.delete(id);
        this.strokesMap.delete(id);
      }
      for (const [imageId, m] of this.imagesMap) if (remove.has(m.get("page") as string)) this.imagesMap.delete(imageId);
    });
  }

  setRotation(id: string, rotation: PageInfo["rotation"]): void {
    this.pages.get(id)?.set("rotation", rotation);
  }

  private order(id: string): string {
    return this.pages.get(id)!.get("order") as string;
  }

  // ── 筆跡 ───────────────────────────────────────────

  strokes(pageId: string): StrokeEntry[] {
    const arr = this.strokesMap.get(pageId);
    if (!arr) return [];
    return arr.toArray().map((stored) => ({ id: strokeId(stored), stroke: decodeStroke(stored.subarray(ID_BYTES)) }));
  }

  strokeCount(pageId: string): number {
    return this.strokesMap.get(pageId)?.length ?? 0;
  }

  /** 新增一筆（會先做點精簡與四捨五入，見 normalizeStroke），回傳筆畫代號 */
  addStroke(pageId: string, stroke: Stroke): string {
    const arr = this.strokeArray(pageId);
    const id = newStrokeId();
    arr.push([packStroke(id, normalizeStroke(stroke))]);
    return id;
  }

  removeStrokes(pageId: string, ids: Iterable<string>): void {
    const arr = this.strokesMap.get(pageId);
    if (!arr) return;
    const remove = new Set(ids);
    this.doc.transact(() => {
      // 從後往前刪，索引才不會位移
      for (let i = arr.length - 1; i >= 0; i--) if (remove.has(strokeId(arr.get(i)))) arr.delete(i, 1);
    });
  }

  /** 取代筆畫（套索移動、改顏色），保留原本的疊放位置 */
  replaceStroke(pageId: string, id: string, stroke: Stroke): void {
    const arr = this.strokesMap.get(pageId);
    if (!arr) return;
    const i = arr.toArray().findIndex((s) => strokeId(s) === id);
    if (i < 0) return;
    this.doc.transact(() => {
      arr.delete(i, 1);
      arr.insert(i, [packStroke(id, normalizeStroke(stroke))]);
    });
  }

  /**
   * 一次修改多筆（套索移動、改顏色）：每筆原位置取代，保留疊放順序。
   * `fn` 回傳新的筆畫；整批是一個 transaction（一次復原、同步一次）。
   */
  updateStrokes(pageId: string, ids: Iterable<string>, fn: (stroke: Stroke) => Stroke): void {
    const arr = this.strokesMap.get(pageId);
    if (!arr) return;
    const wanted = new Set(ids);
    this.doc.transact(() => {
      const items = arr.toArray();
      for (let i = 0; i < items.length; i++) {
        const id = strokeId(items[i]);
        if (!wanted.has(id)) continue;
        const next = packStroke(id, normalizeStroke(fn(decodeStroke(items[i].subarray(ID_BYTES)))));
        arr.delete(i, 1);
        arr.insert(i, [next]);
      }
    });
  }

  private strokeArray(pageId: string): Y.Array<StoredStroke> {
    if (!this.pages.has(pageId)) throw new Error(`頁面不存在：${pageId}`);
    let arr = this.strokesMap.get(pageId);
    if (!arr) {
      arr = new Y.Array<StoredStroke>();
      this.strokesMap.set(pageId, arr);
    }
    return arr;
  }

  // ── 圖片 ───────────────────────────────────────────

  /** 某頁的圖片（依疊放順序，先畫的在下面） */
  images(pageId: string): ImageInfo[] {
    const list: (ImageInfo & { z: string })[] = [];
    for (const [id, m] of this.imagesMap) {
      if (m.get("page") !== pageId) continue;
      list.push({ ...readImage(id, m), z: (m.get("z") as string) ?? "" });
    }
    return list
      .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1))
      .map(({ z: _z, ...img }) => img);
  }

  getImage(id: string): ImageInfo | undefined {
    const m = this.imagesMap.get(id);
    return m ? readImage(id, m) : undefined;
  }

  /** 加一張圖片到頁面最上層，回傳圖片代號 */
  addImage(pageId: string, image: NewImage): string {
    if (!this.pages.has(pageId)) throw new Error(`頁面不存在：${pageId}`);
    const top = [...this.imagesMap.values()]
      .filter((m) => m.get("page") === pageId)
      .map((m) => (m.get("z") as string) ?? "")
      .sort()
      .pop();
    const id = newId();
    const m = new Y.Map<unknown>();
    m.set("page", pageId);
    m.set("file", image.fileId);
    m.set("x", round2(image.x));
    m.set("y", round2(image.y));
    m.set("w", round2(image.width));
    m.set("h", round2(image.height));
    if (image.rotation) m.set("r", image.rotation);
    m.set("z", generateKeyBetween(top || null, null));
    this.imagesMap.set(id, m);
    return id;
  }

  /** 移動或縮放（兩台裝置同時改同一張時，每個欄位以最後一次為準） */
  updateImage(id: string, patch: ImagePatch): void {
    const m = this.imagesMap.get(id);
    if (!m) return;
    this.doc.transact(() => {
      if (patch.x !== undefined) m.set("x", round2(patch.x));
      if (patch.y !== undefined) m.set("y", round2(patch.y));
      if (patch.width !== undefined) m.set("w", round2(patch.width));
      if (patch.height !== undefined) m.set("h", round2(patch.height));
      if (patch.rotation !== undefined) m.set("r", patch.rotation);
    });
  }

  removeImages(ids: Iterable<string>): void {
    this.doc.transact(() => {
      for (const id of ids) this.imagesMap.delete(id);
    });
  }

  // ── 檔案 ───────────────────────────────────────────

  addFile(info: FileInfo): void {
    if (!this.files.has(info.id)) this.files.set(info.id, info);
  }

  getFile(id: string): FileInfo | undefined {
    return this.files.get(id);
  }

  /** 頁面實際引用到的檔案（刪掉的頁面引用的檔案不算） */
  get usedFileIds(): string[] {
    const ids = new Set<string>();
    for (const page of this.pageList) if (page.source.kind === "pdf") ids.add(page.source.fileId);
    for (const m of this.imagesMap.values()) if (this.pages.has(m.get("page") as string)) ids.add(m.get("file") as string);
    return [...ids];
  }

  // ── 變動通知、復原 ──────────────────────────────────

  /** 任何變動（包含其他裝置同步過來的）都會呼叫 callback；回傳取消訂閱的函式 */
  onChange(callback: (event: { local: boolean }) => void): () => void {
    const handler = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) =>
      callback({ local: tr.local });
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  /** 頁面結構（新增、刪除、順序、大小、旋轉）改變時通知 */
  onPagesChange(callback: () => void): () => void {
    const handler = () => callback();
    this.pages.observeDeep(handler);
    return () => this.pages.unobserveDeep(handler);
  }

  /** 圖片新增、移動、縮放、刪除時通知，並告訴是哪些頁面 */
  onImagesChange(callback: (pageIds: Set<string>) => void): () => void {
    // 刪除後的 Y.Map 內容已經清掉，所以自己記住每張圖在哪一頁
    const pageOf = new Map<string, string>();
    for (const [id, m] of this.imagesMap) pageOf.set(id, m.get("page") as string);
    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const ids = new Set<string>();
      for (const e of events) {
        if (e.target === this.imagesMap) {
          for (const key of (e as Y.YMapEvent<Y.Map<unknown>>).keysChanged) {
            const now = this.imagesMap.get(key);
            const before = pageOf.get(key);
            if (before) ids.add(before);
            if (now) {
              const page = now.get("page") as string;
              ids.add(page);
              pageOf.set(key, page);
            } else {
              pageOf.delete(key);
            }
          }
        } else {
          const page = (e.target as Y.Map<unknown>).get("page");
          if (typeof page === "string") ids.add(page);
        }
      }
      if (ids.size) callback(ids);
    };
    this.imagesMap.observeDeep(handler);
    return () => this.imagesMap.unobserveDeep(handler);
  }

  /** 筆跡改變時通知，並告訴是哪些頁面 */
  onStrokesChange(callback: (pageIds: Set<string>) => void): () => void {
    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const ids = new Set<string>();
      for (const e of events) {
        if (e.target === this.strokesMap) {
          for (const key of (e as Y.YMapEvent<unknown>).keysChanged) ids.add(key);
        } else if (typeof e.path[0] === "string") {
          ids.add(e.path[0]);
        }
      }
      if (ids.size) callback(ids);
    };
    this.strokesMap.observeDeep(handler);
    return () => this.strokesMap.unobserveDeep(handler);
  }

  /**
   * 建立復原管理器：只追蹤 `origin` 所做的修改，
   * 所以在電腦按「復原」不會把 iPad 剛畫的線復原掉。
   * 本機修改請包在 `nb.doc.transact(fn, origin)` 裡。
   */
  createUndoManager(origin: unknown): Y.UndoManager {
    return new Y.UndoManager([this.pages, this.strokesMap, this.imagesMap], {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0, // 每個動作（一筆、一次插頁）各自可以復原
    });
  }
}

/** 筆畫代號：8 個隨機 bytes（16 個十六進位字元） */
function newStrokeId(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readImage(id: string, m: Y.Map<unknown>): ImageInfo {
  return {
    id,
    pageId: m.get("page") as string,
    fileId: m.get("file") as string,
    x: m.get("x") as number,
    y: m.get("y") as number,
    width: m.get("w") as number,
    height: m.get("h") as number,
    rotation: ((m.get("r") as number) ?? 0) as ImageInfo["rotation"],
  };
}

/**
 * 圖片怎麼畫到頁面上：原圖（寬 naturalWidth × 高 naturalHeight，座標向右、向下）→ PDF 座標的轉換矩陣
 * [a, b, c, d, e, f]（x' = a·u + c·v + e，y' = b·u + d·v + f）。閱讀器、縮圖、匯出都用這個，結果一致。
 */
export function imagePlacement(img: Pick<ImageInfo, "x" | "y" | "width" | "height" | "rotation">) {
  const { x, y, width: w, height: h } = img;
  const turned = img.rotation === 90 || img.rotation === 270;
  const naturalWidth = turned ? h : w;
  const naturalHeight = turned ? w : h;
  let matrix: [number, number, number, number, number, number];
  switch (img.rotation) {
    case 90:
      matrix = [0, -1, -1, 0, x + w, y + h];
      break;
    case 180:
      matrix = [-1, 0, 0, 1, x + w, y];
      break;
    case 270:
      matrix = [0, 1, 1, 0, x, y];
      break;
    default:
      matrix = [1, 0, 0, -1, x, y + h];
  }
  return { naturalWidth, naturalHeight, matrix };
}

/** 兩個轉換矩陣相乘：先套用 inner，再套用 outer */
export function multiplyMatrix(outer: number[], inner: number[]): [number, number, number, number, number, number] {
  const [A, B, C, D, E, F] = outer;
  const [a, b, c, d, e, f] = inner;
  return [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
}

/** 位置、大小取到 0.01 pt（同步資料小一點，各裝置結果一致） */
const round2 = (v: number) => Math.round(v * 100) / 100;

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

export type { FileInfo, ImageInfo, ImagePatch, NewImage, NewPage, PageInfo, PageSource, PaperTemplate } from "./types";
