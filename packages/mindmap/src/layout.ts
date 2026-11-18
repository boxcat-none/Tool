import type { Structure, TreeNode } from "./model";

/**
 * 自動排版：輸入心智圖的樹與每個節點的大小，算出每個節點的位置（畫面 px，y 向下）。
 * 和畫面無關（大小由呼叫端量好傳進來），所以可以單元測試。
 *
 *   mindmap  中心主題在中間，第一層分支平均分到左右兩邊（依子樹高度平衡）
 *   logic    由左往右展開
 *   org      由上往下展開（組織圖）
 *   tree     像大綱一樣往下縮排
 */

export interface Size {
  width: number;
  height: number;
}

export interface Placed {
  id: string;
  parent: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  /** 長在中心主題的哪一邊：1 = 右（或下）、-1 = 左；中心主題 = 0 */
  side: 1 | -1 | 0;
  /** 屬於第幾條第一層分支（決定分支顏色）；中心主題 = -1 */
  branch: number;
  /** 子節點（依順序） */
  children: string[];
  /** 收合時底下藏了幾個節點 */
  hidden: number;
}

export interface Layout {
  structure: Structure;
  nodes: Placed[];
  byId: Map<string, Placed>;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface Spacing {
  /** 層與層之間 */
  level: number;
  /** 兄弟之間 */
  sibling: number;
}

const DEFAULT_SPACING: Record<Structure, Spacing> = {
  mindmap: { level: 44, sibling: 12 },
  logic: { level: 40, sibling: 10 },
  org: { level: 36, sibling: 16 },
  tree: { level: 28, sibling: 8 },
};

export function layoutTree(
  tree: TreeNode,
  measure: (node: TreeNode, depth: number) => Size,
  structure: Structure,
  spacing: Spacing = DEFAULT_SPACING[structure],
): Layout {
  const sizes = new Map<string, Size>();
  const sizeOf = (n: TreeNode, depth: number) => {
    let s = sizes.get(n.id);
    if (!s) sizes.set(n.id, (s = measure(n, depth)));
    return s;
  };
  const out = new Map<string, Placed>();
  const put = (n: TreeNode, parent: string | null, x: number, y: number, depth: number, side: Placed["side"], branch: number) => {
    const s = sizeOf(n, depth);
    out.set(n.id, { id: n.id, parent, x, y, width: s.width, height: s.height, depth, side, branch, children: n.children.map((c) => c.id), hidden: n.hidden });
  };

  if (structure === "tree") {
    let cursor = 0;
    const walk = (n: TreeNode, parent: string | null, x: number, depth: number, branch: number) => {
      put(n, parent, x, cursor, depth, depth ? 1 : 0, branch);
      cursor += sizeOf(n, depth).height + spacing.sibling;
      n.children.forEach((c, i) => walk(c, n.id, x + spacing.level, depth + 1, depth === 0 ? i : branch));
    };
    walk(tree, null, 0, 0, -1);
    return finish(out, structure, tree);
  }

  const vertical = structure === "org";
  // 主軸 = 往外長的方向，交叉軸 = 兄弟排列的方向
  const main = (s: Size) => (vertical ? s.height : s.width);
  const cross = (s: Size) => (vertical ? s.width : s.height);
  const extents = new Map<string, number>();
  const extent = (n: TreeNode, depth: number): number => {
    let e = extents.get(n.id);
    if (e === undefined) {
      const kids = n.children.reduce((sum, c) => sum + extent(c, depth + 1), 0) + spacing.sibling * Math.max(0, n.children.length - 1);
      extents.set(n.id, (e = Math.max(cross(sizeOf(n, depth)), kids)));
    }
    return e;
  };

  /**
   * 排一個子樹：`anchor` 是節點靠近父節點那一邊在主軸上的位置，`center` 是節點中心在交叉軸上的位置。
   * dir = 1 往右（下）長，-1 往左長。
   */
  const place = (n: TreeNode, parent: string | null, anchor: number, center: number, depth: number, dir: 1 | -1, branch: number) => {
    const s = sizeOf(n, depth);
    const mainPos = dir === 1 ? anchor : anchor - main(s);
    const crossPos = center - cross(s) / 2;
    put(n, parent, vertical ? crossPos : mainPos, vertical ? mainPos : crossPos, depth, depth ? dir : 0, branch);
    placeChildren(n, n.children, dir === 1 ? mainPos + main(s) + spacing.level : mainPos - spacing.level, center, depth, dir, branch);
  };
  const placeChildren = (n: TreeNode, kids: TreeNode[], anchor: number, center: number, depth: number, dir: 1 | -1, branch: number) => {
    const total = kids.reduce((sum, c) => sum + extent(c, depth + 1), 0) + spacing.sibling * Math.max(0, kids.length - 1);
    let cursor = center - total / 2;
    for (const c of kids) {
      const e = extent(c, depth + 1);
      place(c, n.id, anchor, cursor + e / 2, depth + 1, dir, depth === 0 ? n.children.indexOf(c) : branch);
      cursor += e + spacing.sibling;
    }
  };

  if (structure === "mindmap") {
    const s = sizeOf(tree, 0);
    put(tree, null, -s.width / 2, -s.height / 2, 0, 0, -1);
    const [right, left] = splitSides(tree.children.map((c) => extent(c, 1)));
    const rightKids = right.map((i) => tree.children[i]);
    // 左邊由下往上排（順時針閱讀：右上 → 右下 → 左下 → 左上）
    const leftKids = left.map((i) => tree.children[i]).reverse();
    placeChildren(tree, rightKids, s.width / 2 + spacing.level, 0, 0, 1, -1);
    placeChildren(tree, leftKids, -s.width / 2 - spacing.level, 0, 0, -1, -1);
  } else {
    place(tree, null, 0, 0, 0, 1, -1);
  }
  return finish(out, structure, tree);
}

/**
 * 整張圖：中心元件的樹＋每個獨立元件（沒有連到任何元件）的樹。
 * 獨立元件放在自己的 at（左上角），它底下的元件往右（組織圖往下）展開；深度從 1 算起（外觀和一般元件一樣）。
 */
export function layoutForest(
  main: TreeNode,
  floating: (TreeNode & { at: [number, number] })[],
  measure: (node: TreeNode, depth: number) => Size,
  structure: Structure,
): Layout {
  const base = layoutTree(main, measure, structure);
  if (!floating.length) return base;
  const out = new Map(base.byId);
  const nodes = [...base.nodes];
  const sub: Structure = structure === "mindmap" ? "logic" : structure;
  floating.forEach((f, i) => {
    const l = layoutTree(f, (n, d) => measure(n, d + 1), sub);
    const top = l.byId.get(f.id)!;
    const dx = f.at[0] - top.x;
    const dy = f.at[1] - top.y;
    const branch = main.children.length + i;
    for (const n of l.nodes) {
      const p: Placed = { ...n, x: n.x + dx, y: n.y + dy, depth: n.depth + 1, side: 1, branch };
      out.set(p.id, p);
      nodes.push(p);
    }
  });
  return finish(out, structure, undefined, nodes);
}

/** 第一層分支分到右邊和左邊：依序放右邊，直到右邊的高度超過一半 */
export function splitSides(extents: number[]): [number[], number[]] {
  const total = extents.reduce((a, b) => a + b, 0);
  const right: number[] = [];
  let acc = 0;
  for (let i = 0; i < extents.length; i++) {
    if (right.length && acc + extents[i] / 2 > total / 2) break;
    right.push(i);
    acc += extents[i];
  }
  const left = extents.map((_, i) => i).filter((i) => !right.includes(i));
  return [right, left];
}

/** 拖曳預覽：把某些節點暫時移動 (dx, dy)，回傳新的排版（原本的不變），連接線就能跟著畫 */
export function moveNodes(layout: Layout, ids: Iterable<string>, dx: number, dy: number): Layout {
  const set = new Set(ids);
  if (!set.size || (!dx && !dy)) return layout;
  const byId = new Map<string, Placed>();
  const nodes = layout.nodes.map((n) => {
    const p = set.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n;
    byId.set(p.id, p);
    return p;
  });
  return finish(byId, layout.structure, undefined, nodes);
}

/** 節點和它底下所有節點的代號 */
export function subtreeIds(layout: Layout, roots: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    layout.byId.get(id)?.children.forEach(walk);
  };
  for (const r of roots) if (layout.byId.has(r)) walk(r);
  return out;
}

