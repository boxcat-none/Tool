import type { Stroke } from "@tool/core/ink/core";
import type { ImageInfo } from "./types";

/**
 * 套索選取的變換：以 (cx, cy) 為中心等比例縮放 `scale` 倍、順時針旋轉 `angle` 度，再平移 (dx, dy)。
 * 座標是 PDF 使用者空間（原點左下、y 向上）；「順時針」是以未旋轉的頁面來看，和圖片的 rotation 相同。
 *
 *   p' = c + scale · R(angle) · (p − c) + d
 *
 * 圖片只能轉 90 度的倍數（圖片框一律是水平的長方形），所以有圖片時 angle 必須是 90 的倍數。
 */
export interface ContentTransform {
  cx: number;
  cy: number;
  scale: number;
  /** 順時針角度（度） */
  angle: number;
  dx: number;
  dy: number;
}

export const IDENTITY: ContentTransform = { cx: 0, cy: 0, scale: 1, angle: 0, dx: 0, dy: 0 };

export const translation = (dx: number, dy: number): ContentTransform => ({ ...IDENTITY, dx, dy });

/** 轉成矩陣 [a, b, c, d, e, f]（x' = a·x + c·y + e，y' = b·x + d·y + f；和 canvas 的 transform 相同） */
export function transformMatrix(t: ContentTransform): [number, number, number, number, number, number] {
  const rad = (t.angle * Math.PI) / 180;
  // y 向上的座標系裡，順時針 = 數學上的負角度
  const cos = snapTrig(Math.cos(rad));
  const sin = snapTrig(Math.sin(rad));
  const a = t.scale * cos;
  const b = -t.scale * sin;
  const c = t.scale * sin;
  const d = t.scale * cos;
  return [a, b, c, d, t.cx + t.dx - (a * t.cx + c * t.cy), t.cy + t.dy - (b * t.cx + d * t.cy)];
}

export function transformPoint(t: ContentTransform, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = transformMatrix(t);
  return [a * x + c * y + e, b * x + d * y + f];
}

/** 筆畫：每個點套用變換，粗細跟著縮放 */
export function transformStroke(stroke: Stroke, t: ContentTransform): Stroke {
  const [a, b, c, d, e, f] = transformMatrix(t);
  return {
    ...stroke,
    size: stroke.size * t.scale,
    points: stroke.points.map(([x, y, p]) => [a * x + c * y + e, b * x + d * y + f, p]),
  };
}

export type ImageRect = Pick<ImageInfo, "x" | "y" | "width" | "height" | "rotation">;

/** 圖片：中心跟著移動，框跟著縮放；轉 90／270 度時框的寬高對調 */
export function transformImage(img: ImageRect, t: ContentTransform): ImageRect {
  const quarter = normalizeAngle(t.angle) / 90;
  if (!Number.isInteger(quarter)) throw new Error("圖片只能旋轉 90 度的倍數");
  const [cx, cy] = transformPoint(t, img.x + img.width / 2, img.y + img.height / 2);
  const swap = quarter % 2 === 1;
  const width = (swap ? img.height : img.width) * t.scale;
  const height = (swap ? img.width : img.height) * t.scale;
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotation: ((img.rotation + quarter * 90) % 360) as ImageInfo["rotation"],
  };
}

/** 角度換成 0 ≤ angle < 360 */
export function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** cos 90° 之類的值算出來是 6e-17，取成 0，90 度旋轉後座標才會剛好是整數 */
function snapTrig(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-12 ? r : v;
}
