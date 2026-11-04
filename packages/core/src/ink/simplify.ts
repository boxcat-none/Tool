import type { InkPoint } from "./types";

/**
 * Ramer–Douglas–Peucker 點精簡：在誤差 `tolerance`（pt）以內刪掉多餘的點。
 * 筆壓也納入距離計算（乘上 `pressureWeight` 換算成 pt），
 * 避免把粗細變化明顯的點刪掉。
 */
export function simplifyPoints(points: InkPoint[], tolerance: number, pressureWeight = 2): InkPoint[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  // 用堆疊取代遞迴，長筆畫也不會爆堆疊
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(points[i], points[a], points[b], pressureWeight);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function distanceToSegment(p: InkPoint, a: InkPoint, b: InkPoint, w: number): number {
  const ax = a[0], ay = a[1], az = a[2] * w;
  const dx = b[0] - ax, dy = b[1] - ay, dz = b[2] * w - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 === 0 ? 0 : ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] * w - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - p[0], ey = ay + t * dy - p[1], ez = az + t * dz - p[2] * w;
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}
