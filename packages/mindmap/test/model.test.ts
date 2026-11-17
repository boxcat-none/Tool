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
