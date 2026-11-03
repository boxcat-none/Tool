import { describe, expect, it } from "vitest";
import { groupsEachPage, parsePageRanges, splitPdf } from "../src";
import { makePdf, readMarkers } from "./helpers";

describe("splitPdf", () => {
  it("每組輸出一個 PDF", async () => {
    const src = await makePdf([1, 2, 3, 4, 5]);
    const outputs = await splitPdf(src, parsePageRanges("1-2, 5, 3-4", 5));
    expect(await Promise.all(outputs.map(readMarkers))).toEqual([[1, 2], [5], [3, 4]]);
  });

  it("每頁分割", async () => {
    const src = await makePdf([1, 2, 3]);
    const outputs = await splitPdf(src, groupsEachPage(3));
    expect(await Promise.all(outputs.map(readMarkers))).toEqual([[1], [2], [3]]);
  });

  it("擷取：多個範圍合成單一檔案", async () => {
    const src = await makePdf([1, 2, 3, 4, 5]);
    const [out] = await splitPdf(src, [parsePageRanges("5, 1-2", 5).flat()]);
    expect(await readMarkers(out)).toEqual([5, 1, 2]);
  });

  it("頁碼超出範圍時丟出 INVALID_RANGE", async () => {
    const src = await makePdf([1, 2]);
    await expect(splitPdf(src, [[0, 2]])).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(splitPdf(src, [])).rejects.toMatchObject({ code: "INVALID_RANGE" });
  });
});
