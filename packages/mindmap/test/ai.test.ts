import { describe, expect, it } from "vitest";
import { buildDiagram, buildFlowMap, buildPrompt, docxToMarkdown, extractJson, layoutFlow, parseFlowAnswer, parseMermaid, parseMindAnswer, pptxToMarkdown } from "../src";

describe("提示詞", () => {
  it("架構圖、流程圖各自的說明；有圖片時用多段內容", () => {
    const m = buildPrompt("mind", "內容");
    expect(m[0].role).toBe("system");
    expect(m[0].content).toContain("架構圖");
    expect(m[1].content).toContain("內容");
    const f = buildPrompt("flow", "", ["data:image/png;base64,AAA"]);
    expect(f[0].content).toContain("decision");
    expect(Array.isArray(f[1].content)).toBe(true);
    expect((f[1].content as { type: string }[]).map((c) => c.type)).toEqual(["text", "image_url"]);
  });
});

describe("解析模型的回答", () => {
  it("JSON 在 ```json 框裡、前後有說明、有 <think>", () => {
    const a = '<think>想一下 {不是這個}</think>好的，結果如下：\n```json\n{"title": "T", "root": {"text": "中心 {x}", "children": []}}\n```\n希望有幫助';
    expect(extractJson(a)).toEqual({ title: "T", root: { text: "中心 {x}", children: [] } });
    expect(extractJson("沒有 JSON")).toBeUndefined();
  });

  it("架構圖：標準格式、直接是根節點、字串子節點、Markdown 大綱", () => {
    const r = parseMindAnswer('{"title":"讀書","root":{"text":"讀書計畫","children":[{"text":"數學","children":["微積分",{"name":"線代"}]},{"text":""}]}}', "x");
    expect(r.title).toBe("讀書");
    expect(r.root.text).toBe("讀書計畫");
    expect(r.root.children.map((c) => c.text)).toEqual(["數學"]);
    expect(r.root.children[0].children.map((c) => c.text)).toEqual(["微積分", "線代"]);
    expect(parseMindAnswer('{"text":"A","children":[{"text":"B"}]}', "x").root.children[0].text).toBe("B");
    const md = parseMindAnswer("以下是架構：\n# 專案\n## 目標\n- 營收\n## 時程", "x");
    expect(md.root.text).toBe("專案");
    expect(md.root.children.map((c) => c.text)).toEqual(["目標", "時程"]);
    expect(() => parseMindAnswer("我不知道", "x")).toThrow("看不懂模型的回答");
  });

  it("流程圖：JSON（類型別名、重複與錯誤的線拿掉）", () => {
    const f = parseFlowAnswer(
      JSON.stringify({
        title: "請假",
        nodes: [
          { id: "a", text: "開始", type: "Start" },
          { id: "b", text: "填假單", type: "step" },
          { id: "c", text: "主管同意？", type: "condition" },
          { id: "c", text: "重複" },
          { id: "d", text: "結束", type: "end" },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d", label: "是" }, { from: "c", to: "b", label: "否" }, { from: "x", to: "a" }, { from: "a", to: "a" }],
      }),
      "x",
    );
    expect(f.title).toBe("請假");
    expect(f.nodes.map((n) => n.type)).toEqual(["start", "process", "decision", "end"]);
    expect(f.edges).toHaveLength(4);
    expect(f.edges[2]).toEqual({ from: "c", to: "d", label: "是" });
  });

  it("流程圖：模型回答 Mermaid 也看得懂", () => {
    const f = parseMermaid("```mermaid\nflowchart TD\n  A([開始]) --> B[填假單]\n  B --> C{主管同意？}\n  C -->|是| D((結束))\n  C -- 否 --> B\n  B --> E[/送出資料/]\n```", "請假");
    expect(f).not.toBeNull();
    const byId = new Map(f!.nodes.map((n) => [n.id, n]));
    expect(byId.get("A")).toMatchObject({ text: "開始", type: "start" });
    expect(byId.get("C")).toMatchObject({ text: "主管同意？", type: "decision" });
    expect(byId.get("D")).toMatchObject({ text: "結束", type: "end" });
    expect(byId.get("E")).toMatchObject({ type: "io" });
    expect(f!.edges).toContainEqual({ from: "C", to: "D", label: "是" });
    expect(f!.edges).toContainEqual({ from: "C", to: "B", label: "否" });
    expect(parseMermaid("不是 mermaid", "x")).toBeNull();
    expect(() => parseFlowAnswer("隨便的文字", "x")).toThrow("看不懂模型的回答");
  });
});

describe("流程圖排版", () => {
  const box = (id: string) => ({ id, width: 100, height: 40 });

  it("由上往下分層；分支並排不重疊；迴圈不影響分層", () => {
    const pos = layoutFlow(["a", "b", "c", "d", "e"].map(box), [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "e" },
      { from: "d", to: "e" },
      { from: "e", to: "a" }, // 迴圈
    ]);
    const y = (id: string) => pos.get(id)![1];
    const x = (id: string) => pos.get(id)![0];
    expect(y("a")).toBeLessThan(y("b"));
    expect(y("b")).toBeLessThan(y("c"));
    expect(y("c")).toBe(y("d"));
    expect(y("e")).toBeGreaterThan(y("c"));
    expect(Math.abs(x("c") - x("d"))).toBeGreaterThanOrEqual(100);
    // 一條直線的步驟對齊在同一條垂直線上
    expect(x("a")).toBe(x("b"));
  });

  it("沒有線的元件也排得出來；沒有元件不會出錯", () => {
    const pos = layoutFlow([box("a"), box("b")], []);
    expect(pos.size).toBe(2);
    expect(pos.get("a")![1]).toBe(pos.get("b")![1]);
    expect(layoutFlow([], []).size).toBe(0);
  });
});

