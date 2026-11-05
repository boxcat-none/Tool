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
import { exportPdf, type BlobStore } from "@tool/notes";
import { Notebook } from "@tool/notes/notebook";
import * as Y from "yjs";

export interface RawImage {
  data: ArrayBuffer;
  name: string;
}

export type WorkerRequest =
  | { op: "pageCount"; data: ArrayBuffer; name: string }
  | { op: "merge"; sources: { data: ArrayBuffer; name: string }[] }
  | { op: "split"; data: ArrayBuffer; name: string; groups: PageGroup[] }
  | { op: "rearrange"; data: ArrayBuffer; name: string; pages: PageSpec[] }
  | { op: "images"; images: RawImage[]; options: ImagesToPdfOptions }
  | { op: "putBlob"; blobId: string; data: ArrayBuffer }
  | { op: "notebookPdf"; update: Uint8Array; ink: "none" | "flatten" | "annotations"; passwords?: Record<string, string> };

/** 密碼錯誤時回給主程式的訊息（主程式據此再問一次密碼） */
export const WRONG_PASSWORD = "PDF 的開啟密碼不正確。";

/**
 * 筆記本用到的原始檔快取在 Worker 裡：同一個檔案只需要傳一次，
 * 之後每次插頁、刪頁重新產生顯示用 PDF 時不必再複製一次大檔案。
 */
const blobCache = new Map<string, Uint8Array>();
const workerBlobs: BlobStore = {
  put: async () => {
    throw new Error("not supported");
  },
  get: async (id) => blobCache.get(id),
  has: async (id) => blobCache.has(id),
};

export type WorkerResponse =
  | { id: number; ok: true; result: number | Uint8Array | Uint8Array[] | null }
  | { id: number; ok: false; message: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<WorkerRequest & { id: number }>) => {
  const { id, ...req } = event.data;
  try {
    let result: number | Uint8Array | Uint8Array[] | null;
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
      case "putBlob":
        blobCache.set(req.blobId, new Uint8Array(req.data));
        result = null;
        break;
      case "notebookPdf": {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, req.update);
        // 顯示用（ink: none）不含圖片：閱讀器另外疊上圖片，才能即時移動
        result = await exportPdf(new Notebook(doc), workerBlobs, { ink: req.ink, passwords: req.passwords, images: req.ink !== "none" });
        doc.destroy();
        break;
      }
    }
    const transfer =
      typeof result === "number" || result === null
        ? []
        : (Array.isArray(result) ? result : [result]).map((r) => r.buffer as ArrayBuffer);
    self.postMessage({ id, ok: true, result } satisfies WorkerResponse, transfer);
  } catch (err) {
    const message =
      err instanceof PdfToolError || (err instanceof Error && /^(找不到原始檔案|「)/.test(err.message))
        ? err.message
        : err instanceof Error && /password/i.test(err.message)
          ? WRONG_PASSWORD
          : "處理時發生未預期的錯誤，請再試一次。";
    // 只記錄真正意外的錯誤（密碼錯誤、檔案損毀等是使用者會遇到的正常情況）
    if (message.startsWith("處理時發生未預期的錯誤")) console.error(err);
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