/** 只留下最上層的（祖先也在清單裡的拿掉）：一起拖動時子樹不會被移動兩次 */
export function topmost(layout: Layout, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  return [...set].filter((id) => {
    for (let p = layout.byId.get(id)?.parent ?? null; p; p = layout.byId.get(p)?.parent ?? null) if (set.has(p)) return false;
    return true;
  });
}

/** 框選：和矩形 [x0, y0, x1, y1]（任意方向）重疊的節點 */
export function nodesInRect(layout: Layout, rect: [number, number, number, number]): string[] {
  const [ax, bx] = rect[0] < rect[2] ? [rect[0], rect[2]] : [rect[2], rect[0]];
  const [ay, by] = rect[1] < rect[3] ? [rect[1], rect[3]] : [rect[3], rect[1]];
  return layout.nodes.filter((n) => n.x < bx && n.x + n.width > ax && n.y < by && n.y + n.height > ay).map((n) => n.id);
}

/** 線段 (x1,y1)-(x2,y2) 是否穿過矩形（框選線條用；曲線用兩端點的直線近似） */
export function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, rect: [number, number, number, number]): boolean {
  const [ax, bx] = rect[0] < rect[2] ? [rect[0], rect[2]] : [rect[2], rect[0]];
  const [ay, by] = rect[1] < rect[3] ? [rect[1], rect[3]] : [rect[3], rect[1]];
  // Liang–Barsky 裁切
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - ax], [dx, bx - x1], [-dy, y1 - ay], [dy, by - y1]] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
  }
  return true;
}

