import { describe, expect, it } from "vitest";
import { mergePdfs, PdfToolError } from "../src";
import { makeEncryptedLookingPdf, makePdf, readMarkers } from "./helpers";

describe("mergePdfs", () => {
  it("依照輸入順序合併所有頁面", async () => {
    const a = await makePdf([1, 2]);
    const b = await makePdf([3]);
    const c = await makePdf([4, 5, 6]);

    const merged = await mergePdfs([{ data: c }, { data: a }, { data: b }]);

    expect(await readMarkers(merged)).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it("接受 ArrayBuffer", async () => {
    const a = await makePdf([1]);
    const merged = await mergePdfs([{ data: a.slice().buffer }]);
    expect(await readMarkers(merged)).toEqual([1]);
  });

  it("沒有輸入時丟出 EMPTY_INPUT", async () => {
    await expect(mergePdfs([])).rejects.toMatchObject({ code: "EMPTY_INPUT" });
  });

  it("無效檔案時的錯誤訊息帶有檔名", async () => {
    const bad = new TextEncoder().encode("not a pdf");
    const err = await mergePdfs([{ data: bad, name: "壞掉.pdf" }]).catch((e) => e);
    expect(err).toBeInstanceOf(PdfToolError);
    expect(err.code).toBe("INVALID_PDF");
    expect(err.message).toContain("壞掉.pdf");
  });

  it("加密檔案時丟出 ENCRYPTED", async () => {
    const enc = await makeEncryptedLookingPdf();
    await expect(mergePdfs([{ data: enc, name: "密.pdf" }])).rejects.toMatchObject({
      code: "ENCRYPTED",
    });
  });
});
