import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MindMap, openMindMapFile, parseOutline, saveMindMapFile } from "../src";

const LOCAL = "this-device";
const texts = (m: MindMap, id: string) => m.children(id).map((c) => m.node(c)!.text);
const clone = (m: MindMap) => {
  const o = new MindMap();
  Y.applyUpdate(o.doc, Y.encodeStateAsUpdate(m.doc));
  return o;
};
const sync = (a: MindMap, b: MindMap) => {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
};

function sample() {
  const m = MindMap.create("專案");
  const r = m.rootId;
  const a = m.addChild(r, "目標");
  const b = m.addChild(r, "時程");
  const c = m.addChild(r, "風險");
  const a1 = m.addChild(a, "營收");
  const a2 = m.addChild(a, "使用者");
  return { m, r, a, b, c, a1, a2 };
}

describe("MindMap 基本操作", () => {
  it("建立時有中心主題，預設心智圖結構與節點卡片主題", () => {
    const m = MindMap.create("讀書計畫");
    expect(m.size).toBe(1);
    expect(m.node(m.rootId)).toMatchObject({ text: "讀書計畫", parent: null, collapsed: false });
    expect(m.structure).toBe("mindmap");
    expect(m.theme).toBe("node");
  });

  it("新增子節點、同層節點（前、後），順序正確", () => {
    const { m, r, a, b } = sample();
    expect(texts(m, r)).toEqual(["目標", "時程", "風險"]);
    m.addSibling(a, "前面", true);
    m.addSibling(b, "後面");
    expect(texts(m, r)).toEqual(["前面", "目標", "時程", "後面", "風險"]);
    m.addChild(r, "第一個", 0);
    expect(texts(m, r)[0]).toBe("第一個");
    // 中心主題的「同層」= 子節點
    const x = m.addSibling(r, "子");
    expect(m.parentOf(x)).toBe(r);
  });

  it("改文字、顏色、收合；在收合的節點底下新增會自動展開", () => {
    const { m, a } = sample();
    m.setText(a, "新目標");
    m.setColor(a, "#ff0000");
    expect(m.node(a)).toMatchObject({ text: "新目標", color: "#ff0000" });
    m.setColor(a, null);
    expect(m.node(a)!.color).toBeUndefined();
    m.setCollapsed(a, true);
    expect(m.node(a)!.collapsed).toBe(true);
    m.addChild(a, "再一個");
    expect(m.node(a)!.collapsed).toBe(false);
  });

  it("刪除節點會一起刪掉底下所有節點；中心主題不能刪", () => {
    const { m, r, a, a1 } = sample();
    m.addChild(a1, "孫");
    m.remove([a, r]);
    expect(m.has(a)).toBe(false);
    expect(m.size).toBe(3); // 中心主題 + 時程 + 風險
    expect(texts(m, r)).toEqual(["時程", "風險"]);
  });

  it("移動到其他父節點、指定位置；不能移到自己的子孫底下", () => {
    const { m, r, a, b, c, a1 } = sample();
    expect(m.move(c, a, 0)).toBe(true);
    expect(texts(m, a)).toEqual(["風險", "營收", "使用者"]);
    expect(m.move(a, a1)).toBe(false);
    expect(m.move(a, a)).toBe(false);
    expect(m.move(r, a)).toBe(false);
    // 同一個父節點內換位置（index 以拿掉自己之後計算）
    m.move(b, r, 0);
    expect(texts(m, r)).toEqual(["時程", "目標"]);
    expect(m.depth(a1)).toBe(2);
    expect(m.isAncestor(r, a1)).toBe(true);
  });

  it("上移、下移", () => {
    const { m, r, a, c } = sample();
    expect(m.shift(a, -1)).toBe(false);
    expect(m.shift(a, 1)).toBe(true);
    expect(texts(m, r)).toEqual(["時程", "目標", "風險"]);
    expect(m.shift(c, 1)).toBe(false);
    m.shift(c, -1);
    expect(texts(m, r)).toEqual(["時程", "風險", "目標"]);
  });

  it("tree()：收合的節點沒有子節點，並記錄藏了幾個", () => {
    const { m, a, a1 } = sample();
    m.addChild(a1, "孫");
    m.setCollapsed(a, true);
    const t = m.tree();
    const ta = t.children.find((n) => n.id === a)!;
    expect(ta.children).toEqual([]);
    expect(ta.hidden).toBe(3);
  });

  it("復原只追蹤本機的修改，一個動作一步", () => {
    const { m, r } = sample();
    const undo = m.createUndoManager(LOCAL);
    let id = "";
    m.doc.transact(() => (id = m.addChild(r, "新的")), LOCAL);
    m.doc.transact(() => m.setText(id, "改過"), LOCAL);
    undo.undo();
    expect(m.node(id)!.text).toBe("新的");
    undo.undo();
    expect(m.has(id)).toBe(false);
    undo.redo();
    expect(m.node(id)!.text).toBe("新的");
  });
});

