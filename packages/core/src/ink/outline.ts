import { getStroke } from "perfect-freehand";
import type { Stroke } from "./types";

/**
 * 依筆壓算出筆畫外框（多邊形）。畫面顯示與寫入 PDF 都用這個函式，
 * 確保兩邊看到的筆跡完全一樣。
 */
export function strokeOutline(stroke: Stroke): [number, number][] {
  const highlighter = stroke.tool === "highlighter";
  return getStroke(stroke.points, {
    size: stroke.size,
    thinning: highlighter ? 0 : 0.6,
    smoothing: 0.5,
    streamline: highlighter ? 0.6 : 0.4,
    simulatePressure: false,
    last: true,
    // 螢光筆用平頭，鋼筆用圓頭
    start: { cap: !highlighter, taper: 0 },
    end: { cap: !highlighter, taper: 0 },
  }) as [number, number][];
}

/** 筆畫的外框範圍 [minX, minY, maxX, maxY] */
export function outlineBounds(outline: [number, number][]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
