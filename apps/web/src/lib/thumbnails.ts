import type { PDFDocumentProxy } from "pdfjs-dist";
import { openPdf } from "./pdfjs";

/** 用 pdf.js 產生頁面縮圖。 */
export interface ThumbnailDoc {
  pageCount: number;
  /** 取得某頁（0 起算）的縮圖網址；同一頁只會畫一次（除非 invalidate） */
  get(index: number): Promise<string>;
  /** 該頁內容（例如筆跡）改變了，下次 get 時重畫 */
  invalidate(index: number): void;
  destroy(): void;
}

/** 在縮圖上加畫內容（例如筆跡）。transform 把 PDF 座標轉成縮圖像素 */
export type ThumbnailDecorator = (ctx: CanvasRenderingContext2D, transform: number[], index: number) => void;

/** 縮圖長邊的像素數（已考慮高解析度螢幕） */
const THUMB_SIZE = Math.round(150 * Math.min(window.devicePixelRatio || 1, 2));

export async function openThumbnails(file: File): Promise<ThumbnailDoc> {
  const { doc, task } = await openPdf(file);
  const thumbs = createThumbnailer(doc, { releasePages: true });
  return {
    ...thumbs,
    destroy() {
      thumbs.destroy();
      void task.destroy();
    },
  };
}

/**
 * 用已開啟的文件產生縮圖（閱讀器用，不必再開一次檔案）。destroy 只釋放縮圖，不關閉文件。
 * `releasePages`：畫完就釋放頁面資源；文件同時被閱讀器使用時不要開，以免閱讀器要重新解析頁面。
 */
export function createThumbnailer(
  doc: PDFDocumentProxy,
  { releasePages = false, decorate }: { releasePages?: boolean; decorate?: ThumbnailDecorator } = {},
): ThumbnailDoc {

  const cache = new Map<number, Promise<string>>();
  const urls = new Map<number, string>();
  // 一次只畫一頁，避免大文件同時佔用太多記憶體
  let queue: Promise<unknown> = Promise.resolve();
  let destroyed = false;

  const render = async (index: number): Promise<string> => {
    if (destroyed) throw new Error("destroyed");
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_SIZE / Math.max(base.width, base.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    if (releasePages) page.cleanup();
    if (decorate) {
      const ctx = canvas.getContext("2d")!;
      decorate(ctx, viewport.transform, index);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("toBlob failed");
    const url = URL.createObjectURL(blob);
    const old = urls.get(index);
    urls.set(index, url);
    // 舊的網址晚一點再釋放，畫面換成新縮圖前不會閃一下空白
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    return url;
  };

  return {
    pageCount: doc.numPages,
    get(index) {
      let p = cache.get(index);
      if (!p) {
        p = queue.then(() => render(index));
        queue = p.catch(() => undefined);
        cache.set(index, p);
      }
      return p;
    },
    invalidate(index) {
      cache.delete(index);
    },
    destroy() {
      destroyed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
    },
  };
}
