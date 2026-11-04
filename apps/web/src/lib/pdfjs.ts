import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

/**
 * pdf.js 很大（約 1.7 MB），用動態 import，
 * 只有用到「整理頁面」或「PDF 轉圖片」時才會下載。
 */
let libPromise: Promise<typeof import("pdfjs-dist")> | undefined;

function loadPdfjs() {
  libPromise ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return libPromise;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
}

export async function openPdf(file: File): Promise<OpenedPdf> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  return { doc: await task.promise, task };
}
