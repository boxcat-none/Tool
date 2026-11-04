import { MemoryBlobStore, sha256Hex, type BlobStore } from "@tool/notes/blobs";
import { Notebook } from "@tool/notes/notebook";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

/**
 * 書櫃：所有筆記本都自動存在瀏覽器的 IndexedDB（軟體版的 WebView 也一樣，存在程式資料夾）。
 *
 * - 筆記本內容（Yjs 文件）：y-indexeddb，每個修改立即寫入，累積 500 筆後自動合併
 * - 書櫃清單、原始 PDF 與圖片：資料庫 guganote-library
 *     notebooks  筆記本資訊（標題、頁數、更新時間、來源 PDF 的雜湊）
 *     blobs      原始檔（以 SHA-256 為鍵，同一個檔案只存一份）
 *
 * 瀏覽器不允許 IndexedDB（例如部分私密瀏覽模式）時，改用記憶體，並以 persistent = false 告知畫面。
 */

export interface NotebookMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pageCount: number;
  /** 由 PDF 建立時，原始 PDF 的 SHA-256；同一份 PDF 再開啟時用來找回筆記本 */
  sourceHash?: string;
  /** 用到的原始檔（刪除筆記本時判斷哪些檔案可以一起刪） */
  fileIds: string[];
}

export interface OpenedNotebook {
  notebook: Notebook;
  close(): void;
}

export interface Library {
  /** false = 只存在記憶體，關閉分頁就會消失 */
  readonly persistent: boolean;
  readonly blobs: BlobStore;
  list(): Promise<NotebookMeta[]>;
  get(id: string): Promise<NotebookMeta | undefined>;
  findBySource(hash: string): Promise<NotebookMeta | undefined>;
  save(meta: NotebookMeta): Promise<void>;
  remove(id: string): Promise<void>;
  /** 開啟已存在的筆記本（內容從 IndexedDB 讀回，之後的修改自動儲存） */
  open(id: string): Promise<OpenedNotebook>;
  /** 把一本新的（或從 .guganote 讀入的）筆記本加入書櫃，回傳開啟中的筆記本 */
  add(notebook: Notebook, meta: Omit<NotebookMeta, "id" | "updatedAt" | "createdAt"> & { createdAt?: number }): Promise<OpenedNotebook>;
}

const DB_NAME = "guganote-library";
const DB_VERSION = 1;
const docDbName = (id: string) => `guganote-doc-${id}`;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const notebooks = db.createObjectStore("notebooks", { keyPath: "id" });
      notebooks.createIndex("sourceHash", "sourceHash", { unique: false });
      db.createObjectStore("blobs");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("blocked"));
  });
}

class IdbBlobStore implements BlobStore {
  constructor(private db: IDBDatabase) {}
  async put(bytes: Uint8Array) {
    const id = await sha256Hex(bytes);
    if (!(await this.has(id))) {
      await request(this.db.transaction("blobs", "readwrite").objectStore("blobs").put(bytes, id));
    }
    return id;
  }
  async get(id: string) {
    const v = await request(this.db.transaction("blobs").objectStore("blobs").get(id));
    return v instanceof Uint8Array ? v : v ? new Uint8Array(v as ArrayBuffer) : undefined;
  }
  async has(id: string) {
    return (await request(this.db.transaction("blobs").objectStore("blobs").count(id))) > 0;
  }
  async removeExcept(keep: Set<string>) {
    const store = this.db.transaction("blobs", "readwrite").objectStore("blobs");
    const keys = (await request(store.getAllKeys())) as string[];
    for (const k of keys) if (!keep.has(k)) store.delete(k);
  }
}

class IdbLibrary implements Library {
  readonly persistent = true;
  readonly blobs: IdbBlobStore;
  constructor(private db: IDBDatabase) {
    this.blobs = new IdbBlobStore(db);
  }

  private store(mode: IDBTransactionMode = "readonly") {
    return this.db.transaction("notebooks", mode).objectStore("notebooks");
  }

  async list() {
    const all = (await request(this.store().getAll())) as NotebookMeta[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string) {
    return (await request(this.store().get(id))) as NotebookMeta | undefined;
  }
  async findBySource(hash: string) {
    const all = (await request(this.store().index("sourceHash").getAll(hash))) as NotebookMeta[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  async save(meta: NotebookMeta) {
    await request(this.store("readwrite").put(meta));
  }
  async remove(id: string) {
    await request(this.store("readwrite").delete(id));
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(docDbName(id));
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
    // 刪掉不再被任何筆記本使用的原始檔
    const keep = new Set((await this.list()).flatMap((m) => m.fileIds));
    await this.blobs.removeExcept(keep);
  }

  async open(id: string): Promise<OpenedNotebook> {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(docDbName(id), doc);
    await persistence.whenSynced;
    return { notebook: new Notebook(doc), close: () => void persistence.destroy() };
  }

  async add(notebook: Notebook, meta: Parameters<Library["add"]>[1]): Promise<OpenedNotebook> {
    const now = Date.now();
    await this.save({ ...meta, id: notebook.id, createdAt: meta.createdAt ?? now, updatedAt: now });
    // 掛上 y-indexeddb 時，它會先把目前的完整內容寫入
    const persistence = new IndexeddbPersistence(docDbName(notebook.id), notebook.doc);
    await persistence.whenSynced;
    requestPersistentStorage();
    return { notebook, close: () => void persistence.destroy() };
  }
}

/** 瀏覽器不支援 IndexedDB 時的替代品：只存在記憶體 */
class MemoryLibrary implements Library {
  readonly persistent = false;
  readonly blobs = new MemoryBlobStore();
  private metas = new Map<string, NotebookMeta>();
  private docs = new Map<string, Uint8Array>();

  async list() {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string) {
    return this.metas.get(id);
  }
  async findBySource(hash: string) {
    return (await this.list()).find((m) => m.sourceHash === hash);
  }
  async save(meta: NotebookMeta) {
    this.metas.set(meta.id, meta);
  }
  async remove(id: string) {
    this.metas.delete(id);
    this.docs.delete(id);
  }
  async open(id: string): Promise<OpenedNotebook> {
    const doc = new Y.Doc();
    const saved = this.docs.get(id);
    if (saved) Y.applyUpdate(doc, saved);
    const notebook = new Notebook(doc);
    return { notebook, close: () => this.docs.set(id, Y.encodeStateAsUpdate(doc)) };
  }
  async add(notebook: Notebook, meta: Parameters<Library["add"]>[1]): Promise<OpenedNotebook> {
    const now = Date.now();
    await this.save({ ...meta, id: notebook.id, createdAt: meta.createdAt ?? now, updatedAt: now });
    return { notebook, close: () => this.docs.set(notebook.id, Y.encodeStateAsUpdate(notebook.doc)) };
  }
}

let opening: Promise<Library> | undefined;

export function openLibrary(): Promise<Library> {
  opening ??= openDb()
    .then((db) => new IdbLibrary(db) as Library)
    .catch(() => new MemoryLibrary());
  return opening;
}

/** 請瀏覽器不要在空間不足時自動清掉資料（Safari 特別需要） */
function requestPersistentStorage() {
  try {
    void navigator.storage?.persist?.();
  } catch {
    // 不支援就算了
  }
}
