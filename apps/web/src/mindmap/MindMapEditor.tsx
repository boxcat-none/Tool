import {
  dropTarget,
  layoutTree,
  MINDMAP_EXTENSION,
  neighbor,
  PORT_INSET,
  saveMindMapFile,
  STRUCTURES,
  THEMES,
  themeById,
  type DropTarget,
  type MindMap,
  type Structure,
} from "@tool/mindmap";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UndoManager } from "yjs";
import { platform } from "../lib/platform";
import { FONT, measureNode, MindMapContent, NodeShape, prepare } from "./MindMapCanvas";
import { metaOf, type MindMapStore } from "./store";

/**
 * 心智圖編輯畫面。
 *
 * 操作：
 *   點一下選取；點兩下（或 F2、或直接打字）編輯文字；Enter 完成、Shift+Enter 換行、Esc 取消
 *   Tab 新增子主題、Enter 新增同層主題（Shift+Enter 加在前面）、Delete 刪除
 *   方向鍵移動選取、Alt+↑↓ 調整順序、空白鍵收合／展開、Ctrl+Z／Y 復原／重做
 *   拖曳節點：放在別的節點中間 = 變成它的子主題，靠上／靠下 = 插在前面／後面；
 *     放在空白處（或按住 Shift／Alt）= 自由放置，子主題一起移動；「自動排列」回到整齊排版
 *   拖曳空白處平移；滾輪捲動、Ctrl+滾輪或兩指縮放
 *   貼上多行文字：依縮排建立多個主題
 */

const LOCAL = "this-device";
const NEW_TEXT = "新主題";
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

interface View {
  x: number;
  y: number;
  s: number;
}

interface Props {
  map: MindMap;
  store: MindMapStore;
  createdAt: number;
  onBack: () => void;
}

