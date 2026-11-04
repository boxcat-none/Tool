/// <reference lib="webworker" />
import {
  getPageCount,
  imagesToPdf,
  mergePdfs,
  PdfToolError,
  readJpegOrientation,
  rearrangePdf,
  splitPdf,
  type ImageSource,
  type ImagesToPdfOptions,
  type PageGroup,
  type PageSpec,
} from "@tool/core";

export interface RawImage {
  data: ArrayBuffer;
  name: string;
}

export type WorkerRequest =
  | { op: "pageCount"; data: ArrayBuffer; name: string }
  | { op: "merge"; sources: { data: ArrayBuffer; name: string }[] }
  | { op: "split"; data: ArrayBuffer; name: string; groups: PageGroup[] }
  | { op: "rearrange"; data: ArrayBuffer; name: string; pages: PageSpec[] }
  | { op: "images"; images: RawImage[]; options: ImagesToPdfOptions };

export type WorkerResponse =
  | { id: number; ok: true; result: number | Uint8Array | Uint8Array[] }
  | { id: number; ok: false; message: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<WorkerRequest & { id: number }>) => {
  const { id, ...req } = event.data;
  try {
    let result: number | Uint8Array | Uint8Array[];
    switch (req.op) {
      case "pageCount":
        result = await getPageCount(req.data, req.name);
        break;
      case "merge":
        result = await mergePdfs(req.sources);
        break;
      case "split":
        result = await splitPdf(req.data, req.groups, req.name);
        break;
      case "rearrange":
        result = await rearrangePdf(req.data, req.pages, req.name);
        break;
      case "images":
        result = await imagesToPdf(await Promise.all(req.images.map(prepareImage)), req.options);
        break;
    }
    const transfer =
      typeof result === "number"
        ? []
        : (Array.isArray(result) ? result : [result]).map((r) => r.buffer as ArrayBuffer);
    self.postMessage({ id, ok: true, result } satisfies WorkerResponse, transfer);
  } catch (err) {
    const message =
      err instanceof PdfToolError ? err.message : "處理時發生未預期的錯誤，請再試一次。";
    if (!(err instanceof PdfToolError)) console.error(err);
    self.postMessage({ id, ok: false, message } satisfies WorkerResponse);
  }
};

/**
 * 把圖片轉成 PDF 能直接嵌入的 JPEG 或 PNG：
 * - PNG、沒有旋轉資訊的 JPEG：原檔直接用，不損失畫質
 * - 帶 EXIF 方向的 JPEG（多數手機照片）：轉正後重新編碼，否則在 PDF 裡會是歪的
 * - 其他格式（WebP、GIF、BMP…）：用瀏覽器解碼後轉成 PNG
 */
async function prepareImage({ data, name }: RawImage): Promise<ImageSource> {
  const bytes = new Uint8Array(data);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

  if (isPng) return { data: bytes, format: "png", name };
  if (isJpeg && readJpegOrientation(bytes) === 1) return { data: bytes, format: "jpeg", name };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  } catch {
    throw new PdfToolError("INVALID_PDF", `「${name}」無法讀取，可能是不支援的格式（例如 HEIC）或檔案已損毀。`);
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();

  const format = isJpeg ? "jpeg" : "png";
  const blob = await canvas.convertToBlob(
    isJpeg ? { type: "image/jpeg", quality: 0.92 } : { type: "image/png" },
  );
  return { data: new Uint8Array(await blob.arrayBuffer()), format, name };
}
