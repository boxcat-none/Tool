import { PDFDocument } from "pdf-lib";
import { PdfToolError } from "./errors";

export type ImageFormat = "jpeg" | "png";

export interface ImageSource {
  data: Uint8Array | ArrayBuffer;
  format: ImageFormat;
  /** 用於錯誤訊息，通常是檔名 */
  name?: string;
}

export type PageSizeName = "fit" | "A4" | "Letter";
export type Orientation = "auto" | "portrait" | "landscape";

export interface ImagesToPdfOptions {
  /** fit：頁面大小等於圖片大小；A4 / Letter：固定紙張，圖片縮放置中 */
  pageSize?: PageSizeName;
  /** 固定紙張時的方向；auto 會依每張圖片的長寬自動決定 */
  orientation?: Orientation;
  /** 邊界，單位 pt（1 pt = 1/72 吋）；pageSize 為 fit 時也適用 */
  margin?: number;
}

/** 紙張尺寸（直式），單位 pt */
export const PAGE_SIZES: Record<Exclude<PageSizeName, "fit">, [number, number]> = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

/** 像素 → pt：以 96 DPI 計算，螢幕截圖印出來會是原本大小 */
const PX_TO_PT = 72 / 96;

/** 每張圖片一頁，依陣列順序產生 PDF。 */
export async function imagesToPdf(
  images: ImageSource[],
  options: ImagesToPdfOptions = {},
): Promise<Uint8Array> {
  const { pageSize = "A4", orientation = "auto", margin = 0 } = options;
  if (images.length === 0) {
    throw new PdfToolError("EMPTY_INPUT", "請至少加入一張圖片。");
  }
  if (!(margin >= 0)) {
    throw new PdfToolError("INVALID_RANGE", "邊界不能是負數。");
  }

  const doc = await PDFDocument.create();
  for (const img of images) {
    let embedded;
    try {
      embedded = img.format === "jpeg" ? await doc.embedJpg(img.data) : await doc.embedPng(img.data);
    } catch {
      throw new PdfToolError("INVALID_PDF", `「${img.name ?? "圖片"}」無法讀取，檔案可能已損毀。`);
    }

    const imgW = embedded.width * PX_TO_PT;
    const imgH = embedded.height * PX_TO_PT;

    let pageW: number;
    let pageH: number;
    if (pageSize === "fit") {
      pageW = imgW + margin * 2;
      pageH = imgH + margin * 2;
    } else {
      const [w, h] = PAGE_SIZES[pageSize];
      const landscape =
        orientation === "landscape" || (orientation === "auto" && imgW > imgH);
      [pageW, pageH] = landscape ? [h, w] : [w, h];
    }

    const boxW = pageW - margin * 2;
    const boxH = pageH - margin * 2;
    if (boxW <= 0 || boxH <= 0) {
      throw new PdfToolError("INVALID_RANGE", "邊界太大，頁面已經沒有空間放圖片。");
    }
    // 等比例縮放到可用範圍內（可放大也可縮小），然後置中
    const scale = Math.min(boxW / imgW, boxH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    const page = doc.addPage([pageW, pageH]);
    page.drawImage(embedded, {
      x: (pageW - drawW) / 2,
      y: (pageH - drawH) / 2,
      width: drawW,
      height: drawH,
    });
  }

  doc.setProducer("Tool PDF 工具箱");
  return doc.save();
}

/**
 * 讀取 JPEG 的 EXIF 方向（1–8），沒有 EXIF 時回傳 1。
 * 手機照片常常是「以橫向儲存 + EXIF 標示要轉正」，
 * 而 PDF 不認得 EXIF，所以呼叫端需要先把這類照片轉正。
 */
export function readJpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return 1;
    // SOS 之後就是影像資料，不會再有 EXIF
    if (marker === 0xffda) return 1;
    const size = view.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 10 <= bytes.length && view.getUint32(offset + 4) === 0x45786966) {
      return readTiffOrientation(view, offset + 10, offset + 2 + size);
    }
    offset += 2 + size;
  }
  return 1;
}

function readTiffOrientation(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end || end > view.byteLength) return 1;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
