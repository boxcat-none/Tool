import { imageFileName, rasterSize } from "@tool/core/raster";
import type { OutputFile } from "./platform";
import { openPdf } from "./pdfjs";

export type ImageType = "png" | "jpg";

export interface RasterizeOptions {
  format: ImageType;
  dpi: number;
  /** JPG 品質 0–1 */
  quality: number;
  /** 要輸出的頁面（0 起算） */
  pages: number[];
  onProgress?: (done: number, total: number) => void;
}

export interface RasterizeResult {
  files: OutputFile[];
  /** 有幾頁因為太大而自動降低了解析度 */
  clampedCount: number;
}

/** 用 pdf.js 把 PDF 頁面畫成 PNG 或 JPG。 */
export async function rasterizePdf(file: File, opts: RasterizeOptions): Promise<RasterizeResult> {
  const { doc, task } = await openPdf(file);
  const base = file.name.replace(/\.pdf$/i, "");
  const files: OutputFile[] = [];
  let clampedCount = 0;

  try {
    for (const [i, index] of opts.pages.entries()) {
      opts.onProgress?.(i, opts.pages.length);
      const page = await doc.getPage(index + 1);
      const unit = page.getViewport({ scale: 1 });
      const size = rasterSize(unit.width, unit.height, opts.dpi);
      if (size.clamped) clampedCount++;

      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const viewport = page.getViewport({ scale: size.scale });
      // 白色底：沒有背景的 PDF 轉成 JPG 才不會變黑
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      page.cleanup();

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, opts.format === "png" ? "image/png" : "image/jpeg", opts.quality),
      );
      // 釋放 canvas 記憶體
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error(`第 ${index + 1} 頁轉換失敗，可能是頁面太大，請降低解析度再試一次。`);

      files.push({
        name: imageFileName(base, index, doc.numPages, opts.format),
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    opts.onProgress?.(opts.pages.length, opts.pages.length);
  } finally {
    void task.destroy();
  }
  return { files, clampedCount };
}

/** 取得第一頁的尺寸（pt），用來預估輸出像素。 */
export async function firstPageSize(file: File): Promise<{ width: number; height: number }> {
  const { doc, task } = await openPdf(file);
  try {
    const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  } finally {
    void task.destroy();
  }
}
