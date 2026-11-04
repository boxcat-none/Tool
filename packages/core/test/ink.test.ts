import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, type PDFDict, type PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  decodeStrokes,
  flattenInk,
  encodeStrokes,
  readInk,
  removeInk,
  simplifyPoints,
  strokeOutline,
  writeInk,
  type Stroke,
} from "../src/ink";

function line(x0: number, y0: number, x1: number, y1: number, n = 50, color = "#1e40af"): Stroke {
  const points: Stroke["points"] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.3 + 0.5 * Math.sin(t * Math.PI)]);
  }
  return { tool: "pen", color, size: 2, points };
}

async function blankDoc(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return doc;
}

describe("codec", () => {
  it("編碼後解碼得到相同資料（精度 0.1 pt、筆壓 1/255）", () => {
    const strokes: Stroke[] = [
      { tool: "pen", color: "#ff8800", size: 2.5, points: [[10.04, 20.06, 0.5], [-3.21, 800.99, 1], [10, 20, 0]] },
      { tool: "highlighter", color: "#FFEB3B", size: 12, points: [[0, 0, 0.25]] },
    ];
    const out = decodeStrokes(encodeStrokes(strokes));
    expect(out).toHaveLength(2);
    expect(out[0].tool).toBe("pen");
    expect(out[0].color).toBe("#ff8800");
    expect(out[0].size).toBe(2.5);
    out[0].points.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(strokes[0].points[i][0], 1);
      expect(p[1]).toBeCloseTo(strokes[0].points[i][1], 1);
      expect(Math.abs(p[2] - strokes[0].points[i][2])).toBeLessThanOrEqual(1 / 255);
    });
    expect(out[1]).toMatchObject({ tool: "highlighter", color: "#ffeb3b", size: 12 });
  });

  it("每個點約 3 bytes（差值編碼）", () => {
    const s = line(100, 100, 120, 130, 200);
    const bytes = encodeStrokes([s]);
    expect(bytes.length / 200).toBeLessThan(3.5);
  });

  it("拒絕不是筆跡的資料", () => {
    expect(() => decodeStrokes(new Uint8Array([1, 2, 3, 4, 5]))).toThrow("不是筆跡資料");
    expect(() => decodeStrokes(encodeStrokes([line(0, 0, 1, 1)]).slice(0, 12))).toThrow("不完整");
  });
});

describe("simplifyPoints", () => {
  it("直線只留頭尾", () => {
    const pts = line(0, 0, 100, 0, 100).points.map(([x, y]) => [x, y, 0.5] as Stroke["points"][number]);
    expect(simplifyPoints(pts, 0.1)).toHaveLength(2);
  });

  it("保留轉折點與筆壓變化", () => {
    const pts: Stroke["points"] = [[0, 0, 0.5], [5, 0, 0.5], [10, 0, 0.5], [10, 5, 0.5], [10, 10, 0.5]];
    expect(simplifyPoints(pts, 0.1)).toEqual([[0, 0, 0.5], [10, 0, 0.5], [10, 10, 0.5]]);
    const pressure: Stroke["points"] = [[0, 0, 0.1], [5, 0, 0.9], [10, 0, 0.1]];
    expect(simplifyPoints(pressure, 0.1)).toHaveLength(3);
  });
});