describe("建立圖", () => {
  it("流程圖：開始是中心元件，其他是獨立元件；形狀、箭頭、線上文字", () => {
    const m = buildFlowMap(parseFlowAnswer('{"nodes":[{"id":"1","text":"開始","type":"start"},{"id":"2","text":"OK？","type":"decision"},{"id":"3","text":"輸入","type":"io"}],"edges":[{"from":"1","to":"2"},{"from":"2","to":"3","label":"是"}]}', "流程"));
    expect(m.kind).toBe("flow");
    expect(m.layoutPending).toBe(true);
    expect(m.node(m.rootId)!.text).toBe("開始");
    expect(m.floatingIds()).toHaveLength(2);
    const shapes = [m.rootId, ...m.floatingIds()].map((id) => m.nodeStyle(id)?.shape);
    expect(shapes).toEqual(["pill", "diamond", "parallelogram"]);
    expect(m.links().map((l) => [l.arrow, l.label])).toEqual([[true, undefined], [true, "是"]]);
    // 流程圖裡手拉的線也有箭頭
    const extra = m.addFloating("X", [0, 0]);
    const id = m.addLink(m.rootId, extra)!;
    expect(m.link(id)!.arrow).toBe(true);
  });

  it("架構圖：依回答建立心智圖", () => {
    const m = buildDiagram("mind", '{"title":"T","root":{"text":"中心","children":[{"text":"A"},{"text":"B"}]}}', "x");
    expect(m.kind).toBe("mind");
    expect(m.toMarkdown()).toBe("# 中心\n- A\n- B\n");
  });
});

describe("文件轉文字", () => {
  it("Word：標題樣式、清單層級、一般段落", () => {
    const xml = `<w:document xmlns:w="x"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>專案</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>目</w:t></w:r><w:r><w:t>標</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>營收</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">一般 段落</w:t></w:r></w:p>
      <w:p></w:p>
    </w:body></w:document>`;
    expect(docxToMarkdown(xml)).toBe("# 專案\n## 目標\n  - 營收\n一般 段落");
  });

  it("PowerPoint：每張投影片的標題與內文層級", () => {
    const slide = (title: string, items: [string, number][]) => `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:txBody>${items.map(([t, l]) => `<a:p><a:pPr lvl="${l}"/><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
    expect(pptxToMarkdown([slide("第一章", [["重點", 0], ["細節", 1]]), slide("第二章", [])])).toBe("## 第一章\n- 重點\n  - 細節\n\n## 第二章");
  });
});

describe("流程圖的迴圈與段落轉換", () => {
  it("流程圖可以往回連（否 → 回到上一步），同方向重複不行", () => {
    const m = buildFlowMap(parseFlowAnswer('{"nodes":[{"id":"a","text":"填單"},{"id":"d","text":"同意？","type":"decision"}],"edges":[{"from":"a","to":"d"},{"from":"d","to":"a","label":"否"}]}', "x"));
    expect(m.links()).toHaveLength(2);
    expect(m.links()[1].label).toBe("否");
    const [a, d] = [m.rootId, m.floatingIds()[0]];
    expect(m.canLink(a, d)).toBe(false);
  });
});
