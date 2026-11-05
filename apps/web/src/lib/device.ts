/** iPad、iPhone（iPadOS 13 以後的 Safari 會偽裝成 Mac，用觸控點數判斷） */
export const isIOS =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/**
 * 單一 canvas 的像素上限。iOS Safari 每個 canvas 最多約 1,670 萬像素，總記憶體也較少，
 * 所以 iPad 用較低的上限（超過時 pdf.js 會用 CSS 放大，稍微模糊但不會空白或當掉）。
 */
export const MAX_PAGE_CANVAS_PIXELS = isIOS ? 10_000_000 : 16_000_000;
export const MAX_INK_CANVAS_PIXELS = isIOS ? 6_000_000 : 16_000_000;