describe("自由拖動的位置", () => {
  it("每種結構各自記錄；設成 0 或 null 會清掉", () => {
    const { m, a } = sample();
    expect(m.offset(a)).toBeUndefined();
    m.setOffset(a, [12.345, -40]);
    expect(m.offset(a)).toEqual([12.3, -40]);
    expect(m.offset(a, "org")).toBeUndefined();
    m.setOffset(a, [5, 5], "org");
    expect(m.offset(a, "org")).toEqual([5, 5]);
    expect(m.hasOffsets()).toBe(true);
    m.setOffset(a, [0, 0]);
    expect(m.offset(a)).toBeUndefined();
    expect(m.offset(a, "org")).toEqual([5, 5]);
    m.setOffset(a, null, "org");
    expect(m.hasOffsets("org")).toBe(false);
  });

  it("tree() 帶出目前結構的位移；中心元件也可以有位移（可以拖動）", () => {
    const { m, r, a } = sample();
    m.setOffset(a, [10, 20]);
    m.setOffset(r, [99, 99]);
    const t = m.tree();
    expect(t.offset).toEqual([99, 99]);
    expect(t.children.find((n) => n.id === a)!.offset).toEqual([10, 20]);
    expect(m.tree("logic").children.find((n) => n.id === a)!.offset).toBeUndefined();
  });

  it("自動排列（clearOffsets）只清掉目前結構，一次復原", () => {
    const { m, a, b } = sample();
    const undo = m.createUndoManager(LOCAL);
    m.doc.transact(() => {
      m.setOffset(a, [10, 0]);
      m.setOffset(b, [0, 10]);
      m.setOffset(b, [1, 1], "tree");
    }, LOCAL);
    m.doc.transact(() => m.clearOffsets(), LOCAL);
    expect(m.hasOffsets()).toBe(false);
    expect(m.offset(b, "tree")).toEqual([1, 1]);
    undo.undo();
    expect(m.offset(a)).toEqual([10, 0]);
    expect(m.offset(b)).toEqual([0, 10]);
  });

  it("換到別的父節點時清掉位移；同一個父節點內調順序保留", () => {
    const { m, b, c, a1 } = sample();
    m.setOffset(a1, [30, 30]);
    m.setOffset(c, [5, 5]);
    m.move(a1, b);
    expect(m.offset(a1)).toBeUndefined();
    m.shift(c, -1);
    expect(m.offset(c)).toEqual([5, 5]);
  });
});

