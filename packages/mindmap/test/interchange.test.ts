import { describe, expect, it } from "vitest";
import { MindMap, openAnyMindMapFile, parseFreeMind, parseMarkdown, parseOPML, parsePlainText, parseXml, saveMindMapFile, toFreeMind, toOPML } from "../src";

/** 中心「專案」：目標（營收、使用者）、時程；獨立元件「備忘」；手拉線 使用者 → 備忘；目標收合、紅色 */
function sample() {
  const m = MindMap.create("專案規劃", "專案");
  const goal = m.addChild(m.rootId, "目標");
  m.addChild(goal, "營收 & <成長>");
  const user = m.addChild(goal, "使用者\n第二行");
  m.addChild(m.rootId, "時程");
  m.setColor(goal, "#e03131");
  m.setCollapsed(goal, true);
  const memo = m.addFloating("備忘", [500, 0]);
  m.addChild(memo, "待辦");
  m.addLink(user, memo);
  return m;
}

const shape = (m: MindMap) => m.toMarkdown();

describe("OPML", () => {
  it("匯出再匯入：文字、層級、獨立元件都一樣；特殊字元與換行保留", () => {
    const m = sample();
    const xml = toOPML(m);
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain("&amp; &lt;成長&gt;");
    expect(xml).toContain("使用者&#10;第二行");
    const back = openAnyMindMapFile("專案.opml", xml);
    expect(shape(back)).toBe(shape(m));
    expect(back.title).toBe("專案規劃");
    expect(back.floatingIds()).toHaveLength(1);
  });

  it("其他大綱軟體：很多個最上層 → 以標題當中心元件", () => {
    const r = parseOPML(`<?xml version="1.0"?><opml version="1.0"><head><title>讀書</title></head><body><outline text="第一章"><outline title="1-1"/></outline><outline text="第二章"/></body></opml>`, "x");
    expect(r.root.text).toBe("讀書");
    expect(r.root.children.map((c) => c.text)).toEqual(["第一章", "第二章"]);
    expect(r.root.children[0].children[0].text).toBe("1-1");
  });

  it("壞掉的檔案有清楚的錯誤", () => {
    expect(() => parseOPML("<opml><body>", "x")).toThrow();
    expect(() => parseOPML("<html/>", "x")).toThrow("這不是 OPML 檔");
    expect(() => parseOPML(`<opml><body></body></opml>`, "x")).toThrow("空的");
  });
});

describe("FreeMind（.mm）", () => {
  it("匯出再匯入：層級、收合、顏色、手拉的線、獨立元件都保留", () => {
    const m = sample();
    const xml = toFreeMind(m);
    expect(xml.startsWith('<map version="1.0.1">')).toBe(true);
    expect(xml).toContain('FOLDED="true"');
    expect(xml).toContain('<edge COLOR="#e03131"/>');
    expect(xml).toContain("<arrowlink");
    expect(xml).toContain('<hook NAME="FreeNode"/>');
    const back = openAnyMindMapFile("專案.mm", xml);
    expect(shape(back)).toBe(shape(m));
    const goal = back.children(back.rootId)[0];
    expect(back.node(goal)!.collapsed).toBe(true);
    expect(back.node(goal)!.color).toBe("#e03131");
    expect(back.links()).toHaveLength(1);
    const l = back.links()[0];
    expect(back.node(l.from)!.text).toBe("使用者\n第二行");
    expect(back.node(l.to)!.text).toBe("備忘");
    expect(back.isFloating(l.to)).toBe(true);
  });

  it("讀 FreeMind／Freeplane 存的檔：richcontent 的文字、POSITION、三位數顏色", () => {
    const xml = `<map version="freeplane 1.9.0"><!-- 註解 --><node TEXT="中心" ID="ID_1"><node ID="ID_2" POSITION="left"><richcontent TYPE="NODE"><html><body><p>第一行</p><p>第二行</p></body></html></richcontent><edge COLOR="#f00"/></node><node TEXT="B" ID="ID_3"><arrowlink DESTINATION="ID_2"/></node></node></map>`;
    const r = parseFreeMind(xml, "x");
    expect(r.root.text).toBe("中心");
    expect(r.root.children[0].text).toBe("第一行\n第二行");
    expect(r.root.children[0].color).toBe("#ff0000");
    expect(r.links).toEqual([["ID_3", "ID_2"]]);
  });

  it("不是 FreeMind 檔", () => {
    expect(() => parseFreeMind("<opml/>", "x")).toThrow("這不是 FreeMind 檔");
  });
});

describe("Markdown", () => {
  it("自己匯出的 Markdown 可以開回來（獨立元件也是）", () => {
    const m = sample();
    expect(shape(openAnyMindMapFile("專案.md", m.toMarkdown()))).toBe(shape(m).replace("使用者\n第二行", "使用者 第二行"));
  });

  it("MindNode 式的標題層級＋清單＋行內標記", () => {
    const md = "# 讀書計畫\n\n一段說明文字（略過）\n\n## **數學**\n- 微積分\n  - 極限\n- [線性代數](https://x)\n## 英文\n### 單字\n1. 每天 `20` 個\n\n```\n# 程式碼裡的不算\n```\n";
    const r = parseMarkdown(md, "x");
    expect(r.root.text).toBe("讀書計畫");
    expect(r.root.children.map((c) => c.text)).toEqual(["數學", "英文"]);
    expect(r.root.children[0].children.map((c) => c.text)).toEqual(["微積分", "線性代數"]);
    expect(r.root.children[0].children[0].children[0].text).toBe("極限");
    expect(r.root.children[1].children[0].children[0].text).toBe("每天 20 個");
    expect(r.floating).toEqual([]);
  });

  it("只有清單（沒有標題）：用檔名當中心元件；什麼都沒有時有錯誤", () => {
    const r = parseMarkdown("- 甲\n- 乙\n  - 丙\n", "清單");
    expect(r.root.text).toBe("清單");
    expect(r.root.children.map((c) => c.text)).toEqual(["甲", "乙"]);
    expect(() => parseMarkdown("只是一段文字", "x")).toThrow("讀不到內容");
  });
});

describe("純文字", () => {
  it("縮排表示層級；一個最上層 = 中心元件，很多個 = 檔名當中心元件", () => {
    expect(parsePlainText("專案\n\t目標\n\t\t營收\n\t時程\n", "x").root.text).toBe("專案");
    const r = parsePlainText("甲\n  甲一\n乙\n", "筆記");
    expect(r.root.text).toBe("筆記");
    expect(r.root.children.map((c) => c.text)).toEqual(["甲", "乙"]);
    expect(r.root.children[0].children[0].text).toBe("甲一");
  });
});

describe("開啟檔案", () => {
  it(".gugamap 照舊；認不得的格式有說明", () => {
    const m = sample();
    expect(shape(openAnyMindMapFile("a.gugamap", saveMindMapFile(m)))).toBe(shape(m));
    expect(() => openAnyMindMapFile("a.pdf", "%PDF-1.7")).toThrow("不支援這種檔案");
    // 副檔名不對，但內容是 OPML
    expect(openAnyMindMapFile("a.xml", toOPML(m)).node(m.rootId)).toBeUndefined();
  });

  it("XML 解析：實體、CDATA、單引號屬性", () => {
    const e = parseXml(`<a x='1 &amp; 2'><![CDATA[<b>]]>&#20013;&#x6587;</a>`);
    expect(e.attrs.x).toBe("1 & 2");
    expect(e.text).toBe("<b>中文");
  });
});
