import { degrees, PDFDocument } from "pdf-lib";
import { PdfToolError } from "./errors";
import { loadPdf, type PdfInput } from "./load";
import { normalizeRotation, type Rotation } from "./rotation";

export interface PageSpec {
  /** 原始文件中的頁面索引（0 起算） */
  index: number;
  /** 在原本角度上再順時針旋轉的角度 */
  rotate: Rotation;
}

/**
 * 依照 `pages` 的順序重新組成 PDF：沒列出的頁面會被刪除，
 * 每頁可以額外旋轉。同一頁可以出現多次（複製頁面）。
 */
export async function rearrangePdf(
  data: PdfInput,
  pages: PageSpec[],
  name?: string,
): Promise<Uint8Array> {
  if (pages.length === 0) {
    throw new PdfToolError("EMPTY_INPUT", "至少要保留一頁。");
  }

  const source = await loadPdf(data, name);
  const pageCount = source.getPageCount();
  for (const { index } of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
      throw new PdfToolError(
        "INVALID_RANGE",
        `頁碼 ${index + 1} 超出範圍，這份文件只有 ${pageCount} 頁。`,
      );
    }
  }

  const output = await PDFDocument.create();
  const copied = await output.copyPages(
    source,
    pages.map((p) => p.index),
  );
  copied.forEach((page, i) => {
    const extra = pages[i].rotate;
    if (extra) page.setRotation(degrees(normalizeRotation(page.getRotation().angle + extra)));
    output.addPage(page);
  });

  output.setProducer("Tool PDF 工具箱");
  return output.save();
}
