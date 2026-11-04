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
    // pdf.js 的閱讀器元件（pdf_viewer.mjs）從這個全域變數取得 pdf.js 本體
    (globalThis as unknown as { pdfjsLib: typeof lib }).pdfjsLib = lib;
    return lib;
  });
  return libPromise;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
}

/** pdf.js 資源檔的位置（由 vite.config.ts 的 pdfjsAssets 提供） */
function assetUrl(dir: string): string {
  return new URL(`pdfjs/${dir}/`, document.baseURI).href;
}

/** 所有開啟 PDF 的地方共用的設定 */
export function documentParams() {
  return {
    // 中文等字型對照表：PDF 沒有內嵌字型時，沒有它中文字會整個消失
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
    iccUrl: assetUrl("iccs"),
    // 不執行 PDF 內嵌的 JavaScript
    isEvalSupported: false,
    enableXfa: false,
  };
}

export async function openPdf(file: File | Uint8Array, password?: string): Promise<OpenedPdf> {
  const lib = await loadPdfjs();
  const data = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({ data, password, ...documentParams() });
  return { doc: await task.promise, task };
}

/** 載入 pdf.js 的閱讀器元件（必須在 pdf.js 本體之後載入） */
export async function loadPdfViewer() {
  await loadPdfjs();
  const [viewer] = await Promise.all([
    import("pdfjs-dist/web/pdf_viewer.mjs"),
    import("pdfjs-dist/web/pdf_viewer.css"),
  ]);
  return viewer;
}