describe("單一主題的外觀設定", () => {
  it("設定形狀、線型、粗細、虛線；null／false 回到預設；tree() 帶出", () => {
    const { m, a, b } = sample();
    expect(m.nodeStyle(a)).toBeUndefined();
    m.setNodeStyle([a, b], { shape: "ellipse", line: "elbow", width: 5, dash: true });
    expect(m.nodeStyle(a)).toEqual({ shape: "ellipse", line: "elbow", width: 5, dash: true });
    m.setNodeStyle([a], { line: null, dash: false });
    expect(m.nodeStyle(a)).toEqual({ shape: "ellipse", width: 5 });
    expect(m.tree().children.find((n) => n.id === b)!.style).toMatchObject({ dash: true });
    m.setNodeStyle([a], { shape: null, width: null });
    expect(m.nodeStyle(a)).toBeUndefined();
  });

  it("一次改多個是一個復原步驟", () => {
    const { m, a, b } = sample();
    const undo = m.createUndoManager(LOCAL);
    m.doc.transact(() => m.setNodeStyle([a, b], { line: "straight" }), LOCAL);
    undo.undo();
    expect(m.nodeStyle(a)).toBeUndefined();
    expect(m.nodeStyle(b)).toBeUndefined();
  });
});

describe("多台裝置合併", () => {
  it("兩邊各自新增節點，合併後都在", () => {
    const { m, r } = sample();
    const other = clone(m);
    m.addChild(r, "A 加的");
    other.addChild(r, "B 加的");
    sync(m, other);
    expect(texts(m, r).sort()).toEqual(texts(other, r).sort());
    expect(texts(m, r)).toContain("A 加的");
    expect(texts(m, r)).toContain("B 加的");
  });

  it("兩邊同時把同一個節點拖到不同地方：只有一份", () => {
    const { m, b, c, a1 } = sample();
    const other = clone(m);
    m.move(a1, b);
    other.move(a1, c);
    sync(m, other);
    expect(m.parentOf(a1)).toBe(other.parentOf(a1));
    expect([...m.children(b), ...m.children(c)].filter((x) => x === a1)).toHaveLength(1);
  });

  it("兩邊同時互相拖到對方底下（形成迴圈）：兩邊都接回中心主題，資料不遺失", () => {
    const { m, r, a, b } = sample();
    const other = clone(m);
    m.move(a, b);
    other.move(b, a);
    sync(m, other);
    for (const x of [m, other]) {
      expect(x.size).toBe(6);
      // 每個節點都能從中心主題走到
      const seen = new Set<string>();
      const walk = (id: string) => {
        seen.add(id);
        x.children(id).forEach(walk);
      };
      walk(r);
      expect(seen.size).toBe(6);
    }
    expect(m.toMarkdown()).toBe(other.toMarkdown());
  });

  it("一邊刪除父節點、另一邊在底下新增：新節點接回中心主題", () => {
    const { m, r, a } = sample();
    const other = clone(m);
    m.remove([a]);
    const orphan = other.addChild(a, "孤兒");
    sync(m, other);
    // a 底下原有的節點被 m 刪了；other 在 a 底下新增的節點保留下來，接到中心主題
    expect(m.parentOf(orphan)).toBe(r);
    expect(texts(m, r)).toContain("孤兒");
  });
});

describe("大綱", () => {
  it("toMarkdown 匯出縮排清單", () => {
    const { m } = sample();
    expect(m.toMarkdown()).toBe("# 專案\n- 目標\n  - 營收\n  - 使用者\n- 時程\n- 風險\n");
  });

  it("parseOutline：Markdown、Tab、空白縮排、編號", () => {
    expect(parseOutline("- 一\n  - 一之一\n    - 深\n- 二")).toEqual([
      { level: 0, text: "一" }, { level: 1, text: "一之一" }, { level: 2, text: "深" }, { level: 0, text: "二" },
    ]);
    expect(parseOutline("甲\n\t乙\n\t\t丙\n\t丁\n\n戊")).toEqual([
      { level: 0, text: "甲" }, { level: 1, text: "乙" }, { level: 2, text: "丙" }, { level: 1, text: "丁" }, { level: 0, text: "戊" },
    ]);
    expect(parseOutline("1. 第一\n2. 第二")).toEqual([{ level: 0, text: "第一" }, { level: 0, text: "第二" }]);
  });

  it("addOutline 依縮排建立節點，回傳第一層", () => {
    const m = MindMap.create("中心");
    const top = m.addOutline(m.rootId, "- 甲\n  - 甲一\n  - 甲二\n- 乙");
    expect(top.map((id) => m.node(id)!.text)).toEqual(["甲", "乙"]);
    expect(texts(m, top[0])).toEqual(["甲一", "甲二"]);
  });
});

