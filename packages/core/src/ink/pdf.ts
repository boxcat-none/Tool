import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { zlibSync } from "fflate";
import type { PDFContext } from "pdf-lib";
import { decodeStrokes, encodeStrokes, parseColor } from "./codec";
import { strokeOutline } from "./outline";
import { normalizeStroke, simplify2D, simplifyPoints } from "./simplify";
import type { Stroke } from "./types";

/** 我們自訂的註解欄位：存放可編輯的原始筆跡資料。其他 PDF 軟體會忽略這個欄位。 */
export const INK_DATA_KEY = "PDFToolboxInk";
const AUTHOR = "PDF 工具箱";

export interface WriteInkOptions {
  /** 原始資料的點精簡誤差（pt），0 = 不精簡。預設 0.15 */
  simplifyTolerance?: number;
  /** 同一頁、同工具、同顏色的筆畫合成一個註解。預設 true */
  group?: boolean;
  /** 外觀與原始資料使用 Flate 壓縮。預設 true */
  compress?: boolean;
  /** 原始資料格式（json 只用於容量比較）。預設 binary */
  dataFormat?: "binary" | "json";
  /** 是否寫入可編輯的原始資料（方案 D 用）。方案 C 的匯出不需要，預設 false */
  includeData?: boolean;
}

const HIGHLIGHTER_ALPHA = 0.35;

/**
 * Flate 壓縮的串流。用 fflate 等級 3：比 pdf-lib 內建的 pako 快約 6 倍，
 * 檔案只大約 3%（筆跡內容是大量座標文字，數萬筆時壓縮是主要瓶頸）。
 */
function deflated(ctx: PDFContext, content: string | Uint8Array, dict: Record<string, unknown> = {}) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  // PDF 的 FlateDecode 是 zlib 格式（含檔頭與檢查碼），不是純 deflate
  return ctx.stream(zlibSync(bytes, { level: 3 }), { ...dict, Filter: "FlateDecode" } as never);
}

/**
 * 把筆跡寫成 PDF 手繪註解（/Subtype /Ink）。
 * `ink` 的 key 是頁面索引（0 起算）。原有的筆跡註解請先用 removeInk 移除。
 */
export function writeInk(doc: PDFDocument, ink: Map<number, Stroke[]>, options: WriteInkOptions = {}): void {
  const {
    simplifyTolerance = 0.15,
    group = true,
    compress = true,
    dataFormat = "binary",
    includeData = false,
  } = options;
  const ctx = doc.context;
  const pages = doc.getPages();

  for (const [pageIndex, strokes] of ink) {
    const page = pages[pageIndex];
    if (!page || strokes.length === 0) continue;

    // 原始資料先精簡、四捨五入到 0.1 pt，外觀也由精簡後的資料產生，
    // 確保「存檔前看到的」和「重新打開後看到的」完全一致
    const prepared = strokes
      .map((s) => normalizeStroke(s, simplifyTolerance))
      .filter((s) => s.points.length > 0);

    const groups = new Map<string, Stroke[]>();
    prepared.forEach((s, i) => {
      const key = group ? `${s.tool}|${s.color}` : String(i);
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    });

    let n = 0;
    for (const list of groups.values()) {
      const highlighter = list[0].tool === "highlighter";
      const { content, bounds } = inkDrawing(list, highlighter ? "/H gs\n" : "");
      const rect = [bounds[0] - 1, bounds[1] - 1, bounds[2] + 1, bounds[3] + 1].map((v) => round(v, 1));

      const apDict = {
        Type: "XObject",
        Subtype: "Form",
        BBox: rect,
        Resources: highlighter
          ? { ExtGState: { H: { Type: "ExtGState", ca: HIGHLIGHTER_ALPHA, BM: "Multiply" } } }
          : {},
      };
      const apRef = ctx.register(compress ? deflated(ctx, content, apDict) : ctx.stream(content, apDict));

      // InkList：每筆的中心線（PDF 規格要求；其他軟體重新產生外觀時會用到）
      const inkList = list.map((s) =>
        simplifyPoints(s.points, 0.5).flatMap(([x, y]) => [round(x, 1), round(y, 1)]),
      );

      const [r, g, b] = parseColor(list[0].color).map((v) => round(v / 255, 3));
      const annot: Record<string, unknown> = {
        Type: "Annot",
        Subtype: "Ink",
        Rect: rect,
        InkList: inkList,
        C: [r, g, b],
        BS: { W: round(list[0].size, 1) },
        F: 4, // 列印時也要印出來
        P: page.ref,
        NM: PDFString.of(`pdftoolbox-ink-${pageIndex}-${n++}`),
        T: PDFString.of(AUTHOR),
        AP: { N: apRef },
      };
      if (includeData) {
        const data =
          dataFormat === "json"
            ? new TextEncoder().encode(JSON.stringify(list))
            : encodeStrokes(list);
        annot[INK_DATA_KEY] = ctx.register(compress ? deflated(ctx, data) : ctx.stream(data));
      }
      page.node.addAnnot(ctx.register(ctx.obj(annot as never)));
    }
  }
}

/**
 * 把筆跡直接畫進頁面內容（「合併」匯出）：任何 PDF 軟體都會顯示，但無法再個別選取或刪除筆跡。
 * 筆跡會先標準化（點精簡、四捨五入），與畫面上看到的一致。
 */
