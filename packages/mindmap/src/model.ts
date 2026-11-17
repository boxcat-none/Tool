import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";

/**
 * 心智圖資料模型（Yjs 文件）。和筆記本一樣用 Yjs，之後才能在多台裝置之間同步、合併。
 *
 *   meta   Y.Map  { schema, id, title, root, structure, theme, createdAt }
 *   nodes  Y.Map  nodeId → Y.Map { parent, order, text, collapsed?, color?, pos? }
 *
 * pos = 使用者自由拖動後的位移 { 結構: [dx, dy] }（相對於自動排版的位置，子節點跟著移動）。
 * 每種結構各自記錄：在心智圖裡拖過的位置不會影響組織圖。
 *
 * 每個節點只記「父節點」和「在兄弟之間的順序」（fractional indexing），
 * 所以兩台裝置同時把同一個節點拖到不同位置時，只有最後一次生效，不會出現兩份。
 *
 * 兩台裝置同時做「把 A 拖到 B 底下」和「把 B 拖到 A 底下」會形成迴圈；
 * 讀取時遇到迴圈或父節點已被刪除，就把該節點接到中心主題下（所有裝置結果一致），資料不會遺失。
 */

export const MINDMAP_SCHEMA = 1;

/** 版面結構 */
export type Structure = "mindmap" | "logic" | "org" | "tree";
export const STRUCTURES: { id: Structure; label: string }[] = [
  { id: "mindmap", label: "心智圖" },
  { id: "logic", label: "邏輯圖" },
  { id: "org", label: "組織圖" },
  { id: "tree", label: "樹狀圖" },
];

export interface MindNode {
  id: string;
  parent: string | null;
  text: string;
  collapsed: boolean;
  /** 自訂分支顏色（#rrggbb），子節點跟著用；沒有時用主題的顏色 */
  color?: string;
}

export type Offset = [dx: number, dy: number];

/** 排版用的樹（已排序、已處理迴圈；收合的節點沒有 children） */
export interface TreeNode extends MindNode {
  children: TreeNode[];
  /** 收合時底下有幾個節點（畫「+3」用） */
  hidden: number;
  /** 目前結構下自由拖動的位移（沒有拖過 = undefined） */
  offset?: Offset;
}

