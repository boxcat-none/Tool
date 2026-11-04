import { degrees, PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { normalizeRotation, rearrangePdf } from "../src";
import { makePdf, readPages } from "./helpers";

describe("rearrangePdf", () => {
  it("依指定順序輸出，並刪除未列出的頁面", async () => {
    const src = await makePdf([1, 2, 3, 4]);
    const out = await rearrangePdf(src, [
      { index: 3, rotate: 0 },
      { index: 0, rotate: 0 },
    ]);
    expect(await readPages(out)).toEqual([{ m: 4, r: 0 }, { m: 1, r: 0 }]);
  });

  it("旋轉角度疊加在原本的角度上", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([101, 200]).setRotation(degrees(270));
    doc.addPage([102, 200]);
    const src = await doc.save();

    const out = await rearrangePdf(src, [
      { index: 0, rotate: 180 },
      { index: 1, rotate: 90 },
    ]);
    expect(await readPages(out)).toEqual([{ m: 1, r: 90 }, { m: 2, r: 90 }]);
  });

  it("同一頁可以出現多次", async () => {
    const src = await makePdf([1, 2]);
    const out = await rearrangePdf(src, [
      { index: 1, rotate: 0 },
      { index: 1, rotate: 270 },
    ]);
    expect(await readPages(out)).toEqual([{ m: 2, r: 0 }, { m: 2, r: 270 }]);
  });

  it("全部刪除或頁碼超出範圍時報錯", async () => {
    const src = await makePdf([1, 2]);
    await expect(rearrangePdf(src, [])).rejects.toMatchObject({ code: "EMPTY_INPUT" });
    await expect(rearrangePdf(src, [{ index: 2, rotate: 0 }])).rejects.toMatchObject({
      code: "INVALID_RANGE",
    });
  });
});

describe("normalizeRotation", () => {
  it.each([
    [0, 0], [90, 90], [360, 0], [450, 90], [-90, 270], [-450, 270], [180, 180],
  ])("%i → %i", (input, expected) => {
    expect(normalizeRotation(input)).toBe(expected);
  });
});
