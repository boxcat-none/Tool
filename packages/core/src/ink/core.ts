/**
 * 筆跡的核心功能（編碼、精簡、外框），不含 PDF 讀寫。
 * 畫面上即時書寫只需要這些，不必載入 pdf-lib（約 400 KB）。
 */
export { COORD_SCALE, decodeStroke, decodeStrokes, encodeStroke, encodeStrokes } from "./codec";
export { outlineBounds, strokeOutline } from "./outline";
export { normalizeStroke, simplifyPoints } from "./simplify";
export type { InkPoint, InkTool, Stroke } from "./types";
