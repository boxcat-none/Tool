import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { decodeStrokes, encodeStrokes, parseColor } from "./codec";
import { outlineBounds, strokeOutline } from "./outline";
import { normalizeStroke, simplifyPoints } from "./simplify";
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
  /** 是否寫入可編輯的原始資料。預設 true */
  includeData?: boolean;
}

const HIGHLIGHTER_ALPHA = 0.35;

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
    includeData = true,
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
      const outlines = list.map((s) => simplifyPoints(strokeOutline(s).map(([x, y]) => [x, y, 0]), 0.08));

      // 外觀內容串流：每筆一個填色多邊形
      let content = "";
      if (highlighter) content += "/H gs\n";
      for (let i = 0; i < list.length; i++) {
        const [r, g, b] = parseColor(list[i].color).map((v) => v / 255);
        content += `${fmt(r, 3)} ${fmt(g, 3)} ${fmt(b, 3)} rg\n`;
        outlines[i].forEach(([x, y], j) => (content += `${fmt(x)} ${fmt(y)} ${j === 0 ? "m" : "l"}\n`));
        content += "h f\n";
      }

      const bounds = outlines.reduce(
        (acc, o) => {
          if (o.length === 0) return acc;
          const [a, b, c, d] = outlineBounds(o.map(([x, y]) => [x, y]));
          return [Math.min(acc[0], a), Math.min(acc[1], b), Math.max(acc[2], c), Math.max(acc[3], d)];
        },
        [Infinity, Infinity, -Infinity, -Infinity],
      );
      const rect = [bounds[0] - 1, bounds[1] - 1, bounds[2] + 1, bounds[3] + 1].map((v) => round(v, 1));

      const apDict = {
        Type: "XObject",
        Subtype: "Form",
        BBox: rect,
        Resources: highlighter
          ? { ExtGState: { H: { Type: "ExtGState", ca: HIGHLIGHTER_ALPHA, BM: "Multiply" } } }
          : {},
      };
      const apRef = ctx.register(compress ? ctx.flateStream(content, apDict) : ctx.stream(content, apDict));

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
        annot[INK_DATA_KEY] = ctx.register(compress ? ctx.flateStream(data) : ctx.stream(data));
      }
      page.node.addAnnot(ctx.register(ctx.obj(annot as never)));
    }
  }
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

