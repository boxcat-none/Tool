import { MindMap } from "@tool/mindmap";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

/**
 * 心智圖的儲存：和筆記本的書櫃分開（獨立開發，之後再合併）。
 *
 * - 清單：資料庫 guganote-mindmaps 的 maps（標題、節點數、更新時間）
 * - 內容（Yjs 文件）：y-indexeddb，每個修改立即寫入
 *
 * 瀏覽器不允許 IndexedDB 時改用記憶體，persistent = false。
 */

export interface MindMapMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface OpenedMindMap {
  map: MindMap;
  close(): void;
}

export interface MindMapStore {
  readonly persistent: boolean;
  list(): Promise<MindMapMeta[]>;
  save(meta: MindMapMeta): Promise<void>;
  remove(id: string): Promise<void>;
  open(id: string): Promise<OpenedMindMap>;
  /** 加入一張新的（或從檔案開啟的）心智圖，回傳開啟中的心智圖 */
  add(map: MindMap): Promise<OpenedMindMap>;
}

const DB_NAME = "guganote-mindmaps";
const docDbName = (id: string) => `guganote-map-${id}`;

export const metaOf = (map: MindMap, createdAt = Date.now()): MindMapMeta => ({
  id: map.id,
  title: map.title,
  createdAt,
  updatedAt: Date.now(),
  nodeCount: map.size,
});

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class IdbStore implements MindMapStore {
  readonly persistent = true;
  constructor(private db: IDBDatabase) {}
  private store(mode: IDBTransactionMode = "readonly") {
    return this.db.transaction("maps", mode).objectStore("maps");
  }
  async list() {
    const all = (await request(this.store().getAll())) as MindMapMeta[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async save(meta: MindMapMeta) {
    await request(this.store("readwrite").put(meta));
  }
  async remove(id: string) {
    await request(this.store("readwrite").delete(id));
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(docDbName(id));
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
  async open(id: string) {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(docDbName(id), doc);
    await persistence.whenSynced;
    return { map: new MindMap(doc), close: () => void persistence.destroy() };
  }
  async add(map: MindMap) {
    await this.save(metaOf(map));
    const persistence = new IndexeddbPersistence(docDbName(map.id), map.doc);
    await persistence.whenSynced;
    return { map, close: () => void persistence.destroy() };
  }
}

class MemoryStore implements MindMapStore {
  readonly persistent = false;
  private metas = new Map<string, MindMapMeta>();
  private docs = new Map<string, Uint8Array>();
  async list() {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async save(meta: MindMapMeta) {
    this.metas.set(meta.id, meta);
  }
  async remove(id: string) {
    this.metas.delete(id);
    this.docs.delete(id);
  }
  async open(id: string) {
    const doc = new Y.Doc();
    const saved = this.docs.get(id);
    if (saved) Y.applyUpdate(doc, saved);
    return { map: new MindMap(doc), close: () => this.docs.set(id, Y.encodeStateAsUpdate(doc)) };
  }
  async add(map: MindMap) {
    await this.save(metaOf(map));
    return { map, close: () => this.docs.set(map.id, Y.encodeStateAsUpdate(map.doc)) };
  }
}

let opening: Promise<MindMapStore> | undefined;

export function openMindMapStore(): Promise<MindMapStore> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("maps", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("blocked"));
  })
    .then((db) => new IdbStore(db) as MindMapStore)
    .catch(() => new MemoryStore());
  return opening;
}
