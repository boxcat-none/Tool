import { PDFDocument } from "pdf-lib";
import { PdfToolError } from "./errors";
import { loadPdf, type PdfInput } from "./load";

export interface MergeSource {
  data: PdfInput;
  /** 用於錯誤訊息，通常是檔名 */
  name?: string;
}

/** 依照陣列順序把多個 PDF 合併成一個。 */
export async function mergePdfs(sources: MergeSource[]): Promise<Uint8Array> {
  if (sources.length === 0) {
    throw new PdfToolError("EMPTY_INPUT", "請至少加入一個 PDF 檔案。");
  }

  const output = await PDFDocument.create();
  for (const source of sources) {
    const doc = await loadPdf(source.data, source.name);
    const pages = await output.copyPages(doc, doc.getPageIndices());
    for (const page of pages) output.addPage(page);
  }

  output.setProducer("Tool PDF 工具箱");
  return output.save();
}