describe(".gugamap 檔", () => {
  it("存檔再開啟：內容、結構、主題都一樣，而且還是同一份文件（可以合併）", () => {
    const { m, r } = sample();
    m.structure = "org";
    m.theme = "sketch";
    const opened = openMindMapFile(saveMindMapFile(m));
    expect(opened.toMarkdown()).toBe(m.toMarkdown());
    expect(opened.structure).toBe("org");
    expect(opened.theme).toBe("sketch");
    expect(opened.id).toBe(m.id);
    opened.addChild(r, "開檔後新增");
    sync(m, opened);
    expect(texts(m, r)).toContain("開檔後新增");
  });

  it("不是心智圖檔時給清楚的錯誤", () => {
    expect(() => openMindMapFile("hello")).toThrow("這不是心智圖檔");
    expect(() => openMindMapFile(JSON.stringify({ format: "x" }))).toThrow("這不是心智圖檔");
    expect(() => openMindMapFile(JSON.stringify({ format: "gugamap", version: 99, doc: "" }))).toThrow("新版程式");
  });
});

describe("獨立元件與連線", () => {
  it("新增獨立元件：不在中心元件底下，有自己的位置", () => {
    const m = MindMap.create("中心");
    const f = m.addFloating("獨立", [300, 40]);
    expect(m.isFloating(f)).toBe(true);
    expect(m.parentOf(f)).toBeNull();
    expect(m.children(m.rootId)).not.toContain(f);
    expect(m.floatingIds()).toEqual([f]);
    expect(m.at(f)).toEqual([300, 40]);
    const kid = m.addChild(f, "子");
    expect(m.parentOf(kid)).toBe(f);
    const [tree] = m.floating();
    expect(tree.id).toBe(f);
    expect(tree.at).toEqual([300, 40]);
    expect(tree.children.map((c) => c.text)).toEqual(["子"]);
    expect(m.tree().children).toHaveLength(0);
  });

  it("連線（move）：獨立元件變成子元件，不再是獨立元件；刪線（detach）變回獨立元件", () => {
    const m = MindMap.create("中心");
    const a = m.addChild(m.rootId, "A");
    const f = m.addFloating("F", [0, 0]);
    m.addChild(f, "F 的子");
    expect(m.move(f, a)).toBe(true);
    expect(m.isFloating(f)).toBe(false);
    expect(m.at(f)).toBeUndefined();
    expect(m.floatingIds()).toEqual([]);
    expect(texts(m, a)).toEqual(["F"]);
    expect(m.detach(f, [120, 80])).toBe(true);
    expect(m.isFloating(f)).toBe(true);
    expect(m.at(f)).toEqual([120, 80]);
    expect(texts(m, a)).toEqual([]);
    expect(m.children(f)).toHaveLength(1);
    // 中心元件不能拆
    expect(m.detach(m.rootId, [0, 0])).toBe(false);
  });

  it("獨立元件可以刪除、移動位置，也會匯出到 Markdown", () => {
    const m = MindMap.create("中心");
    const f = m.addFloating("F", [0, 0]);
    m.setAt(f, [10.04, 20]);
    expect(m.at(f)).toEqual([10, 20]);
    expect(m.toMarkdown()).toContain("# F");
    m.remove([f]);
    expect(m.floatingIds()).toEqual([]);
  });

  it("其他裝置刪掉獨立元件時，同時加的子元件接到中心元件（不遺失）", () => {
    const a = MindMap.create("中心");
    const f = a.addFloating("F", [0, 0]);
    const b = clone(a);
    a.remove([f]);
    const kid = b.addChild(f, "子");
    sync(a, b);
    expect(a.parentOf(kid)).toBe(a.rootId);
    expect(b.parentOf(kid)).toBe(b.rootId);
  });

  it("復原：拉線、刪線都可以復原", () => {
    const m = MindMap.create("中心");
    const undo = m.createUndoManager(LOCAL);
    const f = m.addFloating("F", [0, 0]);
    m.doc.transact(() => m.move(f, m.rootId), LOCAL);
    expect(m.isFloating(f)).toBe(false);
    undo.undo();
    expect(m.isFloating(f)).toBe(true);
    expect(m.at(f)).toEqual([0, 0]);
  });
});

