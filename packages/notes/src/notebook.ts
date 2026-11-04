import { decodeStroke, encodeStroke, normalizeStroke, type Stroke } from "@tool/core/ink";
import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import type { FileInfo, NewPage, PageInfo, PageSource } from "./types";

/**
 * 筆記本資料模型（Yjs 文件）。多台裝置各自修改後可以自動合併，不會互相覆蓋。
 *
 *   meta     Y.Map     { schema, title, createdAt }
 *   pages    Y.Map     pageId → Y.Map { order, source, width, height, rotation }
 *   strokes  Y.Map     pageId → Y.Array<Uint8Array>（每筆 = 8 bytes 代號 + 單筆二進位編碼；陣列順序 = 疊放順序）
 *   files    Y.Map     fileId → FileInfo（檔案本身在 BlobStore）
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

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.meta = doc.getMap("meta");
    this.pages = doc.getMap("pages");
    this.strokesMap = doc.getMap("strokes");
    this.files = doc.getMap("files");
  }

  static create(title: string): Notebook {
    const nb = new Notebook();
    nb.doc.transact(() => {
      nb.meta.set("schema", SCHEMA_VERSION);
      nb.meta.set("title", title);
      nb.meta.set("createdAt", Date.now());
    });
    return nb;
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
      for (const id of ids) {
        this.pages.delete(id);
        this.strokesMap.delete(id);
      }
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

  private strokeArray(pageId: string): Y.Array<StoredStroke> {
    if (!this.pages.has(pageId)) throw new Error(`頁面不存在：${pageId}`);
    let arr = this.strokesMap.get(pageId);
    if (!arr) {
      arr = new Y.Array<StoredStroke>();
      this.strokesMap.set(pageId, arr);
    }
    return arr;
  }

  // ── 檔案 ───────────────────────────────────────────

  addFile(info: FileInfo): void {
    if (!this.files.has(info.id)) this.files.set(info.id, info);
  }

  getFile(id: string): FileInfo | undefined {
    return this.files.get(id);
  }

  // ── 變動通知、復原 ──────────────────────────────────

  /** 任何變動（包含其他裝置同步過來的）都會呼叫 callback；回傳取消訂閱的函式 */
  onChange(callback: (event: { local: boolean }) => void): () => void {
    const handler = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) =>
      callback({ local: tr.local });
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  /**
   * 建立復原管理器：只追蹤 `origin` 所做的修改，
   * 所以在電腦按「復原」不會把 iPad 剛畫的線復原掉。
   * 本機修改請包在 `nb.doc.transact(fn, origin)` 裡。
   */
  createUndoManager(origin: unknown): Y.UndoManager {
    return new Y.UndoManager([this.pages, this.strokesMap], {
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

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}
