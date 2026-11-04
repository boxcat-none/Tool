import { describe, expect, it } from "vitest";
import { imageFileName, rasterSize } from "../src";

describe("rasterSize", () => {
  it("依 DPI 換算像素", () => {
    // A4 = 595.28 × 841.89 pt
    expect(rasterSize(595.28, 841.89, 72)).toMatchObject({ width: 595, height: 841, clamped: false });
    expect(rasterSize(595.28, 841.89, 150)).toMatchObject({ width: 1240, height: 1753, clamped: false });
    expect(rasterSize(595.28, 841.89, 300)).toMatchObject({ width: 2480, height: 3507, clamped: false });
  });

  it("超過面積上限時降低解析度，並維持比例", () => {
    const r = rasterSize(1000, 1000, 720, 1_000_000);
    expect(r.clamped).toBe(true);
    expect(r.width).toBe(1000);
    expect(r.height).toBe(1000);
  });

  it("超過單邊上限時降低解析度", () => {
    // 很長的頁面：面積沒超過，但長邊超過
    const r = rasterSize(100, 10000, 72, 1e9, 4000);
    expect(r).toMatchObject({ width: 40, height: 4000, clamped: true });
  });

  it("尺寸至少 1 像素", () => {
    expect(rasterSize(0.1, 0.1, 72)).toMatchObject({ width: 1, height: 1 });
  });
});

describe("imageFileName", () => {
  it("頁碼依總頁數補零", () => {
    expect(imageFileName("報告", 0, 5, "png")).toBe("報告_p1.png");
    expect(imageFileName("報告", 2, 120, "jpg")).toBe("報告_p003.jpg");
    expect(imageFileName("a", 9, 10, "png")).toBe("a_p10.png");
  });
});