describe("手拉的連接線", () => {
  it("拉線不改變元件原本的上層與線；可以連到中心元件", () => {
    const m = MindMap.create("中心");
    const a = m.addChild(m.rootId, "A");
    const b = m.addChild(a, "B");
    const f = m.addFloating("F", [0, 0]);
    const l1 = m.addLink(b, f)!;
    const l2 = m.addLink(f, m.rootId)!;
    expect(l1).toBeTruthy();
    expect(l2).toBeTruthy();
    expect(m.parentOf(b)).toBe(a);
    expect(m.isFloating(f)).toBe(true);
    expect(m.links().map((l) => [l.from, l.to])).toEqual([[b, f], [f, m.rootId]]);
    // 一個元件可以有很多條線
    expect(m.addLink(a, f)).toBeTruthy();
    expect(m.links().filter((l) => l.to === f)).toHaveLength(2);
  });

  it("不能連自己、不能重複連（哪個方向都算），已經是上層／子元件也不行", () => {
    const m = MindMap.create("中心");
    const a = m.addChild(m.rootId, "A");
    const f = m.addFloating("F", [0, 0]);
    expect(m.addLink(a, a)).toBeNull();
    expect(m.addLink(a, m.rootId)).toBeNull();
    expect(m.addLink(m.rootId, a)).toBeNull();
    expect(m.addLink(a, f)).toBeTruthy();
    expect(m.addLink(f, a)).toBeNull();
    expect(m.canLink(a, f)).toBe(false);
  });

  it("樣式、刪線；刪掉元件時連到它的線一起刪；可以復原", () => {
    const m = MindMap.create("中心");
    const undo = m.createUndoManager(LOCAL);
    const a = m.addChild(m.rootId, "A");
    const f = m.addFloating("F", [0, 0]);
    let id = "";
    m.doc.transact(() => (id = m.addLink(a, f)!), LOCAL);
    m.setLinkStyle([id], { line: "straight", width: 5, dash: true, color: "#e03131" });
    expect(m.link(id)).toMatchObject({ line: "straight", width: 5, dash: true, color: "#e03131" });
    m.setLinkStyle([id], { dash: null, color: null });
    expect(m.link(id)!.dash).toBeUndefined();
    expect(m.link(id)!.color).toBeUndefined();
    m.remove([f]);
    expect(m.links()).toEqual([]);
    expect(m.link(id)).toBeUndefined();
    m.doc.transact(() => m.addLink(a, m.rootId), LOCAL);
    expect(m.links()).toHaveLength(0); // a 的上層就是中心元件
    const b = m.addFloating("B", [0, 0]);
    m.doc.transact(() => (id = m.addLink(b, a)!), LOCAL);
    m.doc.transact(() => m.removeLink([id]), LOCAL);
    expect(m.links()).toHaveLength(0);
    undo.undo();
    expect(m.links()).toHaveLength(1);
  });

  it("中心元件也可以有自由拖動的位移", () => {
    const m = MindMap.create("中心");
    m.setOffset(m.rootId, [30, 10]);
    expect(m.tree().offset).toEqual([30, 10]);
    m.clearOffsets();
    expect(m.tree().offset).toBeUndefined();
  });
});