describe("writeInk / readInk / removeInk", () => {
  it("寫入後重新開啟可以讀回筆跡", async () => {
    const doc = await blankDoc(2);
    const strokes = [line(100, 100, 300, 120), line(100, 200, 120, 400, 80, "#dc2626")];
    const hl: Stroke = { ...line(50, 700, 400, 700), tool: "highlighter", color: "#facc15", size: 14 };
    writeInk(doc, new Map([[1, [...strokes, hl]]]), { includeData: true });
    const reopened = await PDFDocument.load(await doc.save());

    const ink = readInk(reopened);
    expect([...ink.keys()]).toEqual([1]);
    const page = ink.get(1)!;
    expect(page.map((s) => `${s.tool}:${s.color}`).sort()).toEqual(["highlighter:#facc15", "pen:#1e40af", "pen:#dc2626"]);
    // 精簡後的點仍然在原本的線上（誤差 ≤ 0.15 pt + 量化 0.05 pt）
    const blue = page.find((s) => s.color === "#1e40af")!;
    expect(blue.points[0][0]).toBeCloseTo(100, 1);
    expect(blue.points.at(-1)![0]).toBeCloseTo(300, 1);
  });

  it("同一頁同顏色合成一個註解，並包含外觀、InkList 與原始資料", async () => {
    const doc = await blankDoc();
    writeInk(doc, new Map([[0, [line(10, 10, 50, 50), line(60, 60, 90, 90), line(10, 90, 90, 10, 50, "#000000")]]]), { includeData: true });
    const annots = doc.getPage(0).node.Annots()!.asArray().map((r) => doc.context.lookup(r) as PDFDict);
    expect(annots).toHaveLength(2);
    for (const a of annots) {
      expect(a.get(PDFName.of("Subtype"))).toBe(PDFName.of("Ink"));
      expect(a.has(PDFName.of("AP"))).toBe(true);
      expect(a.has(PDFName.of("InkList"))).toBe(true);
      expect(a.has(PDFName.of("PDFToolboxInk"))).toBe(true);
    }
  });

  it("移除筆跡後不留下殘餘物件，也不影響其他註解", async () => {
    const doc = await blankDoc();
    const before = (await doc.save()).length;
    // 其他軟體加的註解
    const other = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 10, 10] }));
    doc.getPage(0).node.addAnnot(other);
    const withOther = (await doc.save()).length;

    writeInk(doc, new Map([[0, Array.from({ length: 50 }, (_, i) => line(10, i * 10, 200, i * 10 + 5))]]), { includeData: true });
    const withInk = await PDFDocument.load(await doc.save());
    expect(removeInk(withInk)).toBe(1);
    const after = await withInk.save();

    const reopened = await PDFDocument.load(after);
    expect(readInk(reopened).size).toBe(0);
    expect(reopened.getPage(0).node.Annots()!.size()).toBe(1);
    // 檔案大小回到只有其他註解時的大小（容許日期等少量差異）
    expect(Math.abs(after.length - withOther)).toBeLessThan(200);
    expect(withOther).toBeGreaterThan(before);
  });

  it("外觀與畫面使用同一個外框函式", () => {
    const o = strokeOutline(line(0, 0, 100, 0));
    expect(o.length).toBeGreaterThan(4);
    // size 是中等筆壓時的粗細；thinning 0.6 時最大筆壓約 1.6 倍
    const ys = o.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(2 * 1.6);
  });
});

describe("匯出（方案 C）", () => {
  it("註解模式預設不含可編輯資料", async () => {
    const doc = await blankDoc();
    writeInk(doc, new Map([[0, [line(10, 10, 50, 50)]]]));
    const annot = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0)) as PDFDict;
    expect(annot.get(PDFName.of("Subtype"))).toBe(PDFName.of("Ink"));
    expect(annot.has(PDFName.of("PDFToolboxInk"))).toBe(false);
    expect(readInk(doc).size).toBe(0);
  });

  it("合併模式把筆跡畫進頁面內容，沒有註解，原內容包在 q…Q 裡", async () => {
    const doc = await blankDoc();
    // 原本的內容留下沒有還原的座標變換（不良 PDF 常見），不能影響筆跡位置
    const page = doc.getPage(0);
    page.node.addContentStream(doc.context.register(doc.context.stream("2 0 0 2 0 0 cm\n")));
    const hl: Stroke = { ...line(50, 700, 400, 700), tool: "highlighter", color: "#facc15", size: 14 };
    flattenInk(doc, new Map([[0, [line(100, 100, 300, 120), hl]]]));
    const reopened = await PDFDocument.load(await doc.save());
    const p = reopened.getPage(0);
    expect(p.node.Annots()?.size() ?? 0).toBe(0);

    const contents = p.node.Contents()!;
    const arr = contents instanceof PDFArray ? contents.asArray() : [contents];
    const texts = arr.map((ref) => {
      const st = reopened.context.lookup(ref) as PDFRawStream;
      const bytes = st.dict.has(PDFName.of("Filter")) ? decodePDFRawStream(st).decode() : st.contents;
      return new TextDecoder().decode(bytes);
    });
    expect(texts[0].trim()).toBe("q");
    expect(texts.at(-2)!.trim()).toBe("Q");
    const ink = texts.at(-1)!;
    expect(ink).toContain("/PTHighlight gs");
    // 螢光筆在鋼筆之前（下層）
    expect(ink.indexOf("/PTHighlight gs")).toBeLessThan(ink.lastIndexOf("0.118 0.251 0.686 rg"));
  });
});
