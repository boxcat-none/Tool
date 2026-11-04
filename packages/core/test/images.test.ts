import { describe, expect, it } from "vitest";
import { imagesToPdf, PAGE_SIZES, readJpegOrientation } from "../src";
import { exifSegment, fakeJpeg, makePng, readSizes } from "./helpers";

const [A4W, A4H] = PAGE_SIZES.A4;

describe("imagesToPdf", () => {
  it("每張圖片一頁，PNG 與 JPEG 都可以", async () => {
    const out = await imagesToPdf(
      [
        { data: makePng(40, 20), format: "png" },
        { data: fakeJpeg(30, 60), format: "jpeg" },
      ],
      { pageSize: "fit" },
    );
    // 96 DPI → pt：40px = 30pt
    expect(await readSizes(out)).toEqual([[30, 15], [22.5, 45]]);
  });

  it("fit 模式加上邊界", async () => {
    const out = await imagesToPdf([{ data: makePng(40, 20), format: "png" }], {
      pageSize: "fit",
      margin: 10,
    });
    expect(await readSizes(out)).toEqual([[50, 35]]);
  });

  it("A4 自動方向：橫的圖片用橫式頁面", async () => {
    const out = await imagesToPdf(
      [
        { data: fakeJpeg(800, 600), format: "jpeg" },
        { data: fakeJpeg(600, 800), format: "jpeg" },
      ],
      { pageSize: "A4", orientation: "auto" },
    );
    expect(await readSizes(out)).toEqual([[A4H, A4W], [A4W, A4H]]);
  });

  it("A4 指定直式時不會自動轉向", async () => {
    const out = await imagesToPdf([{ data: fakeJpeg(800, 600), format: "jpeg" }], {
      pageSize: "Letter",
      orientation: "portrait",
    });
    expect(await readSizes(out)).toEqual([[612, 792]]);
  });

  it("錯誤處理", async () => {
    await expect(imagesToPdf([])).rejects.toMatchObject({ code: "EMPTY_INPUT" });
    await expect(
      imagesToPdf([{ data: new Uint8Array([1, 2, 3]), format: "png", name: "壞.png" }]),
    ).rejects.toThrow("壞.png");
    await expect(
      imagesToPdf([{ data: makePng(10, 10), format: "png" }], { pageSize: "A4", margin: 400 }),
    ).rejects.toThrow("邊界太大");
  });
});

describe("readJpegOrientation", () => {
  it("讀取 EXIF 方向", () => {
    for (const o of [1, 3, 6, 8]) expect(readJpegOrientation(fakeJpeg(10, 10, o))).toBe(o);
  });

  it("讀取 little-endian EXIF", () => {
    const seg = exifSegment(6);
    // 把 TIFF 區段改成 little-endian
    const tiff = 4 + 6;
    seg.splice(tiff, 8, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00);
    seg.splice(tiff + 8, 2, 0x01, 0x00);
    seg.splice(tiff + 10, 10, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00);
    const jpeg = Uint8Array.from([0xff, 0xd8, ...seg, 0xff, 0xd9]);
    expect(readJpegOrientation(jpeg)).toBe(6);
  });

  it("沒有 EXIF 或不是 JPEG 時回傳 1", () => {
    expect(readJpegOrientation(fakeJpeg(10, 10))).toBe(1);
    expect(readJpegOrientation(makePng(2, 2))).toBe(1);
    expect(readJpegOrientation(new Uint8Array())).toBe(1);
  });
});
