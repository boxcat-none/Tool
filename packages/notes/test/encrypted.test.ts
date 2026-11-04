import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { exportPdf, MemoryBlobStore, Notebook } from "../src";

/** 有密碼的 PDF（用 @cantoo/pdf-lib 的加密功能產生），每頁寬 = 300 + 頁碼 */
async function encryptedPdf(pages: number, password: string) {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) doc.addPage([300 + i, 400]);
  await doc.encrypt({ userPassword: password, ownerPassword: password + "-owner" });
  return doc.save();
}

async function setup() {
  const bytes = await encryptedPdf(3, "secret");
  const blobs = new MemoryBlobStore();
  const nb = Notebook.create("加密");
  const fileId = await blobs.put(bytes);
  nb.addFile({ id: fileId, name: "加密.pdf", mime: "application/pdf", size: bytes.length, pageCount: 3, encrypted: true });
  nb.insertPages(0, [1, 2, 3].map((i) => ({ source: { kind: "pdf" as const, fileId, index: i - 1 }, width: 300 + i, height: 400 })));
  return { nb, blobs, fileId, bytes };
}

describe("有密碼的 PDF", () => {
  it("產生的測試檔確實有加密（沒有密碼讀不到頁面）", async () => {
    const { bytes } = await setup();
    await expect(PDFDocument.load(bytes)).rejects.toThrow();
  });

  it("提供密碼：可以插頁、調整順序並匯出，輸出沒有密碼保護", async () => {
    const { nb, blobs, fileId } = await setup();
    nb.insertPages(1, [{ source: { kind: "template", template: "lined" }, width: 595, height: 842 }]);
    nb.movePage(nb.pageIds[3], 0);
    nb.addStroke(nb.pageIds[0], { tool: "pen", color: "#1e40af", size: 2, points: [[10, 10, 0.5], [100, 100, 0.5]] });
    const out = await exportPdf(nb, blobs, { ink: "flatten", passwords: { [fileId]: "secret" } });
    const doc = await PDFDocument.load(out); // 不需要密碼就能開
    expect(doc.isEncrypted).toBe(false);
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([303, 301, 595, 302]);
  });

  it("密碼錯誤或沒給密碼時報錯", async () => {
    const { nb, blobs, fileId } = await setup();
    await expect(exportPdf(nb, blobs, { passwords: { [fileId]: "wrong" } })).rejects.toThrow(/password/i);
    await expect(exportPdf(nb, blobs)).rejects.toThrow("需要密碼");
  });
});
