export type Rotation = 0 | 90 | 180 | 270;

/** 把旋轉角度正規化到 0、90、180、270（可接受負數，例如 -90 → 270）。 */
export function normalizeRotation(angle: number): Rotation {
  const r = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}
