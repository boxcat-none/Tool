import { PDFDocument, PDFName, PDFPage, PDFRef } from "pdf-lib";
import type { PaperTemplate } from "./types";

/**
 * 插入頁的紙張樣式。尺寸以公釐設計，換算成 pt（1 mm = 72/25.4 pt）。
 *
 * - 橫線：行距 8 mm，上方留 25 mm、下方留 12 mm（一般筆記本的寬行距）
 * - 方格：5 mm
 * - 點陣：5 mm
 */
const MM = 72 / 25.4;

export const PAPER_LABELS: Record<PaperTemplate, string> = {
  blank: "空白",
  lined: "橫線",
  grid: "方格",
  dot: "點陣",
};

/** 紙張樣式的 PDF 繪圖指令（空白回傳空字串） */
export function paperContent(template: PaperTemplate, width: number, height: number): string {
  const f = (n: number) => (Math.round(n * 100) / 100).toString();
  let c = "";
  switch (template) {
    case "blank":
      return "";
    case "lined": {
      c += "0.78 0.83 0.88 RG 0.5 w\n";
      const top = height - 25 * MM;
      for (let y = top; y >= 12 * MM; y -= 8 * MM) c += `${f(10 * MM)} ${f(y)} m ${f(width - 10 * MM)} ${f(y)} l\n`;
      c += "S\n";
      break;
    }
    case "grid": {
      c += "0.86 0.89 0.92 RG 0.4 w\n";
      const step = 5 * MM;
      // 從頁面中心向外排，讓左右、上下邊距相同
      const x0 = (width % step) / 2;
      const y0 = (height % step) / 2;
      for (let x = x0; x <= width - x0 + 0.01; x += step) c += `${f(x)} ${f(y0)} m ${f(x)} ${f(height - y0)} l\n`;
      for (let y = y0; y <= height - y0 + 0.01; y += step) c += `${f(x0)} ${f(y)} m ${f(width - x0)} ${f(y)} l\n`;
      c += "S\n";
      break;
    }
    case "dot": {
      // 每個點是 1 pt 的實心小方塊：所有 PDF 引擎都支援（「長度 0 的圓頭線」在部分引擎會消失），
      // 這個大小看起來和圓點一樣
      c += "0.6 0.65 0.71 rg\n";
      const step = 5 * MM;
      const x0 = (width % step) / 2 + step;
      const y0 = (height % step) / 2 + step;
      for (let y = y0; y <= height - step + 0.01; y += step) {
        for (let x = x0; x <= width - step + 0.01; x += step) c += `${f(x - 0.5)} ${f(y - 0.5)} 1 1 re `;
        c += "\n";
      }
      c += "f\n";
      break;
    }
  }
  return c;
}

/**
 * 在頁面畫上紙張樣式。同一份文件中，相同樣式與尺寸的頁面共用同一個 Form XObject，
 * 100 張橫線頁也只存一份格線。
 */
export class PaperPainter {
  private cache = new Map<string, PDFRef | null>();
  constructor(private doc: PDFDocument) {}

  paint(page: PDFPage, template: PaperTemplate, width: number, height: number): void {
    const key = `${template}|${width}x${height}`;
    let ref = this.cache.get(key);
    if (ref === undefined) {
      const content = paperContent(template, width, height);
      ref = content
        ? this.doc.context.register(
            this.doc.context.flateStream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, width, height] }),
          )
        : null;
      this.cache.set(key, ref);
    }
    if (!ref) return;
    page.node.setXObject(PDFName.of("PTPaper"), ref);
    page.node.addContentStream(this.doc.context.register(this.doc.context.stream("q /PTPaper Do Q\n")));
  }
}
