/**
 * PDF 轉圖片用的計算（不依賴 pdf.js 或瀏覽器，方便測試）。
 * PDF 的尺寸單位是 pt，1 pt = 1/72 吋。
 */

/**
 * 瀏覽器 canvas 能處理的像素上限因瀏覽器而異（Safari 約 1,670 萬），
 * 取保守值，超過時自動降低解析度，避免輸出空白圖片。
 */
export const MAX_PIXELS = 16_000_000;
/** 單邊上限 */
export const MAX_SIDE = 8192;

export interface RasterSize {
  /** pdf.js 的縮放倍率（1 = 72 DPI） */
  scale: number;
  width: number;
  height: number;
  /** 是否因為超過上限而降低了解析度 */
  clamped: boolean;
}

/** 依目標 DPI 計算輸出圖片的像素尺寸。 */
export function rasterSize(
  widthPt: number,
  heightPt: number,
  dpi: number,
  maxPixels = MAX_PIXELS,
  maxSide = MAX_SIDE,
): RasterSize {
  let scale = dpi / 72;
  let clamped = false;

  const area = widthPt * heightPt * scale * scale;
  if (area > maxPixels) {
    scale = Math.sqrt(maxPixels / (widthPt * heightPt));
    clamped = true;
  }
  const side = Math.max(widthPt, heightPt) * scale;
  if (side > maxSide) {
    scale = maxSide / Math.max(widthPt, heightPt);
    clamped = true;
  }

  return {
    scale,
    width: Math.max(1, Math.floor(widthPt * scale)),
    height: Math.max(1, Math.floor(heightPt * scale)),
    clamped,
  };
}

/**
 * 每頁圖片的檔名，頁碼補零讓檔案總管排序正確：
 * imageFileName("報告", 2, 120, "png") → "報告_p003.png"
 */
export function imageFileName(base: string, index: number, pageCount: number, ext: string): string {
  const digits = String(pageCount).length;
  return `${base}_p${String(index + 1).padStart(digits, "0")}.${ext}`;
}
