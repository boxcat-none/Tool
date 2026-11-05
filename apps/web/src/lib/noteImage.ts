/**
 * 插入筆記本的圖片：轉成 PDF 能直接嵌入、各裝置都能顯示的 JPEG 或 PNG。
 *
 * - 手機照片依 EXIF 轉正（PDF 不認得 EXIF 方向）
 * - JPEG 一律重新編碼：順便移除拍攝地點等 EXIF 資料，不會跟著筆記本分享出去
 * - 長邊超過 MAX_SIDE 時縮小：手機照片動輒 4000 px，同步與匯出都會變慢，筆記用不到這麼大
 * - 不大的 PNG 保留原檔（截圖、圖表不損失畫質）；WebP、GIF 等轉成 PNG（保留透明）
 */

export const MAX_SIDE = 2400;
const JPEG_QUALITY = 0.88;
/** PNG 超過這個大小就改用較小的尺寸重新編碼 */
const MAX_PNG_BYTES = 4 * 1024 * 1024;

export interface PreparedImage {
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
  /** 像素大小（已轉正） */
  width: number;
  height: number;
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

export async function prepareNoteImage(file: Blob, name = "圖片"): Promise<PreparedImage> {
  const original = new Uint8Array(await file.arrayBuffer());
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([original]), { imageOrientation: "from-image" });
  } catch {
    throw new Error(`「${name}」無法讀取，可能是不支援的格式（例如 HEIC）或檔案已損毀。`);
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));

  if (isPng(original) && scale === 1 && original.length <= MAX_PNG_BYTES) {
    bitmap.close();
    return { bytes: original, mime: "image/png", width, height };
  }

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const mime = isJpeg(original) ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, mime === "image/jpeg" ? JPEG_QUALITY : undefined));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error(`「${name}」無法轉換。`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, width: w, height: h };
}

/**
 * 圖片放到頁面上的預設大小（pt）：以 96 DPI 換算，但不超過頁面寬度的 60%、高度的 60%。
 */
export function defaultImageSize(px: { width: number; height: number }, page: { width: number; height: number }) {
  let w = px.width * 0.75;
  let h = px.height * 0.75;
  const fit = Math.min(1, (page.width * 0.6) / w, (page.height * 0.6) / h);
  w *= fit;
  h *= fit;
  return { width: w, height: h };
}
