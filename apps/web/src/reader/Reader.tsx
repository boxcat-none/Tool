import { useEffect, useRef, useState } from "react";
import { FileDrop } from "../components/FileDrop";
import { isPdf } from "../lib/format";
import { loadPdfViewer, openPdf, type OpenedPdf } from "../lib/pdfjs";
import "./reader.css";

/** 閱讀器（之後的筆記功能會加在這裡）。整個模組延遲載入，不影響工具頁的速度。 */
export default function Reader() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!file) {
    return (
      <div className="reader-empty">
        <div className="reader-empty__inner">
          <h1 className="panel__title">閱讀與筆記</h1>
          <p className="panel__desc">開啟 PDF 來閱讀。手寫筆記、插入白紙與格線頁正在製作中。</p>
          <FileDrop
            onFiles={([f]) => {
              setError(null);
              if (!isPdf(f)) return setError("不是 PDF 檔案");
              setFile(f);
            }}
            title="拖放 PDF 到這裡，或點擊選擇檔案"
          />
          {error && <p className="note note--error">{error}</p>}
        </div>
      </div>
    );
  }
  return <ReaderDocument file={file} onClose={() => setFile(null)} />;
}

type ZoomPreset = "page-width" | "page-fit" | "auto";
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

interface ViewerApi {
  goToPage(n: number): void;
  setScale(value: number | ZoomPreset): void;
  getScale(): number;
}

function ReaderDocument({ file, onClose }: { file: File; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const api = useRef<ViewerApi | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [preset, setPreset] = useState<ZoomPreset | null>("page-width");
  const [status, setStatus] = useState<"loading" | "ready" | { error: string }>("loading");

  useEffect(() => {
    let disposed = false;
    let opened: OpenedPdf | undefined;
    let cleanupViewer: (() => void) | undefined;

    (async () => {
      const lib = await loadPdfViewer();
      if (disposed) return;
      const eventBus = new lib.EventBus();
      const linkService = new lib.PDFLinkService({
        eventBus,
        externalLinkTarget: lib.LinkTarget.BLANK,
        externalLinkRel: "noopener noreferrer nofollow",
      });
      const viewer = new lib.PDFViewer({
        container: scrollRef.current!,
        viewer: innerRef.current!,
        eventBus,
        linkService,
        textLayerMode: 1, // 可以選取、複製文字
        maxCanvasPixels: 16_000_000,
      });
      linkService.setViewer(viewer);

      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
      });
      eventBus.on("pagechanging", (e: { pageNumber: number }) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
      });
      eventBus.on("scalechanging", (e: { scale: number; presetValue?: string }) => {
        setScale(e.scale);
        setPreset((e.presetValue as ZoomPreset) ?? null);
      });

      // 視窗大小改變時，「符合寬度／頁面」要重新計算
      const ro = new ResizeObserver(([entry]) => {
        // 切到工具頁時閱讀器被隱藏（尺寸變 0），這時不要重新計算
        if (entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
        const v = viewer.currentScaleValue;
        if (v === "page-width" || v === "page-fit" || v === "auto") viewer.currentScaleValue = v;
      });
      ro.observe(scrollRef.current!);

      api.current = {
        goToPage: (n) => {
          viewer.currentPageNumber = Math.max(1, Math.min(n, viewer.pagesCount));
        },
        setScale: (v) => {
          if (typeof v === "number") viewer.currentScale = v;
          else viewer.currentScaleValue = v;
        },
        getScale: () => viewer.currentScale,
      };
      cleanupViewer = () => {
        ro.disconnect();
        viewer.setDocument(null as never);
        linkService.setDocument(null);
      };

      opened = await openPdf(file);
      if (disposed) return void opened.task.destroy();
      viewer.setDocument(opened.doc);
      linkService.setDocument(opened.doc);
      setPageCount(opened.doc.numPages);
      setStatus("ready");
    })().catch((e: Error) => {
      if (disposed) return;
      setStatus({
        error:
          e?.name === "PasswordException"
            ? "這個 PDF 有密碼保護。輸入密碼開啟的功能即將推出。"
            : "無法開啟這個 PDF，檔案可能已損毀。",
      });
    });

    return () => {
      disposed = true;
      api.current = null;
      cleanupViewer?.();
      void opened?.task.destroy();
    };
  }, [file]);

  const zoom = (dir: 1 | -1) => {
    const current = api.current?.getScale() ?? scale;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > current + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001);
    if (next) api.current?.setScale(next);
  };

  // 鍵盤：Ctrl/⌘ + / - / 0 縮放
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") (e.preventDefault(), zoom(1));
      else if (e.key === "-") (e.preventDefault(), zoom(-1));
      else if (e.key === "0") (e.preventDefault(), api.current?.setScale("page-width"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commitPage = () => {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n)) api.current?.goToPage(n);
    else setPageInput(String(page));
  };

  return (
    <div className="reader">
      <div className="reader__toolbar" role="toolbar" aria-label="閱讀器工具列">
        <button type="button" className="icon" aria-label="關閉檔案" onClick={onClose}>✕</button>
        <span className="reader__title" title={file.name}>{file.name}</span>
        <span className="reader__spacer" />
        {status === "ready" && (
          <>
            <span className="reader__group">
              <button type="button" className="icon" aria-label="上一頁" disabled={page <= 1} onClick={() => api.current?.goToPage(page - 1)}>‹</button>
              <input
                className="reader__page"
                aria-label="目前頁碼"
                inputMode="numeric"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
                onBlur={commitPage}
                onKeyDown={(e) => e.key === "Enter" && commitPage()}
              />
              <span className="reader__count">/ {pageCount}</span>
              <button type="button" className="icon" aria-label="下一頁" disabled={page >= pageCount} onClick={() => api.current?.goToPage(page + 1)}>›</button>
            </span>
            <span className="reader__group">
              <button type="button" className="icon" aria-label="縮小" onClick={() => zoom(-1)}>−</button>
              <select
                className="reader__zoom"
                aria-label="縮放"
                value={preset ?? "custom"}
                onChange={(e) => api.current?.setScale(e.target.value as ZoomPreset)}
              >
                <option value="page-width">符合寬度</option>
                <option value="page-fit">符合頁面</option>
                <option value="custom" hidden>{Math.round(scale * 100)}%</option>
              </select>
              <span className="reader__percent">{Math.round(scale * 100)}%</span>
              <button type="button" className="icon" aria-label="放大" onClick={() => zoom(1)}>+</button>
            </span>
          </>
        )}
      </div>

      <div className="reader__body">
        <div ref={scrollRef} className="reader__scroll">
          <div ref={innerRef} className="pdfViewer" />
        </div>
        {status === "loading" && <div className="reader__overlay"><span className="spinner" aria-hidden="true" /> 開啟中…</div>}
        {typeof status === "object" && (
          <div className="reader__overlay">
            <div className="notice">
              <div className="notice__title">{status.error}</div>
              <div className="notice__actions"><button type="button" className="btn" onClick={onClose}>換一個檔案</button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
