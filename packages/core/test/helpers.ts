import { PDFDocument } from "pdf-lib";

/**
 * 產生測試用 PDF，每頁寬度不同（寬度 = 100 + 頁面標記），
 * 用寬度就能辨識頁面來源與順序。
 */
export async function makePdf(markers: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const m of markers) doc.addPage([100 + m, 200]);
  return doc.save();
}

/** 讀回每頁的標記。 */
export async function readMarkers(data: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(data);
  return doc.getPages().map((p) => Math.round(p.getWidth()) - 100);
}

export async function makeEncryptedLookingPdf(): Promise<Uint8Array> {
  // pdf-lib 無法真的加密，這裡在 trailer 放一個 /Encrypt 字典，讓它被判定為加密檔
  const doc = await PDFDocument.create();
  doc.addPage();
  const encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2 });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return doc.save({ useObjectStreams: false });
}
