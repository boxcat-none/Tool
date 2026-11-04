/**
 * 手寫筆跡的資料型別。
 *
 * 座標一律使用 PDF 的「使用者空間」：單位 pt（1/72 吋），原點在左下角、y 軸向上，
 * 不受頁面顯示旋轉影響。畫面顯示時再由 pdf.js 的 viewport 轉換。
 */

export type InkTool = "pen" | "highlighter";

/** 一個取樣點：x、y（pt）、筆壓（0–1） */
export type InkPoint = [x: number, y: number, pressure: number];

export interface Stroke {
  tool: InkTool;
  /** #rrggbb */
  color: string;
  /** 基本粗細（pt） */
  size: number;
  points: InkPoint[];
}
