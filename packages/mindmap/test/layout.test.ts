import { describe, expect, it } from "vitest";
import { branchColors, dropTarget, edgePath, layoutForest, layoutTree, linkPath, MindMap, moveNodes, neighbor, nodesInRect, segmentHitsRect, splitSides, subtreeIds, themeById, THEMES, topmost, type Layout, type Structure } from "../src";

const measure = () => ({ width: 80, height: 20 });

function sample() {
  const m = MindMap.create("中心");
  const r = m.rootId;
  const ids = ["一", "二", "三", "四"].map((t) => m.addChild(r, t));
  const kids = ["甲", "乙", "丙"].map((t) => m.addChild(ids[0], t));
  return { m, r, ids, kids };
}

const overlaps = (l: Layout) => {
  const ns = l.nodes;
  for (let i = 0; i < ns.length; i++)
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return [a.id, b.id];
    }
  return null;
};

describe("layoutTree", () => {
  for (const s of ["mindmap", "logic", "org", "tree"] as Structure[]) {
    it(`${s}：所有節點都有位置，而且互不重疊`, () => {
      const { m } = sample();
      const l = layoutTree(m.tree(), measure, s);
      expect(l.nodes).toHaveLength(m.size);
      expect(overlaps(l)).toBeNull();
      expect(l.bounds.width).toBeGreaterThan(0);
    });
  }

  it("mindmap：中心主題置中，分支分在左右兩邊；左邊在中心左側", () => {
    const { m, r, ids } = sample();
    const l = layoutTree(m.tree(), measure, "mindmap");
    const root = l.byId.get(r)!;
    expect(root.x + root.width / 2).toBe(0);
    const sides = ids.map((id) => l.byId.get(id)!.side);
    expect(sides).toContain(1);
    expect(sides).toContain(-1);
    for (const id of ids) {
      const n = l.byId.get(id)!;
      if (n.side === 1) expect(n.x).toBeGreaterThan(root.x + root.width);
      else expect(n.x + n.width).toBeLessThan(root.x);
    }
    // 子節點跟著父節點在同一邊、同一條分支
    for (const k of l.byId.get(ids[0])!.children) {
      expect(l.byId.get(k)!.side).toBe(l.byId.get(ids[0])!.side);
      expect(l.byId.get(k)!.branch).toBe(0);
    }
  });

  it("splitSides 依子樹高度平衡，右邊至少一個", () => {
    expect(splitSides([100, 20, 20, 20, 20, 20])).toEqual([[0], [1, 2, 3, 4, 5]]);
    expect(splitSides([10, 10, 10, 10])).toEqual([[0, 1], [2, 3]]);
    expect(splitSides([10])).toEqual([[0], []]);
    expect(splitSides([])).toEqual([[], []]);
  });

  it("logic：子節點都在父節點右邊，兄弟由上往下排", () => {
    const { m, r, ids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    const root = l.byId.get(r)!;
    const ys = ids.map((id) => l.byId.get(id)!.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    for (const id of ids) expect(l.byId.get(id)!.x).toBeGreaterThan(root.x + root.width);
  });

  it("org：子節點在父節點下面，兄弟由左往右排", () => {
    const { m, r, ids } = sample();
    const l = layoutTree(m.tree(), measure, "org");
    const root = l.byId.get(r)!;
    const xs = ids.map((id) => l.byId.get(id)!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    for (const id of ids) expect(l.byId.get(id)!.y).toBeGreaterThan(root.y + root.height);
  });

  it("tree：依大綱順序往下排，每層往右縮排", () => {
    const { m, ids, kids } = sample();
    const l = layoutTree(m.tree(), measure, "tree");
    const order = [...l.nodes].sort((a, b) => a.y - b.y).map((n) => n.id);
    expect(order.slice(1, 5)).toEqual([ids[0], ...kids]);
    expect(l.byId.get(kids[0])!.x).toBeGreaterThan(l.byId.get(ids[0])!.x);
  });

  it("自由拖動：節點和它底下的節點一起移動，其他節點不動", () => {
    const { m, r, ids, kids } = sample();
    const before = layoutTree(m.tree(), measure, "logic");
    m.setOffset(ids[0], [100, -50]);
    const after = layoutTree(m.tree(), measure, "logic");
    const moved = (id: string) => [after.byId.get(id)!.x - before.byId.get(id)!.x, after.byId.get(id)!.y - before.byId.get(id)!.y];
    expect(moved(ids[0])).toEqual([100, -50]);
    for (const k of kids) expect(moved(k)).toEqual([100, -50]);
    expect(moved(r)).toEqual([0, 0]);
    expect(moved(ids[1])).toEqual([0, 0]);
    // 子節點自己也拖過：位移相加
    m.setOffset(kids[0], [0, 10]);
    expect(layoutTree(m.tree(), measure, "logic").byId.get(kids[0])!.y - before.byId.get(kids[0])!.y).toBe(-40);
    // 範圍跟著擴大
    expect(after.bounds.x + after.bounds.width).toBeGreaterThan(before.bounds.x + before.bounds.width);
  });

  it("拖到中心主題另一側時，線從另一側出來", () => {
    const { m, r, ids } = sample();
    const l0 = layoutTree(m.tree(), measure, "logic");
    m.setOffset(ids[1], [-(l0.byId.get(ids[1])!.x - l0.byId.get(r)!.x) - 200, 0]);
    const l = layoutTree(m.tree(), measure, "logic");
    const root = l.byId.get(r)!;
    const child = l.byId.get(ids[1])!;
    expect(child.x + child.width).toBeLessThan(root.x);
    expect(edgePath(l, root, child, "straight")).toBe(`M${root.x} ${root.y + root.height / 2}L${child.x + child.width} ${child.y + child.height / 2}`);
  });

  it("拖曳預覽 moveNodes：只移動指定的節點，原本的排版不變", () => {
    const { m, ids, kids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    const group = subtreeIds(l, [ids[0]]);
    expect([...group].sort()).toEqual([ids[0], ...kids].sort());
    const moved = moveNodes(l, group, 30, -10);
    expect(moved.byId.get(kids[0])!.x).toBe(l.byId.get(kids[0])!.x + 30);
    expect(moved.byId.get(ids[1])).toBe(l.byId.get(ids[1]));
    expect(moved.nodes.map((n) => n.id)).toEqual(l.nodes.map((n) => n.id));
    expect(l.byId.get(kids[0])!.x).not.toBe(moved.byId.get(kids[0])!.x);
    expect(moveNodes(l, group, 0, 0)).toBe(l);
  });

  it("topmost：祖先也選了的節點拿掉（一起拖動時不會移動兩次）", () => {
    const { m, r, ids, kids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    expect(topmost(l, [kids[0], ids[0], ids[1]]).sort()).toEqual([ids[0], ids[1]].sort());
    expect(topmost(l, [r, ids[2]])).toEqual([r]);
  });

  it("框選：矩形碰到的節點；線段是否穿過矩形", () => {
    const { m, ids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    const a = l.byId.get(ids[1])!;
    const b = l.byId.get(ids[2])!;
    // 反方向拉的框也可以
    expect(nodesInRect(l, [b.x + b.width - 1, b.y + b.height - 1, a.x + 1, a.y + 1]).sort()).toEqual([ids[1], ids[2]].sort());
    expect(nodesInRect(l, [9000, 9000, 9100, 9100])).toEqual([]);
    expect(segmentHitsRect(0, 0, 100, 100, [40, 40, 60, 60])).toBe(true);
    expect(segmentHitsRect(0, 0, 100, 0, [40, 10, 60, 20])).toBe(false);
    expect(segmentHitsRect(50, 50, 55, 55, [40, 40, 60, 60])).toBe(true);
    expect(segmentHitsRect(0, 100, 100, 0, [0, 0, 20, 20])).toBe(false);
  });

  it("收合的節點：子節點不排版", () => {
    const { m, ids } = sample();
    m.setCollapsed(ids[0], true);
    const l = layoutTree(m.tree(), measure, "logic");
    expect(l.nodes).toHaveLength(5);
    expect(l.byId.get(ids[0])!.hidden).toBe(3);
  });

  it("連接線：各種結構與樣式都產生路徑，起點在父節點邊上", () => {
    const { m, r, ids } = sample();
    for (const s of ["mindmap", "logic", "org", "tree"] as Structure[]) {
      const l = layoutTree(m.tree(), measure, s);
      for (const style of ["curve", "elbow", "straight"] as const) {
        const d = edgePath(l, l.byId.get(r)!, l.byId.get(ids[0])!, style);
        expect(d).toMatch(/^M-?[\d.]+ -?[\d.]+/);
      }
    }
    const l = layoutTree(m.tree(), measure, "logic");
    const root = l.byId.get(r)!;
    expect(edgePath(l, root, l.byId.get(ids[0])!, "straight").startsWith(`M${root.x + root.width} ${root.y + root.height / 2}`)).toBe(true);
  });

  it("節點卡片：線從父卡片的連接點拉出，接到子卡片的連接點（中心主題從邊上出來）", () => {
    const { m, r, ids, kids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    const a = l.byId.get(ids[0])!;
    const k = l.byId.get(kids[0])!;
    const d = edgePath(l, a, k, "straight", { portInset: 13 });
    expect(d).toBe(`M${a.x + a.width - 13} ${a.y + a.height / 2}L${k.x + 13} ${k.y + k.height / 2}`);
    const root = l.byId.get(r)!;
    expect(edgePath(l, root, a, "straight", { portInset: 13 }).startsWith(`M${root.x + root.width} `)).toBe(true);
  });
});

describe("拖曳放下", () => {
  it("放在節點中間 = 變成子節點；靠上／靠下 = 插在前面／後面；不能放在自己的子孫上", () => {
    const { m, r, ids, kids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    const at = (id: string, f: number) => {
      const n = l.byId.get(id)!;
      return [n.x + n.width / 2, n.y + n.height * f] as const;
    };
    expect(dropTarget(l, ids[3], ...at(ids[1], 0.5))).toMatchObject({ parent: ids[1], index: 0, where: "child" });
    expect(dropTarget(l, ids[3], ...at(ids[1], 0.1))).toMatchObject({ parent: r, index: 1, where: "before" });
    expect(dropTarget(l, ids[3], ...at(ids[1], 0.9))).toMatchObject({ parent: r, index: 2, where: "after" });
    // 拖曳中的節點不算在 index 裡
    expect(dropTarget(l, ids[0], ...at(ids[2], 0.9))).toMatchObject({ parent: r, index: 2 });
    expect(dropTarget(l, ids[0], ...at(kids[1], 0.5))).toBeNull();
    expect(dropTarget(l, ids[0], ...at(ids[0], 0.5))).toBeNull();
    // 放在中心主題上：加到最後
    expect(dropTarget(l, kids[0], ...at(r, 0.1))).toMatchObject({ parent: r, index: 4 });
    // 空白處
    expect(dropTarget(l, kids[0], 9999, 9999)).toBeNull();
  });

  it("放下的結果交給 move 後，節點真的到那個位置", () => {
    const { m, r, ids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    const n = l.byId.get(ids[1])!;
    const t = dropTarget(l, ids[3], n.x + 5, n.y + 1)!;
    m.move(ids[3], t.parent, t.index);
    expect(m.children(r)).toEqual([ids[0], ids[3], ids[1], ids[2]]);
  });

  it("org 結構用左右判斷前後", () => {
    const { m, r, ids } = sample();
    const l = layoutTree(m.tree(), measure, "org");
    const n = l.byId.get(ids[1])!;
    expect(dropTarget(l, ids[3], n.x + 2, n.y + n.height / 2)).toMatchObject({ parent: r, where: "before" });
    expect(dropTarget(l, ids[3], n.x + n.width - 2, n.y + n.height / 2)).toMatchObject({ parent: r, where: "after" });
  });
});

describe("方向鍵", () => {
  it("logic：右 = 子節點、左 = 父節點、上下 = 兄弟", () => {
    const { m, r, ids, kids } = sample();
    const l = layoutTree(m.tree(), measure, "logic");
    expect(neighbor(l, r, "right")).not.toBeNull();
    expect(neighbor(l, ids[0], "left")).toBe(r);
    expect(neighbor(l, ids[0], "right")).toBe(kids[1]);
    expect(neighbor(l, ids[1], "up")).toBe(ids[0]);
    expect(neighbor(l, ids[1], "down")).toBe(ids[2]);
    expect(neighbor(l, r, "left")).toBeNull();
  });
});

describe("主題", () => {
  it("五種主題都有，找不到時用第一個", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["rainbow", "minimal", "boxed", "sketch", "node"]);
    expect(themeById("nope").id).toBe("rainbow");
    for (const t of THEMES) for (const d of [0, 1, 2, 5]) expect(t.style(d, "#123456").fontSize).toBeGreaterThan(10);
  });

  it("分支顏色：第一層依序取色，子節點跟著；自訂顏色往下傳", () => {
    const { m, ids, kids } = sample();
    const theme = themeById("rainbow");
    m.setColor(kids[1], "#000000");
    const c = branchColors(m.tree(), theme);
    expect(c.get(ids[0])).toBe(theme.palette[0]);
    expect(c.get(ids[1])).toBe(theme.palette[1]);
    expect(c.get(kids[0])).toBe(theme.palette[0]);
    expect(c.get(kids[1])).toBe("#000000");
  });
});

describe("layoutForest（獨立元件）", () => {
  it("獨立元件放在自己的位置，深度從 1 算，子元件往右展開，不和中心的樹重疊", () => {
    const { m } = sample();
    const f = m.addFloating("獨立", [600, 300]);
    const k = m.addChild(f, "子");
    const l = layoutForest(m.tree("mindmap"), m.floating("mindmap"), measure, "mindmap");
    const p = l.byId.get(f)!;
    expect([p.x, p.y]).toEqual([600, 300]);
    expect(p.parent).toBeNull();
    expect(p.depth).toBe(1);
    const c = l.byId.get(k)!;
    expect(c.parent).toBe(f);
    expect(c.depth).toBe(2);
    expect(c.x).toBeGreaterThan(p.x + p.width);
    expect(overlaps(l)).toBeNull();
    expect(l.bounds.x + l.bounds.width).toBeGreaterThanOrEqual(c.x + c.width);
  });

  it("沒有獨立元件時和 layoutTree 一樣", () => {
    const { m } = sample();
    const a = layoutTree(m.tree(), measure, "org");
    const b = layoutForest(m.tree(), [], measure, "org");
    expect(b.nodes.map((n) => [n.id, n.x, n.y])).toEqual(a.nodes.map((n) => [n.id, n.x, n.y]));
  });

  it("分支顏色：獨立元件接在第一層分支後面輪流用", () => {
    const { m, ids } = sample();
    const f = m.addFloating("F", [0, 0]);
    const theme = themeById("rainbow");
    const c = branchColors(m.tree(), theme, m.floating());
    expect(c.get(f)).toBe(theme.palette[ids.length % theme.palette.length]);
  });
});

describe("linkPath（手拉的線）", () => {
  it("從起點朝向終點的那一側出發，接到終點朝向起點的那一側", () => {
    const { m, ids } = sample();
    const l = layoutTree(m.tree(), measure, "mindmap");
    const right = l.byId.get(ids[0])!;
    const left = [...l.nodes].find((n) => n.side === -1)!;
    const d = linkPath(l, right, left, "straight");
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(nums[0]).toBeCloseTo(right.x);
    expect(nums[2]).toBeCloseTo(left.x + left.width);
    const org = layoutTree(m.tree(), measure, "org");
    const a = org.byId.get(ids[0])!, b = org.byId.get(m.children(ids[0])[0])!;
    const v = linkPath(org, a, b, "straight").match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(v[1]).toBeCloseTo(a.y + a.height);
    expect(v[3]).toBeCloseTo(b.y);
  });
});
