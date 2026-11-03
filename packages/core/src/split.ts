import { PDFDocument } from "pdf-lib";
import { PdfToolError } from "./errors";
import { loadPdf, type PdfInput } from "./load";
import type { PageGroup } from "./pageRange";

/** 依照頁面分組把一個 PDF 拆成多個，每組產生一個 PDF。 */
export async function splitPdf(
  data: PdfInput,
  groups: PageGroup[],
  name?: string,
): Promise<Uint8Array[]> {
  if (groups.length === 0 || groups.some((g) => g.length === 0)) {
    throw new PdfToolError("INVALID_RANGE", "沒有可輸出的頁面。");
  }

  const source = await loadPdf(data, name);
  const pageCount = source.getPageCount();
  for (const index of groups.flat()) {
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
      throw new PdfToolError(
        "INVALID_RANGE",
        `頁碼 ${index + 1} 超出範圍，這份文件只有 ${pageCount} 頁。`,
      );
    }
  }

  const outputs: Uint8Array[] = [];
  for (const group of groups) {
    const output = await PDFDocument.create();
    const pages = await output.copyPages(source, group);
    for (const page of pages) output.addPage(page);
    output.setProducer("Tool PDF 工具箱");
    outputs.push(await output.save());
  }
  return outputs;
}
