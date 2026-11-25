import {
  dropTarget,
  layoutFlow,
  subtreeIds,
  MINDMAP_EXTENSION,
  moveNodes,
  neighbor,
  nodesInRect,
  saveMindMapFile,
  toFreeMind,
  toOPML,
  segmentHitsRect,
  STRUCTURES,
  THEMES,
  themeById,
  type DropTarget,
  type Layout,
  type MindMap,
  type NodeOverride,
  type NodeStyle,
  type Placed,
  type Structure,
} from "@tool/mindmap";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UndoManager } from "yjs";
import { platform } from "../lib/platform";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { edgeList, FONT, LINK_PREFIX, LINE_HEIGHT, MIN_HEIGHT, MIN_WIDTH, MindMapContent, prepare, wrapLines } from "./MindMapCanvas";
import { metaOf, type MindMapStore } from "./store";

/**
 * 心智圖編輯畫面。
 *
 * 滑鼠：
 *   左鍵點主題／線條 = 選取（Shift 加選）；點兩下（或 F2、直接打字）編輯文字
 *   左鍵按住背景拖曳 = 拉出選取框，框選主題與線條（Shift 加選）
 *   右鍵按住背景（或任何地方）拖曳 = 移動整張圖；右鍵點一下 = 操作選單（主題、線條、背景各有不同選項）
 *   拖曳元件：放到別的元件中間 = 變成它的子元件，靠上／靠下 = 插在前後；放在空白處（或按住 Shift／Alt）= 自由放置。
 *     只有拖的元件（和其他選取的元件）會動，子元件留在原地（中心元件也一樣可以拖）。
 *     選了多個元件時一起自由移動。拖曳時連接線即時跟著動
 * 連接線：選取元件後兩側出現圓點，從圓點拉到另一個元件 = 連線（那個元件變成子元件，位置不變）；
 *   刪掉線條 = 子元件變成獨立元件。右鍵點元件新增的元件會自動連線；右鍵點背景新增的是獨立元件（不連線）
 * 觸控：一指拖背景 = 移動畫面、兩指縮放；觸控筆拖背景 = 框選；長按 = 操作選單
 * 鍵盤：Tab 子元件、Enter 同層、Delete、方向鍵、Alt+↑↓、空白鍵收合、Ctrl+A 全選、Ctrl+Z／Y
 * 貼上多行文字：依縮排建立多個元件
 */

const LOCAL = "this-device";
const NEW_TEXT = "新元件";
/** 排列獨立元件時上下的間距 */
const ARRANGE_GAP = 20;
const LONG_PRESS = 550;
const COLORS: { label: string; value: string | null }[] = [
  { label: "預設", value: null },
  { label: "紅", value: "#e03131" },
  { label: "橙", value: "#f76707" },
  { label: "黃", value: "#f2c94c" },
  { label: "綠", value: "#2f9e44" },
  { label: "青", value: "#0c8599" },
  { label: "藍", value: "#1c7ed6" },
  { label: "紫", value: "#7048e8" },
  { label: "粉", value: "#d6336c" },
];
const SHAPES = [
  { label: "預設", value: "" },
  { label: "圓角", value: "rounded" },
  { label: "膠囊", value: "pill" },
  { label: "方框", value: "rect" },
  { label: "卡片", value: "card" },
  { label: "橢圓", value: "ellipse" },
  { label: "底線", value: "underline" },
  { label: "菱形", value: "diamond" },
  { label: "平行四邊形", value: "parallelogram" },
];
const LINES = [
  { label: "預設", value: "" },
  { label: "曲線", value: "curve" },
  { label: "直角", value: "elbow" },
  { label: "直線", value: "straight" },
];
const WIDTHS = [
  { label: "預設", value: "" },
  { label: "細", value: "1" },
  { label: "中", value: "2.5" },
  { label: "粗", value: "5" },
];

type ExportKind = "png" | "svg" | "pdf" | "md" | "opml" | "mm" | "gugamap";
type ImageKind = "png" | "svg" | "pdf";
const IMAGE_LABEL: Record<ImageKind, string> = { png: "PNG 圖片", svg: "SVG 圖片", pdf: "PDF" };

interface View {
  x: number;
  y: number;
  s: number;
}

/** 選取：主題、線條（以子主題代號表示），primary = 鍵盤與工具列操作的對象 */
interface Selection {
  nodes: Set<string>;
  edges: Set<string>;
  primary: string | null;
}

const single = (id: string | null): Selection => ({ nodes: new Set(id ? [id] : []), edges: new Set(), primary: id });

interface Props {
  map: MindMap;
  store: MindMapStore;
  createdAt: number;
  onBack: () => void;
}