export function flattenInk(doc: PDFDocument, ink: Map<number, Stroke[]>, simplifyTolerance = 0.15): void {
  const ctx = doc.context;
  const pages = doc.getPages();
  for (const [pageIndex, strokes] of ink) {
    const page = pages[pageIndex];
    if (!page || strokes.length === 0) continue;
    const prepared = strokes.map((s) => normalizeStroke(s, simplifyTolerance)).filter((s) => s.points.length > 0);
    const pens = prepared.filter((s) => s.tool !== "highlighter");
    const highlights = prepared.filter((s) => s.tool === "highlighter");

    let content = "";
    // 螢光筆先畫（在下層），再畫鋼筆
    if (highlights.length) {
      page.node.setExtGState(PDFName.of("PTHighlight"), ctx.obj({ Type: "ExtGState", ca: HIGHLIGHTER_ALPHA, BM: "Multiply" }));
      content += "q /PTHighlight gs\n" + inkDrawing(highlights).content + "Q\n";
    }
    if (pens.length) content += "q\n" + inkDrawing(pens).content + "Q\n";

    // 原本的內容包在 q…Q 裡，避免它沒有還原的繪圖狀態（例如座標變換）影響筆跡位置
    page.node.wrapContentStreams(ctx.register(ctx.stream("q\n")), ctx.register(ctx.stream("Q\n")));
    page.node.addContentStream(ctx.register(deflated(ctx, content)));
  }
}

/**
 * 一組筆畫的 PDF 繪圖指令（每筆一個填色多邊形）與範圍。
 * 大量筆跡（數萬筆）時這裡是瓶頸：數字用整數運算格式化、內容先收集再一次接起來。
 */
function inkDrawing(strokes: Stroke[], prefix = "") {
  const parts: string[] = [prefix];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const outline = simplify2D(strokeOutline(s), 0.08);
    if (outline.length === 0) continue;
    const [r, g, b] = parseColor(s.color).map((v) => v / 255);
    parts.push(`${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg\n`);
    for (let j = 0; j < outline.length; j++) {
      const [x, y] = outline[j];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      parts.push(`${fmt1(x)} ${fmt1(y)} ${j === 0 ? "m" : "l"}\n`);
    }
    parts.push("h f\n");
  }
  return { content: parts.join(""), bounds: [x0, y0, x1, y1] as [number, number, number, number] };
}

/** 一位小數的快速格式化（12.30 → "12.3"，5.0 → "5"） */
function fmt1(v: number): string {
  const r = Math.round(v * 10);
  return r === 0 ? "0" : String(r / 10);
}

export interface InkAnnotationRef {
  pageIndex: number;
  ref: PDFRef;
}

/** 讀出 PDF 裡由我們寫入的筆跡（其他軟體加的註解會略過）。 */
export function readInk(doc: PDFDocument): Map<number, Stroke[]> {
  const result = new Map<number, Stroke[]>();
  for (const { pageIndex, dict } of inkAnnotations(doc)) {
    const dataRef = dict.get(PDFName.of(INK_DATA_KEY));
    const stream = dataRef instanceof PDFRef ? doc.context.lookup(dataRef) : dataRef;
    if (!(stream instanceof PDFRawStream)) continue;
    const bytes = decodePDFRawStream(stream).decode();
    const strokes = decodeStrokes(bytes);
    result.set(pageIndex, [...(result.get(pageIndex) ?? []), ...strokes]);
  }
  return result;
}

/**
 * 移除我們寫入的筆跡註解（編輯時改由程式自己畫筆跡，避免畫面重複）。
 * 回傳移除的註解數量。
 */
export function removeInk(doc: PDFDocument): number {
  let removed = 0;
  for (const { annots, ref, dict } of inkAnnotations(doc)) {
    const idx = annots.asArray().findIndex((r) => r === ref);
    if (idx >= 0) annots.remove(idx);
    // pdf-lib 存檔時會寫出所有物件（包含沒被引用的），所以要一併刪除
    for (const key of ["AP", INK_DATA_KEY]) {
      const v = dict.get(PDFName.of(key));
      if (key === "AP" && v instanceof PDFDict) {
        const n = v.get(PDFName.of("N"));
        if (n instanceof PDFRef) doc.context.delete(n);
      } else if (v instanceof PDFRef) {
        doc.context.delete(v);
      }
    }
    if (ref) doc.context.delete(ref);
    removed++;
  }
  return removed;
}

function* inkAnnotations(doc: PDFDocument) {
  const pages = doc.getPages();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const annots = pages[pageIndex].node.Annots();
    if (!annots) continue;
    // 先複製清單，呼叫端可能在迭代中刪除
    for (const item of [...annots.asArray()]) {
      const ref = item instanceof PDFRef ? item : undefined;
      const dict = doc.context.lookupMaybe(item, PDFDict);
      if (!dict || !dict.has(PDFName.of(INK_DATA_KEY))) continue;
      yield { pageIndex, annots, ref, dict };
    }
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** PDF 內容串流用的數字格式：最多 `digits` 位小數，去掉多餘的 0 */
function fmt(v: number, digits = 1): string {
  const s = round(v, digits).toFixed(digits).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