export class MindMap {
  readonly doc: Y.Doc;
  private readonly meta: Y.Map<unknown>;
  private readonly nodes: Y.Map<Y.Map<unknown>>;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.meta = doc.getMap("meta");
    this.nodes = doc.getMap("nodes");
  }

  static create(title: string, rootText = title): MindMap {
    const map = new MindMap();
    map.doc.transact(() => {
      const root = newId();
      map.meta.set("schema", MINDMAP_SCHEMA);
      map.meta.set("id", newId());
      map.meta.set("title", title);
      map.meta.set("root", root);
      map.meta.set("structure", "mindmap");
      map.meta.set("theme", "node");
      map.meta.set("createdAt", Date.now());
      const m = new Y.Map<unknown>();
      m.set("parent", null);
      m.set("order", "a0");
      m.set("text", rootText);
      map.nodes.set(root, m);
    });
    return map;
  }

  get id(): string {
    return (this.meta.get("id") as string) ?? "";
  }

  get rootId(): string {
    return (this.meta.get("root") as string) ?? "";
  }

  get title(): string {
    return (this.meta.get("title") as string) ?? "";
  }

  set title(v: string) {
    this.meta.set("title", v);
  }

  get structure(): Structure {
    return ((this.meta.get("structure") as Structure) ?? "mindmap");
  }

  set structure(v: Structure) {
    this.meta.set("structure", v);
  }

  get theme(): string {
    return (this.meta.get("theme") as string) ?? "node";
  }

  set theme(v: string) {
    this.meta.set("theme", v);
  }

  get size(): number {
    return this.nodes.size;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  node(id: string): MindNode | undefined {
    const m = this.nodes.get(id);
    if (!m) return undefined;
    const color = m.get("color") as string | undefined;
    return {
      id,
      parent: this.effectiveParent(id),
      text: (m.get("text") as string) ?? "",
      collapsed: !!m.get("collapsed"),
      ...(color ? { color } : {}),
    };
  }

  /** 子節點（依順序） */
  children(id: string): string[] {
    return this.childIndex().get(id) ?? [];
  }

  /** 父節點（處理過迴圈與遺失的父節點；中心主題回傳 null） */
  parentOf(id: string): string | null {
    return this.effectiveParent(id);
  }

  /** 從中心主題到這個節點的深度（中心主題 = 0） */
  depth(id: string): number {
    let d = 0;
    for (let p = this.effectiveParent(id); p; p = this.effectiveParent(p)) d++;
    return d;
  }

  isAncestor(ancestor: string, id: string): boolean {
    for (let p = this.effectiveParent(id); p; p = this.effectiveParent(p)) if (p === ancestor) return true;
    return false;
  }

  /** 在 `parent` 底下第 `index` 個位置（預設最後）新增節點，回傳代號 */
  addChild(parent: string, text = "", index?: number): string {
    if (!this.nodes.has(parent)) throw new Error(`節點不存在：${parent}`);
    const id = newId();
    this.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("parent", parent);
      m.set("order", this.orderAt(parent, index ?? Infinity));
      m.set("text", text);
      this.nodes.set(id, m);
      // 在收合的節點底下新增：展開，才看得到新節點
      this.nodes.get(parent)!.delete("collapsed");
    });
    return id;
  }

  /** 在某個節點的後面（或前面）新增同層節點；中心主題沒有同層，改為新增子節點 */
  addSibling(id: string, text = "", before = false): string {
    const parent = this.effectiveParent(id);
    if (!parent) return this.addChild(id, text);
    const index = this.children(parent).indexOf(id);
    return this.addChild(parent, text, before ? index : index + 1);
  }

  setText(id: string, text: string): void {
    this.nodes.get(id)?.set("text", text);
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const m = this.nodes.get(id);
    if (!m) return;
    if (collapsed) m.set("collapsed", true);
    else m.delete("collapsed");
  }

  setColor(id: string, color: string | null): void {
    const m = this.nodes.get(id);
    if (!m) return;
    if (color) m.set("color", color);
    else m.delete("color");
  }

  /** 自由拖動後的位移（某個結構下）；沒有拖過回傳 undefined */
  offset(id: string, structure: Structure = this.structure): Offset | undefined {
    const pos = this.nodes.get(id)?.get("pos") as Partial<Record<Structure, Offset>> | undefined;
    return pos?.[structure];
  }

  /** 設定自由拖動的位移（null = 回到自動排版的位置） */
  setOffset(id: string, offset: Offset | null, structure: Structure = this.structure): void {
    const m = this.nodes.get(id);
    if (!m) return;
    const pos = { ...((m.get("pos") as Partial<Record<Structure, Offset>> | undefined) ?? {}) };
    if (offset && (offset[0] || offset[1])) pos[structure] = [round1(offset[0]), round1(offset[1])];
    else delete pos[structure];
    if (Object.keys(pos).length) m.set("pos", pos);
    else if (m.has("pos")) m.delete("pos");
  }

  /** 自動排列：清掉某個結構下所有自由拖動的位移 */
  clearOffsets(structure: Structure = this.structure): void {
    this.doc.transact(() => {
      for (const id of this.nodes.keys()) if (this.offset(id, structure)) this.setOffset(id, null, structure);
    });
  }

  /** 有沒有自由拖動過的節點 */
  hasOffsets(structure: Structure = this.structure): boolean {
    for (const id of this.nodes.keys()) if (this.offset(id, structure)) return true;
    return false;
  }

  /** 刪除節點與它底下所有節點（中心主題不能刪） */
  remove(ids: Iterable<string>): void {
    const index = this.childIndex();
    this.doc.transact(() => {
      for (const id of ids) {
        if (id === this.rootId || !this.nodes.has(id)) continue;
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop()!;
          stack.push(...(index.get(cur) ?? []));
          this.nodes.delete(cur);
        }
      }
    });
  }

  /**
   * 把節點移到 `parent` 底下第 `index` 個位置（以移動後的順序計算）。
   * 不能移到自己或自己的子孫底下；中心主題不能移動。回傳是否移動了。
   */
  move(id: string, parent: string, index = Infinity): boolean {
    const m = this.nodes.get(id);
    if (!m || id === this.rootId || !this.nodes.has(parent)) return false;
    if (parent === id || this.isAncestor(id, parent)) return false;
    this.doc.transact(() => {
      m.set("order", this.orderAt(parent, index, id));
      if (m.get("parent") !== parent) {
        m.set("parent", parent);
        // 換到別的父節點：原本拖動的位移是相對舊位置的，清掉
        if (m.has("pos")) m.delete("pos");
      }
      this.nodes.get(parent)!.delete("collapsed");
    });
    return true;
  }

  /** 在兄弟之間上移（-1）或下移（+1） */
  shift(id: string, step: -1 | 1): boolean {
    const parent = this.effectiveParent(id);
    if (!parent) return false;
    const sibs = this.children(parent);
    const i = sibs.indexOf(id) + step;
    if (i < 0 || i >= sibs.length) return false;
    return this.move(id, parent, i);
  }

  /** 排版用的樹 */
  tree(structure: Structure = this.structure): TreeNode {
    const index = this.childIndex();
    const build = (id: string): TreeNode => {
      const n = this.node(id)!;
      const kids = index.get(id) ?? [];
      const offset = id === this.rootId ? undefined : this.offset(id, structure);
      const extra = offset ? { offset } : {};
      if (n.collapsed && kids.length) return { ...n, ...extra, children: [], hidden: countBelow(id, index) };
      return { ...n, ...extra, children: kids.map(build), hidden: 0 };
    };
    return build(this.rootId);
  }

  /** 匯出成 Markdown 大綱（每層縮排兩格） */
  toMarkdown(): string {
    const index = this.childIndex();
    const lines: string[] = [`# ${oneLine(this.node(this.rootId)?.text ?? "")}`];
    const walk = (id: string, depth: number) => {
      for (const c of index.get(id) ?? []) {
        lines.push(`${"  ".repeat(depth)}- ${oneLine(this.node(c)!.text)}`);
        walk(c, depth + 1);
      }
    };
    walk(this.rootId, 0);
    return lines.join("\n") + "\n";
  }

  /**
   * 把縮排的文字（Markdown 清單、或用 Tab／空白縮排的純文字）加到 `parent` 底下，回傳新增的第一層節點。
   * 用來貼上大綱：每一行一個節點，縮排比上一行深就是它的子節點。
   */
  addOutline(parent: string, text: string): string[] {
    const items = parseOutline(text);
    const top: string[] = [];
    this.doc.transact(() => {
      const stack: { level: number; id: string }[] = [{ level: -1, id: parent }];
      for (const { level, text: t } of items) {
        while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
        const id = this.addChild(stack[stack.length - 1].id, t);
        if (stack.length === 1) top.push(id);
        stack.push({ level, id });
      }
    });
    return top;
  }

  // ── 變動通知、復原 ──────────────────────────────────

  onChange(callback: (event: { local: boolean }) => void): () => void {
    const handler = (_u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => callback({ local: tr.local });
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  /** 只追蹤 `origin` 的修改（其他裝置同步來的不會被復原）；本機修改請包在 doc.transact(fn, origin) */
  createUndoManager(origin: unknown): Y.UndoManager {
    return new Y.UndoManager([this.nodes, this.meta], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  }

  // ── 內部 ───────────────────────────────────────────

  /** 父節點 → 子節點（依 order 排序；order 相同用代號，所有裝置一致） */
  private childIndex(): Map<string, string[]> {
    const index = new Map<string, { id: string; order: string }[]>();
    for (const [id, m] of this.nodes) {
      const p = this.effectiveParent(id);
      if (!p) continue;
      let list = index.get(p);
      if (!list) index.set(p, (list = []));
      list.push({ id, order: (m.get("order") as string) ?? "" });
    }
    const out = new Map<string, string[]>();
    for (const [p, list] of index) {
      list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
      out.set(p, list.map((c) => c.id));
    }
    return out;
  }

  /** 存的父節點，但遇到迴圈或父節點不存在時改為中心主題 */
  private effectiveParent(id: string): string | null {
    const root = this.rootId;
    if (id === root) return null;
    const stored = this.nodes.get(id)?.get("parent") as string | null | undefined;
    if (!stored || !this.nodes.has(stored)) return root;
    // 往上走到中心主題；走不到（迴圈）就接到中心主題
    const seen = new Set([id]);
    for (let p: string | null | undefined = stored; p !== root; ) {
      if (!p || seen.has(p) || !this.nodes.has(p)) return root;
      seen.add(p);
      p = this.nodes.get(p)!.get("parent") as string | null | undefined;
    }
    return stored;
  }

  /** `parent` 的子節點之間第 `index` 個位置的 order（`skip` = 正在移動的節點，不算在內） */
  private orderAt(parent: string, index: number, skip?: string): string {
    const sibs = this.children(parent).filter((c) => c !== skip);
    const i = Math.max(0, Math.min(index, sibs.length));
    const ord = (id: string) => (this.nodes.get(id)!.get("order") as string) || null;
    const lo = i > 0 ? ord(sibs[i - 1]) : null;
    const hi = i < sibs.length ? ord(sibs[i]) : null;
    if (lo !== null && hi !== null && lo >= hi) return generateKeyBetween(lo, null); // 兩台裝置產生了相同的 order：放到後面
    return generateKeyBetween(lo, hi);
  }
}

function countBelow(id: string, index: Map<string, string[]>): number {
  let n = 0;
  const stack = [...(index.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    stack.push(...(index.get(c) ?? []));
  }
  return n;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** 解析縮排的文字：回傳每一行的層級與文字（空行略過；「- 」「* 」「1. 」「# 」等標記去掉） */
export function parseOutline(text: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const indents: number[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
    const t = raw.trim().replace(/^(#+\s+|[-*+•]\s+|\d+[.)]\s+)/, "").trim();
    if (!t) continue;
    // 縮排換算成層級：比之前的縮排深就多一層，回到之前的縮排就回到那一層
    while (indents.length && indents[indents.length - 1] > indent) indents.pop();
    if (!indents.length || indents[indents.length - 1] < indent) indents.push(indent);
    out.push({ level: indents.length - 1, text: t });
  }
  return out;
}

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}