export function MindMapEditor({ map, store, createdAt, onBack }: Props) {
  const [version, setVersion] = useState(0);
  const [sel, setSel] = useState<Selection>(() => single(map.rootId));
  const selected = sel.primary;
  const setSelected = (id: string | null) => setSel(single(id));
  const [editing, setEditing] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  /** 拖曳主題：ids = 一起移動的主題（含子主題）；target = 放到別的主題上（換位置）；null = 自由放置 */
  const [drag, setDrag] = useState<{ roots: string[]; ids: Set<string>; dx: number; dy: number; target: DropTarget | null; blocked?: boolean } | null>(null);
  /** 框選（排版座標） */
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "node" | "edge" | "background" } | null>(null);
  /** 從元件的圓點拉線：to = 指標位置（排版座標）；target = 指到的元件；ok = 可以連 */
  const [link, setLink] = useState<LinkState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 匯出圖片（PNG、SVG、PDF）的選項視窗 */
  const [exportDialog, setExportDialog] = useState<{ kind: ImageKind; transparent: boolean; selection: boolean } | null>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const hostRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<UndoManager | null>(null);

  const act = useCallback((fn: () => void) => map.doc.transact(fn, LOCAL), [map]);

  // 有任何變動（包含復原）就重畫、更新清單資訊
  useEffect(() => {
    const undo = map.createUndoManager(LOCAL);
    undoRef.current = undo;
    const syncHistory = () => setHistory({ undo: undo.undoStack.length > 0, redo: undo.redoStack.length > 0 });
    undo.on("stack-item-added", syncHistory);
    undo.on("stack-item-popped", syncHistory);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = map.onChange(() => {
      setVersion((v) => v + 1);
      clearTimeout(timer);
      timer = setTimeout(() => void store.save(metaOf(map, createdAt)), 400);
    });
    return () => {
      off();
      clearTimeout(timer);
      void store.save(metaOf(map, createdAt));
      undo.destroy();
    };
  }, [map, store, createdAt]);

  const theme = themeById(map.theme);
  const structure = map.structure;
  const data = useMemo(
    () =>
      // 編輯中：元件跟著正在打的字即時變大、換行（連接線一起調整）
      prepare(map, structure, theme, editing ? { id: editing.id, text: editing.text } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [map, version, structure, theme, editing?.id, editing?.text],
  );
  const { layout } = data;
  // 拖曳中：暫時移動的排版（連接線跟著動）
  const shown = useMemo(() => (drag ? moveNodes(layout, drag.ids, drag.dx, drag.dy) : layout), [layout, drag]);
  const edges = useMemo(() => edgeList(data, shown), [data, shown]);
  const edgeSet = useMemo(() => new Set(edges.map((e) => e.id)), [edges]);
  const edgeById = (id: string) => edges.find((e) => e.id === id);

  // 選取的主題被刪掉（例如復原）時拿掉
  useEffect(() => {
    const nodes = [...sel.nodes].filter((id) => layout.byId.has(id));
    const edgeIds = [...sel.edges].filter((id) => edgeSet.has(id));
    if (nodes.length === sel.nodes.size && edgeIds.length === sel.edges.size && (!sel.primary || layout.byId.has(sel.primary))) return;
    const primary = sel.primary && layout.byId.has(sel.primary) ? sel.primary : nodes[0] ?? (map.has(sel.primary ?? "") ? null : map.rootId);
    setSel({ nodes: new Set(primary && !nodes.length ? [primary] : nodes), edges: new Set(edgeIds), primary });
  }, [layout, sel, map, edgeSet]);

  // ── 視圖：置中、縮放 ──────────────────────────────

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const { width, height } = host.getBoundingClientRect();
    const b = layout.bounds;
    const pad = 40;
    const s = Math.min(1.2, Math.max(0.2, Math.min((width - pad * 2) / b.width, (height - pad * 2) / b.height)));
    setView({ s, x: width / 2 - (b.x + b.width / 2) * s, y: height / 2 - (b.y + b.height / 2) * s });
  }, [layout]);

  // AI 產生的流程圖：第一次打開時，元件大小量好了才能排版（不算在復原裡），排好後置中
  /** 排版前的版面：版面換掉之後要再置中一次 */
  const needFit = useRef<Layout | null>(null);
  useEffect(() => {
    if (!map.layoutPending) return;
    needFit.current = layout;
    map.doc.transact(() => {
      applyFlowLayout();
      map.layoutPending = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // 第一次開啟、換結構時置中
  const fitKey = `${map.id}:${structure}`;
  const fitted = useRef("");
  useLayoutEffect(() => {
    if (fitted.current === fitKey) return;
    fitted.current = fitKey;
    fit();
  }, [fitKey, fit]);
  // 自動排版完（版面變了）再置中一次
  useLayoutEffect(() => {
    if (!needFit.current || needFit.current === layout) return;
    needFit.current = null;
    fit();
  }, [fit, layout]);

  // 畫布大小改變（旋轉 iPad、拉視窗）：保持畫面中心不變
  useEffect(() => {
    const host = hostRef.current!;
    let last = host.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      const now = host.getBoundingClientRect();
      const dx = (now.width - last.width) / 2;
      const dy = (now.height - last.height) / 2;
      last = now;
      if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const host = hostRef.current!.getBoundingClientRect();
    const px = cx ?? host.width / 2;
    const py = cy ?? host.height / 2;
    setView((v) => {
      const s = Math.min(3, Math.max(0.15, v.s * factor));
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  /** 實際大小（100%），以畫面中心為準 */
  const actualSize = () => zoomAt(1 / view.s);

  // 選取的主題跑到畫面外時，捲動讓它出現
  const reveal = useCallback((id: string) => {
    const n = layout.byId.get(id);
    const host = hostRef.current?.getBoundingClientRect();
    if (!n || !host) return;
    setView((v) => {
      const m = 40;
      const x0 = n.x * v.s + v.x, y0 = n.y * v.s + v.y;
      const x1 = (n.x + n.width) * v.s + v.x, y1 = (n.y + n.height) * v.s + v.y;
      let dx = 0, dy = 0;
      if (x0 < m) dx = m - x0; else if (x1 > host.width - m) dx = host.width - m - x1;
      if (y0 < m) dy = m - y0; else if (y1 > host.height - m) dy = host.height - m - y1;
      return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
    });
  }, [layout]);

  // 只有單選（鍵盤、新增）時才自動捲動；框選很多個時不要動畫面
  useEffect(() => {
    if (selected && sel.nodes.size === 1) reveal(selected);
  }, [selected, sel.nodes.size, reveal]);

  // ── 編輯動作 ──────────────────────────────────────

  const startEdit = (id: string, text?: string) => {
    const n = map.node(id);
    if (!n) return;
    setSelected(id);
    setEditing({ id, text: text ?? n.text, fresh: text !== undefined });
  };

  // 編輯框關閉時會觸發 blur → commitEdit；用 ref 讀最新狀態，按 Esc 取消後就不會再存一次
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const cancelEdit = () => {
    editingRef.current = null;
    setEditing(null);
    hostRef.current?.focus();
  };

  const commitEdit = () => {
    const e = editingRef.current;
    if (!e) return;
    editingRef.current = null;
    setEditing(null);
    const text = e.text.replace(/\s+$/, "");
    if (text !== map.node(e.id)?.text) act(() => map.setText(e.id, text || NEW_TEXT));
    hostRef.current?.focus();
  };

  const addChild = (id = selected) => {
    if (!id) return;
    let created = "";
    act(() => (created = map.addChild(id, NEW_TEXT)));
    startEdit(created, "");
  };

  const addSibling = (before = false, id = selected) => {
    if (!id) return;
    // 獨立元件的同層 = 下方再一個獨立元件
    const p = layout.byId.get(id);
    if (map.isFloating(id) && p) return addFloating([p.x, p.y + p.height + 24], false);
    let created = "";
    act(() => (created = map.addSibling(id, NEW_TEXT, before)));
    startEdit(created, "");
  };

  /** 新增獨立元件（不連線）；center = at 是元件中心，否則是左上角 */
  const addFloating = (at: [number, number], center = true) => {
    let created = "";
    act(() => (created = map.addFloating(NEW_TEXT, center ? [at[0] - MIN_WIDTH / 2, at[1] - MIN_HEIGHT / 2] : at)));
    startEdit(created, "");
  };

  /** 從 from 拉線到 to：多一條線，兩個元件原本的線、上層、位置都不變 */
  const canLink = (from: string, to: string) => map.canLink(from, to);
  const connect = (from: string, to: string) => {
    let id: string | null = null;
    act(() => (id = map.addLink(from, to)));
    if (id) setSel({ nodes: new Set(), edges: new Set([LINK_PREFIX + id]), primary: null });
  };

  /** 只移動 moved 裡的元件 (dx, dy)：子元件（沒選到的）留在原地 */
  const moveOnly = (moved: Set<string>, dx: number, dy: number) =>
    act(() => {
      const shiftBy = (id: string, k: number) => {
        const old = map.offset(id) ?? [0, 0];
        map.setOffset(id, [old[0] + dx * k, old[1] + dy * k]);
      };
      for (const id of moved) {
        const parent = map.parentOf(id);
        if (parent && moved.has(parent)) continue; // 上層也在動：跟著上層
        if (map.isFloating(id)) {
          const p = layout.byId.get(id)!;
          map.setAt(id, [p.x + dx, p.y + dy]);
        } else shiftBy(id, 1);
      }
      // 位移會傳給子元件：沒選到的子元件反方向補回來，畫面上不動（收合的也算）
      for (const id of moved) for (const c of map.children(id)) if (!moved.has(c)) shiftBy(c, -1);
    });

  /**
   * 排列。only = 選取的元件（沒有 = 整張圖）：
   *   有連線的元件回到自動排版的位置（只排選到的：沒選到的子元件留在原地）；
   *   獨立元件（連同底下的元件）由上往下排成整齊的一列、左邊對齊。
   *   整張圖：獨立元件排在中心元件那棵樹的右邊；只排選到的：排在它們原本範圍的左上角。
   */
  /**
   * 流程圖的自動排版：所有元件（上層 → 子元件的線和手拉的線都算）由上往下分層排好。
   * 每個元件移動量 = 目標 - 現在；位移會傳給子元件，所以子元件只記「比上層多移的」。
   */
  const applyFlowLayout = () => {
    const lay = prepare(map, structure, theme).layout;
    const flowEdges = [...lay.nodes.filter((n) => n.parent).map((n) => ({ from: n.parent!, to: n.id })), ...map.links().map((l) => ({ from: l.from, to: l.to }))];
    const pos = layoutFlow(lay.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })), flowEdges);
    const moved = new Map<string, [number, number]>();
    // lay.nodes 是上層在前（先序）
    for (const n of lay.nodes) {
      const t = pos.get(n.id);
      if (!t) continue;
      const mv: [number, number] = [t[0] - n.x, t[1] - n.y];
      moved.set(n.id, mv);
      if (map.isFloating(n.id)) {
        map.setAt(n.id, t);
        continue;
      }
      const pm = (n.parent && moved.get(n.parent)) || [0, 0];
      const old = map.offset(n.id) ?? [0, 0];
      map.setOffset(n.id, [old[0] + mv[0] - pm[0], old[1] + mv[1] - pm[1]]);
    }
  };

  const arrange = (only?: string[]) =>
    act(() => {
      // 流程圖的「自動排列」= 由上往下分層排好
      if (!only && map.kind === "flow") return applyFlowLayout();
      if (!only) map.clearOffsets();
      else {
        const set = new Set(only);
        for (const id of only) {
          const old = map.offset(id);
          if (!old) continue;
          map.setOffset(id, null);
          for (const c of map.children(id)) {
            if (set.has(c)) continue;
            const o = map.offset(c) ?? [0, 0];
            map.setOffset(c, [o[0] + old[0], o[1] + old[1]]);
          }
        }
      }
      const lay = prepare(map, structure, theme).layout;
      const floats = (only ?? map.floatingIds()).filter((id) => map.isFloating(id) && lay.byId.has(id));
      if (!floats.length) return;
      const boxOf = (ids: Iterable<string>) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const id of ids) {
          const n = lay.byId.get(id);
          if (!n) continue;
          x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
          x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height);
        }
        return { x0, y0, x1, y1 };
      };
      const boxes = new Map(floats.map((id) => [id, boxOf(subtreeIds(lay, [id]))]));
      let x: number, y: number;
      if (!only) {
        const inFloat = subtreeIds(lay, map.floatingIds());
        const main = boxOf(lay.nodes.filter((n) => !inFloat.has(n.id)).map((n) => n.id));
        x = main.x1 + 80;
        y = main.y0;
      } else {
        x = Math.min(...[...boxes.values()].map((b) => b.x0));
        y = Math.min(...[...boxes.values()].map((b) => b.y0));
      }
      // 依原本由上到下的順序
      for (const id of [...floats].sort((a, b) => boxes.get(a)!.y0 - boxes.get(b)!.y0 || boxes.get(a)!.x0 - boxes.get(b)!.x0)) {
        const b = boxes.get(id)!;
        const p = lay.byId.get(id)!;
        map.setAt(id, [x + (p.x - b.x0), y + (p.y - b.y0)]);
        y += b.y1 - b.y0 + ARRANGE_GAP;
      }
    });
  /** 有沒有東西可以排列 */
  const canArrange = (only?: string[]) =>
    !only && map.kind === "flow" ? map.size > 1 : only ? only.some((id) => map.offset(id) || map.isFloating(id)) && (only.length > 1 || !!map.offset(only[0])) : map.hasOffsets() || map.floatingIds().length > 0;

  /** 刪掉線條：子元件（和它底下的元件）變成獨立元件，留在原地 */
  const detachEdges = (ids: string[]) => {
    act(() => {
      map.removeLink(ids.filter((id) => id.startsWith(LINK_PREFIX)).map((id) => id.slice(LINK_PREFIX.length)));
      for (const id of ids) {
        if (id.startsWith(LINK_PREFIX)) continue;
        const p = layout.byId.get(id);
        if (p?.parent) map.detach(id, [p.x, p.y]);
      }
    });
    const first = ids.find((id) => !id.startsWith(LINK_PREFIX));
    setSel(single(first ?? null));
  };

  /** 刪除選取的主題（中心主題不會被刪） */
  const removeSelected = () => {
    const ids = [...sel.nodes].filter((id) => id !== map.rootId);
    if (!ids.length) return;
    const first = ids[0];
    const parent = map.parentOf(first);
    const sibs = parent ? map.children(parent).filter((c) => !sel.nodes.has(c)) : [];
    const i = parent ? map.children(parent).indexOf(first) : -1;
    // 刪除後選取下一個同層（沒有就上一個，再沒有就父主題）
    const next = sibs.find((c) => map.children(parent!).indexOf(c) > i) ?? sibs[sibs.length - 1] ?? parent;
    act(() => map.remove(ids));
    setSelected(next && map.has(next) ? next : map.rootId);
  };

  const toggleCollapse = (id = selected) => {
    if (!id || !map.children(id).length) return;
    act(() => map.setCollapsed(id, !map.node(id)!.collapsed));
  };

  const selectAll = () => {
    const ids = layout.nodes.map((n) => n.id);
    setSel({ nodes: new Set(ids), edges: new Set(edges.map((e) => e.id)), primary: selected ?? map.rootId });
  };

  const setStructure = (s: Structure) => act(() => (map.structure = s));
  const setTheme = (t: string) => act(() => (map.theme = t));

  // ── 鍵盤 ──────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (editing || menu || exportDialog || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (mod && (key === "z" || key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undoRef.current?.undo();
      } else if (mod && (((key === "z" || key === "Z") && e.shiftKey) || key === "y" || key === "Y")) {
        e.preventDefault();
        undoRef.current?.redo();
      } else if (mod && (key === "s" || key === "S")) {
        e.preventDefault();
        void exportAs("gugamap");
      } else if (mod && (key === "a" || key === "A")) {
        e.preventDefault();
        selectAll();
      } else if (mod && (key === "=" || key === "+")) {
        e.preventDefault();
        zoomAt(1.2);
      } else if (mod && key === "-") {
        e.preventDefault();
        zoomAt(1 / 1.2);
      } else if (mod && key === "0") {
        e.preventDefault();
        fit();
      } else if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        // 只選了線條：刪線（元件留著）；有選元件：刪元件
        if (![...sel.nodes].some((id) => id !== map.rootId) && sel.edges.size) detachEdges([...sel.edges]);
        else removeSelected();
      } else if (key === "Escape") {
        setSelected(null);
      } else if (!selected || mod) {
        return;
      } else if (key === "Tab") {
        e.preventDefault();
        addChild();
      } else if (key === "Enter") {
        e.preventDefault();
        addSibling(e.shiftKey);
      } else if (key === "F2") {
        e.preventDefault();
        startEdit(selected);
      } else if (key === " ") {
        e.preventDefault();
        toggleCollapse();
      } else if (e.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
        e.preventDefault();
        act(() => map.shift(selected, key === "ArrowUp" ? -1 : 1));
      } else if (key.startsWith("Arrow")) {
        e.preventDefault();
        const dir = key.slice(5).toLowerCase() as "left" | "right" | "up" | "down";
        const next = neighbor(layout, selected, dir);
        if (next) setSelected(next);
      } else if (key.length === 1 && !e.altKey) {
        // 直接打字：取代文字開始編輯
        e.preventDefault();
        startEdit(selected, key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 貼上多行文字 → 依縮排建立主題
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (editing || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text?.trim()) return;
      e.preventDefault();
      const parent = selected ?? map.rootId;
      let top: string[] = [];
      act(() => (top = map.addOutline(parent, text)));
      if (top.length) setSelected(top[0]);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // ── 指標 ──────────────────────────────────────────

  type Hit = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "toggle"; id: string } | { kind: "handle"; id: string; side: HandleSide } | { kind: "background" };
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "node"; id: string; pointerId: number; start: [number, number]; moved: boolean; view: View; hit: Hit }
    | { kind: "pan"; pointerId: number; start: [number, number]; view: View; moved: boolean; hit: Hit; button: number; pointerType: string }
    | { kind: "box"; pointerId: number; start: [number, number]; moved: boolean; additive: boolean; base: Selection }
    | { kind: "edge"; pointerId: number; start: [number, number]; moved: boolean; hit: Hit }
    | { kind: "link"; from: string; side: HandleSide; pointerId: number; start: [number, number]; moved: boolean }
    | { kind: "pinch"; dist: number; mid: [number, number]; view: View }
    | null
  >(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toMap = ([x, y]: [number, number], v: View = view): [number, number] => [(x - v.x) / v.s, (y - v.y) / v.s];

  const hitOf = (el: Element): Hit => {
    const handle = el.closest("[data-handle]");
    if (handle) return { kind: "handle", id: handle.getAttribute("data-handle")!, side: handle.getAttribute("data-side") as HandleSide };
    const toggle = el.closest("[data-toggle]")?.getAttribute("data-toggle");
    if (toggle) return { kind: "toggle", id: toggle };
    const node = el.closest("[data-node]")?.getAttribute("data-node");
    if (node) return { kind: "node", id: node };
    // 線上的文字也算點到那條線
    const edge = el.closest("[data-edge]")?.getAttribute("data-edge") ?? el.closest("[data-edge-label]")?.getAttribute("data-edge-label");
    if (edge) return { kind: "edge", id: edge };
    return { kind: "background" };
  };

  /** 右鍵（或長按）：選取按到的東西（已在選取範圍內就保留多選），然後開選單 */
  const openMenu = (hit: Hit, at: [number, number]) => {
    if (hit.kind === "node" || hit.kind === "toggle" || hit.kind === "handle") {
      if (!sel.nodes.has(hit.id)) setSel(single(hit.id));
      else setSel({ ...sel, primary: hit.id });
      setMenu({ x: at[0], y: at[1], kind: "node" });
    } else if (hit.kind === "edge") {
      if (!sel.edges.has(hit.id)) setSel({ nodes: new Set(), edges: new Set([hit.id]), primary: null });
      setMenu({ x: at[0], y: at[1], kind: "edge" });
    } else {
      setMenu({ x: at[0], y: at[1], kind: "background" });
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.target instanceof HTMLTextAreaElement) return; // 在編輯框裡點選文字
    if (e.button === 1) return;
    if (editing) commitEdit();
    setMenu(null);
    hostRef.current?.focus();
    const p = local(e);
    pointers.current.set(e.pointerId, { x: p[0], y: p[1] });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    clearTimeout(longPress.current);
    if (pointers.current.size === 2) {
      // 第二根手指：改成兩指縮放（取消拖曳、框選）
      const [a, b] = [...pointers.current.values()];
      setDrag(null);
      setBox(null);
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], view };
      return;
    }
    const hit = hitOf(e.target as Element);
    // 中間按過別的東西（線條、圓點、背景）就不算連點兩下
    if (hit.kind !== "node") lastTap.current = null;
    // 右鍵：拖曳 = 移動整張圖；沒拖 = 選單（放開時判斷）
    if (e.pointerType === "mouse" && e.button === 2) {
      gesture.current = { kind: "pan", pointerId: e.pointerId, start: p, view, moved: false, hit, button: 2, pointerType: e.pointerType };
      return;
    }
    if (e.pointerType !== "mouse") {
      // 觸控、觸控筆：長按開選單
      longPress.current = setTimeout(() => {
        const g = gesture.current;
        if (!g || g.kind === "pinch" || g.moved) return;
        gesture.current = null;
        setDrag(null);
        setBox(null);
        openMenu(hit, p);
      }, LONG_PRESS);
    }
    if (hit.kind === "toggle") {
      toggleCollapse(hit.id);
      gesture.current = null;
      return;
    }
    if (hit.kind === "handle") {
      // 從圓點拉線
      gesture.current = { kind: "link", from: hit.id, side: hit.side, pointerId: e.pointerId, start: p, moved: false };
      return;
    }
    if (hit.kind === "node") {
      if (e.shiftKey) {
        // Shift：加選／取消
        const nodes = new Set(sel.nodes);
        if (nodes.has(hit.id)) nodes.delete(hit.id);
        else nodes.add(hit.id);
        setSel({ ...sel, nodes, primary: nodes.has(hit.id) ? hit.id : [...nodes][0] ?? null });
      } else if (!sel.nodes.has(hit.id)) {
        setSel(single(hit.id));
      } else {
        setSel({ ...sel, primary: hit.id });
      }
      gesture.current = { kind: "node", id: hit.id, pointerId: e.pointerId, start: p, moved: false, view, hit };
      return;
    }
    if (hit.kind === "edge") {
      if (e.shiftKey) {
        const edgesSel = new Set(sel.edges);
        if (edgesSel.has(hit.id)) edgesSel.delete(hit.id);
        else edgesSel.add(hit.id);
        setSel({ ...sel, edges: edgesSel });
      } else {
        setSel({ nodes: new Set(), edges: new Set([hit.id]), primary: null });
      }
      gesture.current = { kind: "edge", pointerId: e.pointerId, start: p, moved: false, hit };
      return;
    }
    // 背景：滑鼠左鍵、觸控筆 = 框選；手指 = 移動畫面
    if (e.pointerType === "touch") {
      gesture.current = { kind: "pan", pointerId: e.pointerId, start: p, view, moved: false, hit, button: 0, pointerType: e.pointerType };
    } else {
      gesture.current = { kind: "box", pointerId: e.pointerId, start: toMap(p), moved: false, additive: e.shiftKey, base: sel };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, { x: p[0], y: p[1] });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const s = Math.min(3, Math.max(0.15, (g.view.s * Math.hypot(a.x - b.x, a.y - b.y)) / (g.dist || 1)));
      const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const k = s / g.view.s;
      setView({ s, x: mid[0] - (g.mid[0] - g.view.x) * k, y: mid[1] - (g.mid[1] - g.view.y) * k });
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    if (g.kind === "box") {
      const m = toMap(p);
      if (!g.moved && Math.hypot((m[0] - g.start[0]) * view.s, (m[1] - g.start[1]) * view.s) < 4) return;
      g.moved = true;
      clearTimeout(longPress.current);
      setBox([g.start[0], g.start[1], m[0], m[1]]);
      return;
    }
    const dx = p[0] - g.start[0];
    const dy = p[1] - g.start[1];
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    g.moved = true;
    clearTimeout(longPress.current);
    if (g.kind === "edge") return;
    if (g.kind === "link") {
      const [mx, my] = toMap(p);
      // 指到的元件（上面的優先）
      const over = [...layout.nodes].reverse().find((n) => mx >= n.x - 4 && mx <= n.x + n.width + 4 && my >= n.y - 4 && my <= n.y + n.height + 4 && n.id !== g.from);
      setLink({ from: g.from, side: g.side, to: [mx, my], target: over?.id ?? null, ok: !!over && canLink(g.from, over.id) });
      return;
    }
    if (g.kind === "pan") {
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    } else {
      const [mx, my] = toMap(p);
      // 一起移動的元件：選了多個 → 選到的全部；否則只有這一個（子元件不跟著動）
      const group = sel.nodes.size > 1 && sel.nodes.has(g.id) ? [...sel.nodes].filter((id) => layout.byId.has(id)) : [g.id];
      const multi = group.length > 1;
      // 按住 Shift 或 Alt、或多選、或中心元件：一定是自由放置
      const free = e.shiftKey || e.altKey || multi || g.id === map.rootId;
      const target = free ? null : dropTarget(layout, g.id, mx, my);
      // 放到自己的子主題上：不能放；還在自己身上 = 微調位置，照樣自由放置
      const over = layout.nodes.find((n) => mx >= n.x && mx <= n.x + n.width && my >= n.y && my <= n.y + n.height && n.id !== g.id);
      const blocked = !target && !!over && !free && isBelow(layout, g.id, over.id);
      setDrag({ roots: group, ids: new Set(group), dx: dx / view.s, dy: dy / view.s, target, blocked });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    clearTimeout(longPress.current);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    gesture.current = null;
    const cancel = e.type === "pointercancel";
    if (g.kind === "pan") {
      if (!g.moved && !cancel) {
        if (g.button === 2) openMenu(g.hit, local(e));
        else if (g.pointerType === "touch") setSelected(null);
      }
      return;
    }
    if (g.kind === "box") {
      const b = box;
      setBox(null);
      if (!g.moved) {
        if (!g.additive) setSelected(null);
        return;
      }
      if (!b || cancel) return;
      // 框到的主題與線條（Shift：加到原本的選取）
      const nodes = new Set(g.additive ? g.base.nodes : []);
      const edgeSel = new Set(g.additive ? g.base.edges : []);
      for (const id of nodesInRect(layout, b)) nodes.add(id);
      for (const ed of edges) if (segmentHitsRect(ed.from[0], ed.from[1], ed.to[0], ed.to[1], b)) edgeSel.add(ed.id);
      setSel({ nodes, edges: edgeSel, primary: [...nodes][0] ?? null });
      return;
    }
    if (g.kind === "edge") return;
    if (g.kind === "link") {
      const l = link;
      setLink(null);
      if (g.moved && l?.target && l.ok && !cancel) connect(g.from, l.target);
      return;
    }
    if (g.moved) {
      const d = drag;
      setDrag(null);
      if (!d || d.blocked || cancel) return;
      if (d.target) {
        act(() => map.move(g.id, d.target!.parent, d.target!.index));
      } else {
        // 放在空白處：停在放開的位置（只有拖的元件動，子元件留在原地）
        moveOnly(d.ids, d.dx, d.dy);
      }
      return;
    }
    // 點兩下編輯（滑鼠、觸控、觸控筆都一樣）
    const now = performance.now();
    if (lastTap.current && lastTap.current.id === g.id && now - lastTap.current.at < 400 && !e.shiftKey) {
      lastTap.current = null;
      startEdit(g.id);
    } else {
      // Shift 點選（加選）不算第一下
      lastTap.current = e.shiftKey ? null : { id: g.id, at: now };
    }
  };

  // 滾輪：平移；Ctrl＋滾輪（觸控板兩指縮放也是）：縮放
  useEffect(() => {
    const host = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const [x, y] = local(e);
        zoomAt(Math.exp(-e.deltaY * 0.01), x, y);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  });

  // ── 匯出 ──────────────────────────────────────────

  const fileBase = (map.title || "心智圖").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);

  /**
   * 匯出用的 SVG：只有心智圖內容（沒有選取框、圓點等操作用的東西），四周留白。
   * transparent = 不畫背景；only = 只匯出這些元件（和它們之間的線）。
   */
  const svgText = (opts: { transparent?: boolean; only?: string[] } = {}) => {
    const lay = opts.only?.length ? subsetLayout(layout, opts.only) : layout;
    const b = lay.bounds;
    const pad = 32;
    const x = Math.floor(b.x - pad), y = Math.floor(b.y - pad);
    const w = Math.ceil(b.width + pad * 2), h = Math.ceil(b.height + pad * 2);
    const inner = renderToStaticMarkup(<MindMapContent data={data} layout={lay} />);
    const bg = opts.transparent ? "" : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${theme.background}"/>`;
    return {
      w,
      h,
      text: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" font-family='${FONT.replace(/'/g, "")}'>${bg}${inner}</svg>`,
    };
  };

  /** SVG 畫成 PNG（maxScale 倍，總像素不超過約 1600 萬） */
  const pngBytes = async (opts: { transparent?: boolean; only?: string[] }, maxScale: number) => {
    const { w, h, text } = svgText(opts);
    const scale = Math.min(maxScale, Math.sqrt(16_000_000 / (w * h)));
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("無法產生圖片"))), "image/png"));
      return { w, h, data: new Uint8Array(await blob.arrayBuffer()) };
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const exportAs = async (kind: ExportKind, opts: { transparent?: boolean; only?: string[] } = {}) => {
    try {
      let result: string | null;
      const enc = new TextEncoder();
      const save = (ext: string, data: Uint8Array) => platform.saveFile({ name: fileBase + ext, data });
      if (kind === "gugamap") result = await save(MINDMAP_EXTENSION, enc.encode(saveMindMapFile(map)));
      else if (kind === "md") result = await save(".md", enc.encode(map.toMarkdown()));
      else if (kind === "opml") result = await save(".opml", enc.encode(toOPML(map)));
      else if (kind === "mm") result = await save(".mm", enc.encode(toFreeMind(map)));
      else if (kind === "svg") result = await save(".svg", enc.encode(svgText(opts).text));
      else if (kind === "png") result = await save(".png", (await pngBytes(opts, 2)).data);
      else {
        // PDF：一頁放整張圖（頁面大小跟著圖），圖用高解析度 PNG（中文字型不用另外嵌入）
        const [{ PDFDocument }, png] = await Promise.all([import("pdf-lib"), pngBytes(opts, 3)]);
        const pdf = await PDFDocument.create();
        pdf.setTitle(map.title || "心智圖");
        pdf.setCreator("GugaNote 心智圖");
        const img = await pdf.embedPng(png.data);
        const pw = png.w * 0.75, ph = png.h * 0.75; // CSS px → pt
        pdf.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        result = await save(".pdf", await pdf.save());
      }
      if (result) setToast(result);
    } catch (err) {
      setToast(`匯出失敗：${(err as Error).message}`);
    }
  };

  /** 匯出選單：圖片格式先開選項視窗，其他直接存 */
  const chooseExport = (kind: ExportKind) => {
    if (kind === "png" || kind === "svg" || kind === "pdf") setExportDialog({ kind, transparent: false, selection: false });
    else void exportAs(kind);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ── 選單內容 ──────────────────────────────────────

  // ids 可以是元件、或線條（上層 → 子元件的線用子元件代號；手拉的線是 link:代號）
  const isLink = (id: string) => id.startsWith(LINK_PREFIX);
  const linkId = (id: string) => id.slice(LINK_PREFIX.length);
  const styleValue = <K extends keyof NodeOverride>(ids: string[], key: K): string => {
    const vals = new Set(ids.map((id) => String((isLink(id) ? (map.link(linkId(id)) as NodeOverride | undefined) : map.nodeStyle(id))?.[key] ?? "")));
    return vals.size === 1 ? [...vals][0] : "?";
  };
  const setStyle = (ids: string[], patch: Parameters<MindMap["setNodeStyle"]>[1]) =>
    act(() => {
      map.setNodeStyle(ids.filter((id) => !isLink(id)), patch);
      const { shape: _shape, ...linkPatch } = patch;
      map.setLinkStyle(ids.filter(isLink).map(linkId), linkPatch);
    });
  const colorValue = (ids: string[]) => {
    const vals = new Set(ids.map((id) => (isLink(id) ? map.link(linkId(id))?.color : map.node(id)?.color) ?? null));
    return vals.size === 1 ? [...vals][0] : "?";
  };
  const setColor = (ids: string[], c: string | null) =>
    act(() => {
      ids.filter((id) => !isLink(id)).forEach((id) => map.setColor(id, c));
      map.setLinkStyle(ids.filter(isLink).map(linkId), { color: c });
    });
  /** 線條設定（ids = 線條，也就是子主題） */
  const lineItems = (ids: string[]): MenuItem[] => [
    { kind: "choices", label: "線型", options: LINES, value: styleValue(ids, "line"), onSelect: (v) => setStyle(ids, { line: (v || null) as NodeOverride["line"] | null }) },
    { kind: "choices", label: "粗細", options: WIDTHS, value: styleValue(ids, "width"), onSelect: (v) => setStyle(ids, { width: v ? Number(v) : null }) },
    {
      kind: "choices",
      label: "虛線",
      options: [{ label: "實線", value: "" }, { label: "虛線", value: "true" }],
      value: styleValue(ids, "dash"),
      onSelect: (v) => setStyle(ids, { dash: v === "true" || null }),
    },
  ];

  /** 手拉的線才有的設定：箭頭、線上的文字 */
  const linkOnlyItems = (ids: string[]): MenuItem[] => {
    if (!ids.length || !ids.every(isLink)) return [];
    const lids = ids.map(linkId);
    const arrows = new Set(lids.map((id) => (map.link(id)?.arrow ? "true" : "")));
    return [
      {
        kind: "choices",
        label: "箭頭",
        options: [{ label: "無", value: "" }, { label: "有", value: "true" }],
        value: arrows.size === 1 ? [...arrows][0] : "?",
        onSelect: (v) => act(() => map.setLinkStyle(lids, { arrow: v === "true" || null })),
      },
      {
        kind: "action",
        label: "線上的文字…",
        onSelect: () => {
          const cur = lids.length === 1 ? map.link(lids[0])?.label ?? "" : "";
          const t = window.prompt("線上的文字（留空 = 不顯示）", cur);
          if (t !== null) act(() => map.setLinkStyle(lids, { label: t.trim() || null }));
        },
      },
    ];
  };

  const menuItems = (): { title: string; items: MenuItem[] } => {
    if (!menu) return { title: "", items: [] };
    if (menu.kind === "background") {
      return {
        title: "畫布",
        items: [
          // 背景新增的是獨立元件（不連線），放在按右鍵的位置；要連線就從元件的圓點拉過去
          { kind: "action", label: "新增元件", onSelect: () => addFloating(toMap([menu.x, menu.y])) },
          { kind: "action", label: "全選", hint: "Ctrl+A", onSelect: selectAll },
          { kind: "separator" },
          { kind: "action", label: "整張圖置中", hint: "Ctrl+0", onSelect: fit },
          { kind: "action", label: "實際大小（100%）", onSelect: actualSize },
          { kind: "action", label: "自動排列", disabled: !canArrange(), onSelect: () => arrange() },
          { kind: "separator" },
          { kind: "choices", label: "結構", options: STRUCTURES.map((s) => ({ label: s.label, value: s.id })), value: structure, onSelect: (v) => setStructure(v as Structure) },
          { kind: "choices", label: "樣式", options: THEMES.map((t) => ({ label: t.label.slice(0, 1), value: t.id })), value: theme.id, onSelect: setTheme },
          { kind: "separator" },
          { kind: "action", label: "匯出 PNG 圖片…", onSelect: () => chooseExport("png") },
        ],
      };
    }
    const edgeIds = [...sel.edges].filter((id) => edgeSet.has(id));
    if (menu.kind === "edge") {
      return {
        title: edgeIds.length > 1 ? `${edgeIds.length} 條線` : "線條",
        items: [
          ...lineItems(edgeIds),
          { kind: "colors", label: "顏色", options: COLORS, value: colorValue(edgeIds), onSelect: (c) => setColor(edgeIds, c) },
          ...linkOnlyItems(edgeIds),
          { kind: "separator" },
          { kind: "action", label: "選取線條兩端的元件", onSelect: () => {
              const ends = edgeIds.flatMap((id) => { const e = edgeById(id); return e ? [e.parent, e.child] : []; });
              setSel({ nodes: new Set(ends), edges: new Set(edgeIds), primary: ends[1] ?? null });
            } },
          { kind: "action", label: edgeIds.length > 1 ? `刪除 ${edgeIds.length} 條線` : "刪除線條", hint: "Delete", danger: true, onSelect: () => detachEdges(edgeIds) },
        ],
      };
    }
    const ids = [...sel.nodes].filter((id) => layout.byId.has(id));
    const one = ids.length === 1 ? ids[0] : null;
    const nonRoot = ids.filter((id) => id !== map.rootId);
    const items: MenuItem[] = [];
    if (one) {
      items.push(
        { kind: "action", label: "新增子元件", hint: "Tab", onSelect: () => addChild(one) },
        { kind: "action", label: one === map.rootId ? "新增元件" : "新增同層元件", hint: "Enter", onSelect: () => addSibling(false, one) },
        { kind: "action", label: "編輯文字", hint: "F2", onSelect: () => startEdit(one) },
      );
      if (map.children(one).length) items.push({ kind: "action", label: map.node(one)!.collapsed ? "展開" : "收合", hint: "空白鍵", onSelect: () => toggleCollapse(one) });
      items.push({ kind: "separator" });
    }
    items.push(
      { kind: "colors", label: "顏色", options: COLORS, value: colorValue(ids), onSelect: (c) => act(() => ids.forEach((id) => map.setColor(id, c))) },
      { kind: "choices", label: "形狀", options: SHAPES, value: styleValue(ids, "shape"), onSelect: (v) => setStyle(ids, { shape: (v || null) as NodeOverride["shape"] | null }) },
    );
    const linked = nonRoot.filter((id) => !map.isFloating(id));
    if (linked.length) items.push(...lineItems(linked));
    items.push({ kind: "separator" });
    if (canArrange(ids)) items.push({ kind: "action", label: ids.length > 1 ? `排列選取的 ${ids.length} 個元件` : "回到自動排版的位置", onSelect: () => arrange(ids) });
    if (linked.length) items.push({ kind: "action", label: "拆掉連到上層的線", onSelect: () => detachEdges(linked) });
    if (nonRoot.length) items.push({ kind: "action", label: nonRoot.length > 1 ? `刪除 ${nonRoot.length} 個元件` : "刪除", hint: "Delete", danger: true, onSelect: removeSelected });
    return { title: one ? `元件「${oneLine(map.node(one)!.text)}」` : `${ids.length} 個元件`, items };
  };

  // ── 畫面 ──────────────────────────────────────────

  const selNode = selected ? map.node(selected) : undefined;
  /** 選了多個元件時，「自動排列」只排選到的 */
  const multiIds = [...sel.nodes].filter((id) => layout.byId.has(id));
  const editingPlaced = editing ? layout.byId.get(editing.id) : undefined;
  const editStyle = editing ? data.styles.get(editing.id) : undefined;
  const menuData = menu ? menuItems() : null;

  return (
    <div className="mm-editor">
      <div className="mm-toolbar" role="toolbar" aria-label="心智圖工具列">
        <button type="button" className="mm-btn" onClick={onBack} aria-label="回到心智圖清單">‹ 清單</button>
        <input
          className="mm-title"
          aria-label="心智圖標題"
          value={map.title}
          onChange={(e) => act(() => (map.title = e.target.value))}
        />
        <span className="mm-group">
          <label className="mm-field">
            結構
            <select aria-label="結構" value={structure} onChange={(e) => setStructure(e.target.value as Structure)}>
              {STRUCTURES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="mm-field">
            樣式
            <select aria-label="樣式" value={theme.id} onChange={(e) => setTheme(e.target.value)}>
              {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        </span>
        <span className="mm-group">
          <button type="button" className="mm-btn" disabled={!selected} onClick={() => addChild()} title="新增子元件（Tab）">＋子元件</button>
          <button type="button" className="mm-btn" disabled={!selected} onClick={() => addSibling()} title="新增同層元件（Enter）">＋同層</button>
          <button type="button" className="mm-btn" disabled={!selected} onClick={() => selected && startEdit(selected)} title="編輯文字（F2、點兩下）">編輯</button>
          <button type="button" className="mm-btn" disabled={!selected || !map.children(selected).length} onClick={() => toggleCollapse()} title="收合／展開（空白鍵）">
            {selNode?.collapsed ? "展開" : "收合"}
          </button>
          <button type="button" className="mm-btn mm-btn--danger" disabled={![...sel.nodes].some((id) => id !== map.rootId)} onClick={removeSelected} title="刪除（Delete）">刪除</button>
          <label className="mm-field">
            顏色
            <select
              aria-label="分支顏色"
              disabled={!selected}
              value={selNode?.color ?? ""}
              onChange={(e) => act(() => [...sel.nodes].forEach((id) => map.setColor(id, e.target.value || null)))}
            >
              {COLORS.map((c) => <option key={c.label} value={c.value ?? ""}>{c.label}</option>)}
            </select>
          </label>
        </span>
        <span className="mm-group">
          <button type="button" className="mm-btn" disabled={!history.undo} onClick={() => undoRef.current?.undo()} aria-label="復原" title="復原（Ctrl+Z）">↶</button>
          <button type="button" className="mm-btn" disabled={!history.redo} onClick={() => undoRef.current?.redo()} aria-label="重做" title="重做（Ctrl+Y）">↷</button>
          <button type="button" className="mm-btn" onClick={() => zoomAt(1 / 1.2)} aria-label="縮小">−</button>
          <span className="mm-zoom">{Math.round(view.s * 100)}%</span>
          <button type="button" className="mm-btn" onClick={() => zoomAt(1.2)} aria-label="放大">+</button>
          <button type="button" className="mm-btn" onClick={fit} title="整張圖置中（Ctrl+0）">置中</button>
          <button
            type="button"
            className="mm-btn"
            disabled={!canArrange(multiIds.length > 1 ? multiIds : undefined)}
            onClick={() => arrange(multiIds.length > 1 ? multiIds : undefined)}
            title={multiIds.length > 1 ? "選取的元件回到自動排版的位置，獨立元件排整齊" : "整張圖回到自動排版的位置，獨立元件排整齊"}
          >
            自動排列
          </button>
          <label className="mm-field">
            <select
              aria-label="匯出"
              value=""
              onChange={(e) => {
                const v = e.target.value as ExportKind;
                e.target.value = "";
                if (v) chooseExport(v);
              }}
            >
              <option value="">匯出…</option>
              <optgroup label="圖片">
                <option value="png">PNG 圖片</option>
                <option value="svg">SVG 圖片</option>
                <option value="pdf">PDF</option>
              </optgroup>
              <optgroup label="給其他軟體（XMind、MindNode…）">
                <option value="mm">FreeMind（.mm）</option>
                <option value="opml">OPML 大綱（.opml）</option>
                <option value="md">Markdown 大綱</option>
              </optgroup>
              <optgroup label="完整備份">
                <option value="gugamap">心智圖檔（.gugamap）</option>
              </optgroup>
            </select>
          </label>
        </span>
      </div>

      <div
        ref={hostRef}
        className={`mm-canvas${gesture.current?.kind === "pan" && gesture.current.moved ? " mm-canvas--panning" : ""}`}
        tabIndex={0}
        aria-label="心智圖畫布"
        style={{ background: theme.background }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg className="mm-svg" width="100%" height="100%">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.s})`}>
            {/* 選取的線條：在線下面墊一層亮色 */}
            <g className="mm-ui" pointerEvents="none">
              {edges.filter((ed) => sel.edges.has(ed.id)).map((ed) => (
                <path key={ed.id} d={ed.d} fill="none" stroke={theme.accent} strokeOpacity={0.45} strokeWidth={ed.width + 8 / view.s} strokeLinecap="round" data-selected-edge={ed.id} />
              ))}
            </g>
            {/* 點選線條用的透明粗線（不會匯出）：放在元件下面，線經過元件時按元件會選到元件 */}
            <g className="mm-hits">
              {edges.map((ed) => (
                <path key={ed.id} d={ed.d} data-edge={ed.id} fill="none" stroke="transparent" strokeWidth={Math.max(12 / view.s, ed.width + 6)} pointerEvents="stroke" style={{ cursor: "pointer" }} />
              ))}
            </g>
            <g>
              <MindMapContent data={data} layout={shown} lifted={drag?.ids} editing={editing?.id} />
            </g>
            {/* 拉線用的圓點：選取一個元件時出現在兩側（不會匯出） */}
            {!editing && !drag && sel.nodes.size === 1 && selected && shown.byId.has(selected) && (
              <Handles layout={shown} n={shown.byId.get(selected)!} color={theme.accent} bg={theme.background} s={view.s} />
            )}
            {/* 介面層：選取框、拖曳提示、框選（不會匯出） */}
            <g className="mm-ui" pointerEvents="none">
              {[...sel.nodes].map((id) => {
                const n = shown.byId.get(id);
                if (!n) return null;
                return (
                  <rect
                    key={id}
                    x={n.x - 5}
                    y={n.y - 5}
                    width={n.width + 10}
                    height={n.height + 10}
                    rx={10}
                    fill="none"
                    stroke={theme.accent}
                    strokeWidth={(id === selected ? 2 : 1.5) / view.s}
                    strokeDasharray={id === selected ? undefined : `${5 / view.s} ${3 / view.s}`}
                    data-selected={id === selected ? id : undefined}
                    data-multi={id}
                  />
                );
              })}
              {link && <LinkPreview layout={layout} link={link} color={theme.accent} s={view.s} />}
              {drag?.target && <DropHint layout={layout} target={drag.target} color={theme.accent} s={view.s} />}
              {box && (
                <rect
                  className="mm-box"
                  x={Math.min(box[0], box[2])}
                  y={Math.min(box[1], box[3])}
                  width={Math.abs(box[2] - box[0])}
                  height={Math.abs(box[3] - box[1])}
                  fill={theme.accent}
                  fillOpacity={0.1}
                  stroke={theme.accent}
                  strokeWidth={1 / view.s}
                  strokeDasharray={`${4 / view.s} ${3 / view.s}`}
                />
              )}
            </g>
          </g>
        </svg>

        {editing && editingPlaced && editStyle && (
          <textarea
            className="mm-edit"
            aria-label="元件文字"
            autoFocus
            value={editing.text}
            rows={1}
            spellCheck={false}
            style={editBox(editingPlaced, editStyle, editing.text, view)}
            onFocus={(e) => {
              if (!editing.fresh) e.currentTarget.select();
              else e.currentTarget.setSelectionRange(editing.text.length, editing.text.length);
            }}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              } else if (e.key === "Tab") {
                // 完成編輯並新增子主題（連續輸入）
                e.preventDefault();
                const id = editing.id;
                commitEdit();
                addChild(id);
              }
              e.stopPropagation();
            }}
          />
        )}

        {menu && menuData && <ContextMenu x={menu.x} y={menu.y} title={menuData.title} items={menuData.items} onClose={() => setMenu(null)} />}
        {toast && <div className="mm-toast" role="status">{toast}</div>}
        {exportDialog && (
          <div className="mm-dialog__backdrop" onPointerDown={(e) => e.stopPropagation()}>
            <div
              className="mm-dialog"
              role="dialog"
              aria-label={`匯出 ${IMAGE_LABEL[exportDialog.kind]}`}
              onKeyDown={(e) => {
                if (e.key === "Escape") setExportDialog(null);
                e.stopPropagation();
              }}
            >
              <h2>匯出 {IMAGE_LABEL[exportDialog.kind]}</h2>
              <fieldset>
                <legend>範圍</legend>
                <label>
                  <input type="radio" name="mm-export-range" checked={!exportDialog.selection} onChange={() => setExportDialog({ ...exportDialog, selection: false })} />
                  整張圖
                </label>
                <label className={multiIds.length ? undefined : "is-disabled"}>
                  <input type="radio" name="mm-export-range" disabled={!multiIds.length} checked={exportDialog.selection} onChange={() => setExportDialog({ ...exportDialog, selection: true })} />
                  只匯出選取的 {multiIds.length} 個元件
                </label>
              </fieldset>
              <label>
                <input type="checkbox" checked={exportDialog.transparent} onChange={(e) => setExportDialog({ ...exportDialog, transparent: e.target.checked })} />
                透明背景
              </label>
              <div className="mm-dialog__actions">
                <button type="button" className="mm-btn" onClick={() => setExportDialog(null)}>取消</button>
                <button
                  type="button"
                  className="mm-btn mm-btn--primary"
                  autoFocus
                  onClick={() => {
                    const d = exportDialog;
                    setExportDialog(null);
                    void exportAs(d.kind, { transparent: d.transparent, only: d.selection ? multiIds : undefined });
                  }}
                >
                  匯出
                </button>
              </div>
            </div>
          </div>
        )}
        <p className="mm-hint">左鍵拖背景框選 · 右鍵拖曳移動畫面 · 右鍵點一下開選單 · 點兩下編輯 · 從元件兩側的圓點拉線連接</p>
      </div>
    </div>
  );
}

/**
 * 編輯框放在元件的文字位置上（透明、同字型），看起來就是直接在元件裡打字。
 * 元件大小已經依正在打的字算好（自動換行），編輯框照同樣的行數與寬度擺放。
 */
function editBox(n: Placed, st: NodeStyle, text: string, view: View): React.CSSProperties {
  const { lines, width } = wrapLines(text, st);
  const lh = st.fontSize * LINE_HEIGHT;
  const wrapped = lines.length > text.split("\n").length;
  // 有自動換行時寬度要剛好（瀏覽器才會在同一個地方換行）；沒有時留一點空間給下一個字
  const w = width + (wrapped ? 1 : 8);
  const h = lines.length * lh;
  const x = n.x + (n.width - w) / 2;
  const y = n.y + (n.height - h) / 2;
  return {
    left: x * view.s + view.x,
    top: y * view.s + view.y,
    width: w * view.s,
    height: h * view.s,
    fontSize: st.fontSize * view.s,
    lineHeight: LINE_HEIGHT,
    fontWeight: st.fontWeight,
    fontFamily: FONT,
    color: st.text,
    caretColor: st.text,
  };
}

const oneLine = (s: string) => {
  const t = s.replace(/\s*\n\s*/g, " ").trim();
  return t.length > 16 ? `${t.slice(0, 16)}…` : t;
};

/** `id` 是否在 `ancestor` 底下（依排版的父子關係） */
function isBelow(layout: Layout, ancestor: string, id: string): boolean {
  for (let p = layout.byId.get(id)?.parent ?? null; p; p = layout.byId.get(p)?.parent ?? null) if (p === ancestor) return true;
  return false;
}

function DropHint({ layout, target, color, s }: { layout: Layout; target: DropTarget; color: string; s: number }) {
  const n = layout.byId.get(target.over);
  if (!n) return null;
  const w = 2.5 / s;
  if (target.where === "child") {
    return <rect x={n.x - 6} y={n.y - 6} width={n.width + 12} height={n.height + 12} rx={10} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={w} strokeDasharray={`${6 / s} ${4 / s}`} />;
  }
  const after = target.where === "after";
  if (layout.structure === "org") {
    const x = after ? n.x + n.width + 6 : n.x - 6;
    return <line x1={x} y1={n.y - 4} x2={x} y2={n.y + n.height + 4} stroke={color} strokeWidth={w * 1.5} strokeLinecap="round" />;
  }
  const y = after ? n.y + n.height + 5 : n.y - 5;
  return <line x1={n.x - 4} y1={y} x2={n.x + n.width + 4} y2={y} stroke={color} strokeWidth={w * 1.5} strokeLinecap="round" />;
}

type HandleSide = "r" | "l" | "b";

interface LinkState {
  from: string;
  side: HandleSide;
  to: [number, number];
  target: string | null;
  ok: boolean;
}

const HANDLE_GAP = 12;

/**
 * 拉線圓點放在哪幾邊：沒有上層的元件（中心、獨立元件）左右都有；
 * 有上層的只放在離上層那一邊的對面（不會蓋住連進來的線）；組織圖放在下面。
 */
function handleSides(layout: Layout, n: Placed): HandleSide[] {
  if (layout.structure === "org") return ["b"];
  if (!n.parent) return ["r", "l"];
  if (layout.structure === "tree") return ["r"];
  const p = layout.byId.get(n.parent);
  return p && n.x + n.width / 2 < p.x + p.width / 2 ? ["l"] : ["r"];
}

function handlePoint(n: Placed, side: HandleSide): [number, number] {
  // 收合的元件旁邊有「+3」標記：圓點放在標記外面
  const gap = HANDLE_GAP + (n.hidden > 0 ? 28 : 0);
  if (side === "b") return [n.x + n.width / 2, n.y + n.height + gap];
  return [side === "r" ? n.x + n.width + gap : n.x - gap, n.y + n.height / 2];
}

/** 拉線用的圓點 */
function Handles({ layout, n, color, bg, s }: { layout: Layout; n: Placed; color: string; bg: string; s: number }) {
  const r = Math.max(5, 6 / s);
  return (
    <g className="mm-handles">
      {handleSides(layout, n).map((side) => {
        const [cx, cy] = handlePoint(n, side);
        return (
          <g key={side} data-handle={n.id} data-side={side} style={{ cursor: "crosshair" }} aria-label="拉線連到其他元件">
            {/* 透明的大範圍，手指比較好按 */}
            <circle cx={cx} cy={cy} r={r * 2} fill="transparent" />
            <circle cx={cx} cy={cy} r={r} fill={color} stroke={bg} strokeWidth={2 / s} />
          </g>
        );
      })}
    </g>
  );
}

/** 拉線中：從圓點到指標的虛線；指到可以連的元件 = 外框，不能連 = 紅框 */
function LinkPreview({ layout, link, color, s }: { layout: Layout; link: LinkState; color: string; s: number }) {
  const a = layout.byId.get(link.from);
  if (!a) return null;
  const [sx, sy] = handlePoint(a, link.side);
  const [ex, ey] = link.to;
  const vertical = link.side === "b";
  const d = vertical
    ? `M${sx} ${sy}C${sx} ${(sy + ey) / 2} ${ex} ${(sy + ey) / 2} ${ex} ${ey}`
    : `M${sx} ${sy}C${(sx + ex) / 2} ${sy} ${(sx + ex) / 2} ${ey} ${ex} ${ey}`;
  const t = link.target ? layout.byId.get(link.target) : undefined;
  const bad = "#e03131";
  return (
    <g className="mm-link" data-link-ok={t ? String(link.ok) : undefined}>
      <path d={d} fill="none" stroke={t && !link.ok ? bad : color} strokeWidth={2 / s} strokeDasharray={`${6 / s} ${4 / s}`} />
      {t && <rect x={t.x - 6} y={t.y - 6} width={t.width + 12} height={t.height + 12} rx={10} fill={link.ok ? color : bad} fillOpacity={0.12} stroke={link.ok ? color : bad} strokeWidth={2.5 / s} />}
    </g>
  );
}

/** 只有某些元件的排版（匯出選取的部分）：兩端都在裡面的線才會畫 */
function subsetLayout(layout: Layout, ids: Iterable<string>): Layout {
  const set = new Set(ids);
  const nodes = layout.nodes.filter((n) => set.has(n.id));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height);
  }
  return { structure: layout.structure, nodes, byId: new Map(nodes.map((n) => [n.id, n])), bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}