export function MindMapEditor({ map, store, createdAt, onBack }: Props) {
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(map.rootId);
  const [editing, setEditing] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  /** 拖曳節點：target = 放到別的主題上（換位置）；null = 放在空白處（自由放置） */
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; target: DropTarget | null; blocked?: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const undoRef = useRef<UndoManager | null>(null);

  const act = useCallback((fn: () => void) => map.doc.transact(fn, LOCAL), [map]);

  // 筆記本有任何變動（包含復原）就重畫、更新清單資訊
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
      prepare(
        map,
        (tree, styles) => {
          const depth = new Map<string, number>();
          const walk = (n: typeof tree, d: number) => {
            depth.set(n.id, d);
            n.children.forEach((c) => walk(c, d + 1));
          };
          walk(tree, 0);
          return layoutTree(tree, (n) => measureNode(n.text, styles.get(n.id)!, depth.get(n.id)!), structure);
        },
        theme,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [map, version, structure, theme],
  );
  const { layout } = data;

  // 選取的節點被刪掉（例如復原）時取消選取
  useEffect(() => {
    if (selected && !layout.byId.has(selected)) setSelected(map.has(selected) ? null : map.rootId);
  }, [layout, selected, map]);

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

  // 第一次開啟、換結構時置中
  const fitKey = `${map.id}:${structure}`;
  const fitted = useRef("");
  useLayoutEffect(() => {
    if (fitted.current === fitKey) return;
    fitted.current = fitKey;
    fit();
  }, [fitKey, fit]);

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

  // 選取的節點跑到畫面外時，捲動讓它出現
  const reveal = useCallback((id: string) => {
    const n = layout.byId.get(id);
    const host = hostRef.current?.getBoundingClientRect();
    if (!n || !host) return;
    // 用最新的視圖計算（剛置中完的那一次更新可能還沒反映到這次的 render）
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

  useEffect(() => {
    if (selected) reveal(selected);
  }, [selected, reveal]);

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
    let created = "";
    act(() => (created = map.addSibling(id, NEW_TEXT, before)));
    startEdit(created, "");
  };

  const removeSelected = () => {
    if (!selected || selected === map.rootId) return;
    const parent = map.parentOf(selected);
    const sibs = parent ? map.children(parent) : [];
    const i = sibs.indexOf(selected);
    // 刪除後選取下一個同層（沒有就上一個，再沒有就父節點）
    const next = sibs[i + 1] ?? sibs[i - 1] ?? parent;
    act(() => map.remove([selected]));
    setSelected(next);
  };

  const toggleCollapse = (id = selected) => {
    if (!id || !map.children(id).length) return;
    act(() => map.setCollapsed(id, !map.node(id)!.collapsed));
  };

  const setStructure = (s: Structure) => act(() => (map.structure = s));
  const setTheme = (t: string) => act(() => (map.theme = t));

  // ── 鍵盤 ──────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (editing || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
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
      } else if (mod && (key === "=" || key === "+")) {
        e.preventDefault();
        zoomAt(1.2);
      } else if (mod && key === "-") {
        e.preventDefault();
        zoomAt(1 / 1.2);
      } else if (mod && key === "0") {
        e.preventDefault();
        fit();
      } else if (!selected || mod) {
        return;
      } else if (key === "Tab") {
        e.preventDefault();
        addChild();
      } else if (key === "Enter") {
        e.preventDefault();
        addSibling(e.shiftKey);
      } else if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        removeSelected();
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
      } else if (key === "Escape") {
        setSelected(null);
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

  // ── 指標：選取、拖曳節點、平移、兩指縮放 ─────────────

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "node"; id: string; pointerId: number; start: [number, number]; moved: boolean; view: View }
    | { kind: "pan"; pointerId: number; start: [number, number]; view: View; moved: boolean }
    | { kind: "pinch"; dist: number; mid: [number, number]; view: View }
    | null
  >(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toMap = ([x, y]: [number, number]): [number, number] => [(x - view.x) / view.s, (y - view.y) / view.s];

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target instanceof HTMLTextAreaElement) return; // 在編輯框裡點選文字
    if (editing) commitEdit();
    hostRef.current?.focus();
    const p = local(e);
    pointers.current.set(e.pointerId, { x: p[0], y: p[1] });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      // 第二根手指：改成兩指縮放（取消拖曳）
      const [a, b] = [...pointers.current.values()];
      setDrag(null);
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], view };
      return;
    }
    const el = e.target as Element;
    const toggle = el.closest("[data-toggle]")?.getAttribute("data-toggle");
    if (toggle) {
      toggleCollapse(toggle);
      gesture.current = null;
      return;
    }
    const id = el.closest("[data-node]")?.getAttribute("data-node");
    if (id) {
      setSelected(id);
      gesture.current = { kind: "node", id, pointerId: e.pointerId, start: p, moved: false, view };
    } else {
      gesture.current = { kind: "pan", pointerId: e.pointerId, start: p, view, moved: false };
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
    const dx = p[0] - g.start[0];
    const dy = p[1] - g.start[1];
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    g.moved = true;
    if (g.kind === "pan") {
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    } else if (g.id === map.rootId) {
      // 拖中心主題 = 移動整張圖的畫面
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    } else {
      const [mx, my] = toMap(p);
      // 按住 Shift 或 Alt：一定是自由放置（即使在別的主題上）
      const target = e.shiftKey || e.altKey ? null : dropTarget(layout, g.id, mx, my);
      // 放到自己的子主題上：不能放（放開時什麼都不做）；還在自己身上 = 微調位置，照樣自由放置
      const over = layout.nodes.find((n) => mx >= n.x && mx <= n.x + n.width && my >= n.y && my <= n.y + n.height && n.id !== g.id);
      const blocked = !target && !!over && !(e.shiftKey || e.altKey) && isBelow(layout, g.id, over.id);
      setDrag({ id: g.id, dx: dx / view.s, dy: dy / view.s, target, blocked });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    gesture.current = null;
    if (g.kind === "pan") {
      if (!g.moved) setSelected(null);
      return;
    }
    if (g.moved) {
      const d = drag;
      setDrag(null);
      if (!d || d.blocked || e.type === "pointercancel") return;
      if (d.target) {
        act(() => map.move(d.id, d.target!.parent, d.target!.index));
      } else {
        // 放在空白處：停在放開的位置（記成相對自動排版的位移，子主題一起移動）
        const old = map.offset(d.id) ?? [0, 0];
        act(() => map.setOffset(d.id, [old[0] + d.dx, old[1] + d.dy]));
      }
      return;
    }
    // 點兩下編輯（滑鼠、觸控、觸控筆都一樣）
    const now = performance.now();
    if (lastTap.current && lastTap.current.id === g.id && now - lastTap.current.at < 400) {
      lastTap.current = null;
      startEdit(g.id);
    } else {
      lastTap.current = { id: g.id, at: now };
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

  const svgText = () => {
    const b = layout.bounds;
    const pad = 32;
    const x = Math.floor(b.x - pad), y = Math.floor(b.y - pad);
    const w = Math.ceil(b.width + pad * 2), h = Math.ceil(b.height + pad * 2);
    const inner = contentRef.current!.innerHTML;
    return {
      w,
      h,
      text: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${theme.background}"/>${inner}</svg>`,
    };
  };

  const exportAs = async (kind: "png" | "svg" | "md" | "gugamap") => {
    try {
      let result: string | null;
      const enc = new TextEncoder();
      if (kind === "gugamap") result = await platform.saveFile({ name: fileBase + MINDMAP_EXTENSION, data: enc.encode(saveMindMapFile(map)) });
      else if (kind === "md") result = await platform.saveFile({ name: `${fileBase}.md`, data: enc.encode(map.toMarkdown()) });
      else if (kind === "svg") result = await platform.saveFile({ name: `${fileBase}.svg`, data: enc.encode(svgText().text) });
      else {
        const { w, h, text } = svgText();
        const scale = Math.min(2, Math.sqrt(16_000_000 / (w * h)));
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
          result = await platform.saveFile({ name: `${fileBase}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (result) setToast(result);
    } catch (err) {
      setToast(`匯出失敗：${(err as Error).message}`);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ── 畫面 ──────────────────────────────────────────

  const sel = selected ? layout.byId.get(selected) : undefined;
  // 拖曳中的節點與它底下的節點
  const dragged = useMemo(() => {
    if (!drag || !layout.byId.has(drag.id)) return undefined;
    const out = new Set<string>();
    const walk = (id: string) => {
      out.add(id);
      layout.byId.get(id)?.children.forEach(walk);
    };
    walk(drag.id);
    return out;
  }, [drag?.id, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const selNode = selected ? map.node(selected) : undefined;
  const horizontal = structure === "mindmap" || structure === "logic";
  const inset = theme.port && horizontal ? PORT_INSET : 0;
  const editingPlaced = editing ? layout.byId.get(editing.id) : undefined;
  const editStyle = editing ? data.styles.get(editing.id) : undefined;

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
          <button type="button" className="mm-btn" disabled={!selected} onClick={() => addChild()} title="新增子主題（Tab）">＋子主題</button>
          <button type="button" className="mm-btn" disabled={!selected} onClick={() => addSibling()} title="新增同層主題（Enter）">＋同層</button>
          <button type="button" className="mm-btn" disabled={!selected} onClick={() => selected && startEdit(selected)} title="編輯文字（F2、點兩下）">編輯</button>
          <button type="button" className="mm-btn" disabled={!selected || !map.children(selected).length} onClick={() => toggleCollapse()} title="收合／展開（空白鍵）">
            {selNode?.collapsed ? "展開" : "收合"}
          </button>
          <button type="button" className="mm-btn mm-btn--danger" disabled={!selected || selected === map.rootId} onClick={removeSelected} title="刪除（Delete）">刪除</button>
          <label className="mm-field">
            顏色
            <select
              aria-label="分支顏色"
              disabled={!selected}
              value={selNode?.color ?? ""}
              onChange={(e) => selected && act(() => map.setColor(selected, e.target.value || null))}
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
            disabled={!map.hasOffsets()}
            onClick={() => act(() => map.clearOffsets())}
            title="拖動過的主題回到自動排版的位置"
          >
            自動排列
          </button>
          <label className="mm-field">
            <select
              aria-label="匯出"
              value=""
              onChange={(e) => {
                const v = e.target.value as "png" | "svg" | "md" | "gugamap";
                e.target.value = "";
                if (v) void exportAs(v);
              }}
            >
              <option value="">匯出…</option>
              <option value="png">PNG 圖片</option>
              <option value="svg">SVG 圖片</option>
              <option value="md">Markdown 大綱</option>
              <option value="gugamap">心智圖檔（.gugamap）</option>
            </select>
          </label>
        </span>
      </div>

      <div
        ref={hostRef}
        className="mm-canvas"
        tabIndex={0}
        aria-label="心智圖畫布"
        style={{ background: theme.background }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg ref={svgRef} className="mm-svg" width="100%" height="100%">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.s})`}>
            <g ref={contentRef}>
              <MindMapContent data={data} dim={dragged} />
            </g>
            {/* 介面層：選取框、拖曳提示（不會匯出） */}
            <g className="mm-ui" pointerEvents="none">
              {sel && !drag && (
                <rect x={sel.x - 5} y={sel.y - 5} width={sel.width + 10} height={sel.height + 10} rx={10} fill="none" stroke={theme.accent} strokeWidth={2 / view.s} data-selected={sel.id} />
              )}
              {drag?.target && <DropHint layout={layout} target={drag.target} color={theme.accent} s={view.s} />}
              {/* 拖曳預覽：整個子樹跟著移動 */}
              {drag &&
                [...(dragged ?? [])].map((id) => {
                  const pl = layout.byId.get(id)!;
                  return (
                    <NodeShape
                      key={id}
                      placed={{ ...pl, x: pl.x + drag.dx, y: pl.y + drag.dy }}
                      node={data.nodes.get(id)!}
                      style={data.styles.get(id)!}
                      theme={theme}
                      inset={inset}
                      portColor={theme.port}
                      structure={structure}
                      ghost
                    />
                  );
                })}
            </g>
          </g>
        </svg>

        {editing && editingPlaced && editStyle && (
          <textarea
            className="mm-edit"
            aria-label="主題文字"
            autoFocus
            value={editing.text}
            rows={Math.max(1, editing.text.split("\n").length)}
            style={{
              left: editingPlaced.x * view.s + view.x,
              top: editingPlaced.y * view.s + view.y,
              minWidth: Math.max(editingPlaced.width * view.s, 140),
              minHeight: editingPlaced.height * view.s,
              fontSize: editStyle.fontSize * view.s,
              fontWeight: editStyle.fontWeight,
              fontFamily: FONT,
            }}
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

        {toast && <div className="mm-toast" role="status">{toast}</div>}
        <p className="mm-hint">點兩下編輯 · Tab 子主題 · Enter 同層 · 拖到主題上換位置、拖到空白處自由放置 · 拖曳空白處移動畫面</p>
      </div>
    </div>
  );
}

/** `id` 是否在 `ancestor` 底下（依排版的父子關係） */
function isBelow(layout: ReturnType<typeof layoutTree>, ancestor: string, id: string): boolean {
  for (let p = layout.byId.get(id)?.parent ?? null; p; p = layout.byId.get(p)?.parent ?? null) if (p === ancestor) return true;
  return false;
}

function DropHint({ layout, target, color, s }: { layout: ReturnType<typeof layoutTree>; target: DropTarget; color: string; s: number }) {
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
