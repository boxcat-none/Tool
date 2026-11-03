import { PDFDocument } from "pdf-lib";
import { PdfToolError } from "./errors";

export type PdfInput = Uint8Array | ArrayBuffer;

/**
 * 載入 PDF，並把 pdf-lib 的錯誤轉成 PdfToolError。
 * `label` 用在錯誤訊息裡，通常是檔名。
 */
export async function loadPdf(data: PdfInput, label = "檔案"): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    // 先忽略加密載入，再自行檢查 isEncrypted；
    // pdf-lib 編譯成 ES5，它的 EncryptedPDFError 無法用 instanceof 判斷。
    doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new PdfToolError("INVALID_PDF", `「${label}」不是有效的 PDF，或檔案已損毀。`);
  }
  if (doc.isEncrypted) {
    throw new PdfToolError("ENCRYPTED", `「${label}」有密碼保護，請先解除加密再處理。`);
  }
  return doc;
}

export async function getPageCount(data: PdfInput, label?: string): Promise<number> {
  const doc = await loadPdf(data, label);
  return doc.getPageCount();
}