/** 套用自由拖動的位移：節點和它底下的節點一起移動 */
function applyOffsets(out: Map<string, Placed>, tree: TreeNode) {
  const walk = (n: TreeNode, dx: number, dy: number) => {
    const ox = dx + (n.offset?.[0] ?? 0);
    const oy = dy + (n.offset?.[1] ?? 0);
    const p = out.get(n.id);
    if (p && (ox || oy)) {
      p.x += ox;
      p.y += oy;
    }
    for (const c of n.children) walk(c, ox, oy);
  };
  walk(tree, 0, 0);
}

function finish(out: Map<string, Placed>, structure: Structure, tree?: TreeNode, ordered?: Placed[]): Layout {
  if (tree) applyOffsets(out, tree);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of out.values()) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height);
  }
  return { structure, nodes: ordered ?? [...out.values()], byId: out, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

// ── 連接線 ──────────────────────────────────────────

export type EdgeStyle = "curve" | "elbow" | "straight";

export interface EdgeOptions {
  /** 子節點畫成底線：線接到底線上，而不是框的中間 */
  underline?: boolean;
  /** 卡片的連接點離左右（組織圖是上下）邊緣多遠：線從連接點拉出、接到連接點 */
  portInset?: number;
}

/** 父節點到子節點的連接線（SVG path） */
export function edgePath(layout: Layout, parent: Placed, child: Placed, style: EdgeStyle, opts: EdgeOptions = {}): string {
  const underline = !!opts.underline;
  const inset = opts.portInset ?? 0;
  const r = (v: number) => Math.round(v * 10) / 10;
  if (layout.structure === "tree") {
    const sx = parent.x + Math.min(14, parent.width / 2);
    const sy = parent.y + parent.height;
    const ey = underline ? child.y + child.height : child.y + child.height / 2;
    if (style === "curve") return `M${r(sx)} ${r(sy)}V${r(ey - 8)}Q${r(sx)} ${r(ey)} ${r(sx + 8)} ${r(ey)}H${r(child.x)}`;
    return `M${r(sx)} ${r(sy)}V${r(ey)}H${r(child.x)}`;
  }
  if (layout.structure === "org") {
    const sx = parent.x + parent.width / 2;
    const sy = parent.y + parent.height - (parent.depth ? inset : 0);
    const ex = child.x + child.width / 2;
    const ey = child.y + inset;
    const my = (sy + ey) / 2;
    if (style === "straight") return `M${r(sx)} ${r(sy)}L${r(ex)} ${r(ey)}`;
    if (style === "elbow") return `M${r(sx)} ${r(sy)}V${r(my)}H${r(ex)}V${r(ey)}`;
    return `M${r(sx)} ${r(sy)}C${r(sx)} ${r(my)} ${r(ex)} ${r(my)} ${r(ex)} ${r(ey)}`;
  }
  // 方向依實際位置決定（自由拖到另一邊時，線從另一側出來）
  const dir = child.x + child.width / 2 >= parent.x + parent.width / 2 ? 1 : -1;
  const parentUnder = underline && parent.depth > 0;
  // 中心主題沒有連接點（線從邊上出來）
  const pIn = parent.depth ? inset : 0;
  const sx = dir === 1 ? parent.x + parent.width - pIn : parent.x + pIn;
  const sy = parentUnder ? parent.y + parent.height : parent.y + parent.height / 2;
  const ex = dir === 1 ? child.x + inset : child.x + child.width - inset;
  const ey = underline ? child.y + child.height : child.y + child.height / 2;
  const mx = (sx + ex) / 2;
  if (style === "straight") return `M${r(sx)} ${r(sy)}L${r(ex)} ${r(ey)}`;
  if (style === "elbow") return `M${r(sx)} ${r(sy)}H${r(mx)}V${r(ey)}H${r(ex)}`;
  return `M${r(sx)} ${r(sy)}C${r(mx)} ${r(sy)} ${r(mx)} ${r(ey)} ${r(ex)} ${r(ey)}`;
}

/**
 * 手拉的連接線：從 a 朝向 b 的那一側連到 b 朝向 a 的那一側（組織圖用上下，其他結構用左右）。
 * 中心元件（深度 0）沒有連接點，線從邊上出來。
 */
export function linkPath(layout: Layout, a: Placed, b: Placed, style: EdgeStyle, opts: EdgeOptions = {}): string {
  const r = (v: number) => Math.round(v * 10) / 10;
  const inset = opts.portInset ?? 0;
  const inA = a.depth ? inset : 0;
  const inB = b.depth ? inset : 0;
  if (layout.structure === "org") {
    const down = b.y + b.height / 2 >= a.y + a.height / 2;
    const sx = a.x + a.width / 2, ex = b.x + b.width / 2;
    const sy = down ? a.y + a.height - inA : a.y + inA;
    const ey = down ? b.y + inB : b.y + b.height - inB;
    const my = (sy + ey) / 2;
    if (style === "straight") return `M${r(sx)} ${r(sy)}L${r(ex)} ${r(ey)}`;
    if (style === "elbow") return `M${r(sx)} ${r(sy)}V${r(my)}H${r(ex)}V${r(ey)}`;
    return `M${r(sx)} ${r(sy)}C${r(sx)} ${r(my)} ${r(ex)} ${r(my)} ${r(ex)} ${r(ey)}`;
  }
  const right = b.x + b.width / 2 >= a.x + a.width / 2;
  const sx = right ? a.x + a.width - inA : a.x + inA;
  const ex = right ? b.x + inB : b.x + b.width - inB;
  const sy = a.y + a.height / 2, ey = b.y + b.height / 2;
  const mx = (sx + ex) / 2;
  if (style === "straight") return `M${r(sx)} ${r(sy)}L${r(ex)} ${r(ey)}`;
  if (style === "elbow") return `M${r(sx)} ${r(sy)}H${r(mx)}V${r(ey)}H${r(ex)}`;
  return `M${r(sx)} ${r(sy)}C${r(mx)} ${r(sy)} ${r(mx)} ${r(ey)} ${r(ex)} ${r(ey)}`;
}

// ── 拖曳放下、方向鍵移動 ─────────────────────────────

export interface DropTarget {
  parent: string;
  /** 放到 parent 的第幾個子節點（以拿掉被拖曳的節點後計算） */
  index: number;
  /** 畫提示用：放在哪個節點上、哪個位置 */
  over: string;
  where: "child" | "before" | "after";
}

/**
 * 拖曳節點放下的位置：放在節點中間 = 變成它的子節點；放在節點靠前／靠後的四分之一 = 插在它前面／後面。
 * 不能放到自己或自己的子孫上。
 */
export function dropTarget(layout: Layout, dragging: string, x: number, y: number, slop = 6): DropTarget | null {
  const isInside = (id: string) => {
    for (let p: string | null = id; p; p = layout.byId.get(p)?.parent ?? null) if (p === dragging) return true;
    return false;
  };
  // 上面的節點優先（後畫的在上面），所以倒著找
  for (let i = layout.nodes.length - 1; i >= 0; i--) {
    const n = layout.nodes[i];
    if (x < n.x - slop || x > n.x + n.width + slop || y < n.y - slop || y > n.y + n.height + slop) continue;
    if (isInside(n.id)) return null;
    const append = (parent: Placed): DropTarget => ({ parent: parent.id, index: parent.children.filter((c) => c !== dragging).length, over: parent.id, where: "child" });
    if (!n.parent) return append(n);
    const f = layout.structure === "org" ? (x - n.x) / n.width : (y - n.y) / n.height;
    if (f > 0.25 && f < 0.75) return append(n);
    const parent = layout.byId.get(n.parent)!;
    const sibs = parent.children.filter((c) => c !== dragging);
    let index = sibs.indexOf(n.id);
    // 左邊的分支是由下往上排的，「前面」在畫面上是下面
    const flipped = layout.structure === "mindmap" && n.side === -1 && parent.depth === 0;
    const after = flipped ? f <= 0.25 : f >= 0.75;
    if (after) index++;
    return { parent: parent.id, index, over: n.id, where: f >= 0.75 ? "after" : "before" };
  }
  return null;
}

/** 方向鍵：往那個方向最近的節點（在 45 度範圍內，偏離方向的距離加重計算） */
export function neighbor(layout: Layout, from: string, dir: "left" | "right" | "up" | "down"): string | null {
  const a = layout.byId.get(from);
  if (!a) return null;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const n of layout.nodes) {
    if (n.id === from) continue;
    const dx = n.x + n.width / 2 - ax;
    const dy = n.y + n.height / 2 - ay;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const off = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || off > along * 1.5) continue;
    const score = along + off * 2;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}
