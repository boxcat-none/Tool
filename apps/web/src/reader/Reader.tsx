import { useEffect, useRef, useState, type FormEvent } from "react";
import { FileDrop } from "../components/FileDrop";
import { PageThumb } from "../components/PageThumb";
import * as desktop from "../lib/desktop";
import { isPdf } from "../lib/format";
import { loadPdfViewer, openPdf, type OpenedPdf } from "../lib/pdfjs";
import { loadPosition, loadPref, savePosition, savePref } from "../lib/readingPosition";
import { createThumbnailer, type ThumbnailDoc } from "../lib/thumbnails";
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
  return <ReaderDocument key={`${file.name}-${file.size}-${file.lastModified}`} file={file} onClose={() => setFile(null)} />;
}

type ZoomPreset = "page-width" | "page-fit" | "auto";
type SidebarView = "thumbs" | "outline";
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** pdf.js 的 FindState */
const FIND_NOT_FOUND = 1;
const FIND_PENDING = 3;

interface OutlineNode {
  title: string;
  dest: unknown;
  url: string | null;
  items: OutlineNode[];
}

interface ViewerApi {
  goToPage(n: number): void;
  goToDest(dest: unknown): void;
  setScale(value: number | ZoomPreset): void;
  getScale(): number;
  find(query: string, opts: { again?: boolean; previous?: boolean }): void;
  closeFind(): void;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "password"; wrong: boolean }
  | { kind: "error"; message: string };

interface FindStatus {
  current: number;
  total: number;
  pending: boolean;
  notFound: boolean;
}

function ReaderDocument({ file, onClose }: { file: File; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const thumbListRef = useRef<HTMLDivElement>(null);
  const api = useRef<ViewerApi | null>(null);

  const [password, setPassword] = useState<string | undefined>(undefined);
  const [passwordInput, setPasswordInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [preset, setPreset] = useState<ZoomPreset | null>("page-width");

  const narrow = () => window.matchMedia("(max-width: 720px)").matches;
  const [sidebar, setSidebar] = useState<SidebarView | null>(() =>
    narrow() ? null : loadPref<SidebarView | "none">("sidebar", "thumbs") === "none" ? null : loadPref<SidebarView>("sidebar", "thumbs"),
  );
  const [thumbs, setThumbs] = useState<ThumbnailDoc | null>(null);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findStatus, setFindStatus] = useState<FindStatus | null>(null);

  // ── 開啟文件、建立 pdf.js 閱讀器 ───────────────────────────
  useEffect(() => {
    let disposed = false;
    let opened: OpenedPdf | undefined;
    let cleanup: (() => void) | undefined;
    setStatus({ kind: "loading" });

    (async () => {
      const lib = await loadPdfViewer();
      if (disposed) return;
      const eventBus = new lib.EventBus();
      const linkService = new lib.PDFLinkService({
        eventBus,
        externalLinkTarget: lib.LinkTarget.BLANK,
        externalLinkRel: "noopener noreferrer nofollow",
      });
      const findController = new lib.PDFFindController({ linkService, eventBus, updateMatchesCountOnProgress: true });
      const viewer = new lib.PDFViewer({
        container: scrollRef.current!,
        viewer: innerRef.current!,
        eventBus,
        linkService,
        findController,
        textLayerMode: 1, // 可以選取、複製、搜尋文字
        maxCanvasPixels: 16_000_000,
      });
      linkService.setViewer(viewer);

      let fingerprint: string | null = null;
      let saveTimer: number | undefined;

      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
        // 從上次讀到的地方繼續
        const last = fingerprint ? loadPosition(fingerprint) : null;
        if (last && last > 1 && last <= viewer.pagesCount) {
          viewer.currentPageNumber = last;
          setResumed(last);
        }
      });
      eventBus.on("pagechanging", (e: { pageNumber: number }) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
        if (fingerprint) {
          window.clearTimeout(saveTimer);
          const fp = fingerprint;
          saveTimer = window.setTimeout(() => savePosition(fp, e.pageNumber), 500);
        }
      });
      eventBus.on("scalechanging", (e: { scale: number; presetValue?: string }) => {
        setScale(e.scale);
        setPreset((e.presetValue as ZoomPreset) ?? null);
      });
      eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => {
        setFindStatus((s) => ({ pending: s?.pending ?? false, notFound: false, ...e.matchesCount }));
      });
      eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
        setFindStatus({
          ...e.matchesCount,
          pending: e.state === FIND_PENDING,
          notFound: e.state === FIND_NOT_FOUND,
        });
      });

      // 視窗大小改變時，「符合寬度／頁面」要重新計算
      const ro = new ResizeObserver(([entry]) => {
        // 切到工具頁時閱讀器被隱藏（尺寸變 0），這時不要重新計算
        if (entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
        const v = viewer.currentScaleValue;
        if (v === "page-width" || v === "page-fit" || v === "auto") viewer.currentScaleValue = v;
      });
      ro.observe(scrollRef.current!);

      // 軟體版：外部連結交給系統瀏覽器（程式視窗本身不跳轉）
      const container = scrollRef.current!;
      const onLinkClick = (e: MouseEvent) => {
        const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || !desktop.isDesktop) return;
        if (/^(https?:|mailto:)/i.test(a.href)) {
          e.preventDefault();
          e.stopPropagation();
          void desktop.openUrl(a.href);
        }
      };
      container.addEventListener("click", onLinkClick, true);

      api.current = {
        goToPage: (n) => {
          viewer.currentPageNumber = Math.max(1, Math.min(n, viewer.pagesCount));
        },
        goToDest: (dest) => void linkService.goToDestination(dest as never),
        setScale: (v) => {
          if (typeof v === "number") viewer.currentScale = v;
          else viewer.currentScaleValue = v;
        },
        getScale: () => viewer.currentScale,
        find: (q, { again = false, previous = false }) =>
          eventBus.dispatch("find", {
            source: null,
            type: again ? "again" : "",
            query: q,
            caseSensitive: false,
            entireWord: false,
            highlightAll: true,
            findPrevious: previous,
            matchDiacritics: false,
          }),
        closeFind: () => eventBus.dispatch("findbarclose", { source: null }),
      };

      let thumbnailer: ThumbnailDoc | undefined;
      cleanup = () => {
        window.clearTimeout(saveTimer);
        ro.disconnect();
        container.removeEventListener("click", onLinkClick, true);
        thumbnailer?.destroy();
        findController.setDocument(null as never);
        viewer.setDocument(null as never);
        linkService.setDocument(null);
      };

      opened = await openPdf(file, password);
      if (disposed) return void opened.task.destroy();
      fingerprint = opened.doc.fingerprints[0] ?? null;
      viewer.setDocument(opened.doc);
      linkService.setDocument(opened.doc);
      findController.setDocument(opened.doc);
      setPageCount(opened.doc.numPages);
      thumbnailer = createThumbnailer(opened.doc);
      setThumbs(thumbnailer);
      setStatus({ kind: "ready" });

      const raw = await opened.doc.getOutline().catch(() => null);
      if (!disposed) setOutline(raw ? raw.map(toNode) : []);
    })().catch((e: { name?: string; code?: number }) => {
      if (disposed) return;
      if (e?.name === "PasswordException") {
        // code 1 = 需要密碼，2 = 密碼錯誤
        setStatus({ kind: "password", wrong: e.code === 2 });
      } else {
        setStatus({ kind: "error", message: "無法開啟這個 PDF，檔案可能已損毀。" });
      }
    });

    return () => {
      disposed = true;
      api.current = null;
      cleanup?.();
      setThumbs(null);
      void opened?.task.destroy();
    };
  }, [file, password]);

  // 目前頁的縮圖保持在側邊欄看得到的位置
  useEffect(() => {
    if (sidebar !== "thumbs") return;
    thumbListRef.current
      ?.querySelector<HTMLElement>(`[data-page="${page}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [page, sidebar, thumbs]);

  // 「從第 N 頁繼續」提示幾秒後自動消失
  useEffect(() => {
    if (resumed === null) return;
    const t = window.setTimeout(() => setResumed(null), 6000);
    return () => window.clearTimeout(t);
  }, [resumed]);

  const zoom = (dir: 1 | -1) => {
    const current = api.current?.getScale() ?? scale;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > current + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001);
    if (next) api.current?.setScale(next);
  };

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setFindStatus(null);
    api.current?.closeFind();
  };

  const toggleSidebar = (view: SidebarView | null) => {
    setSidebar(view);
    if (!narrow()) savePref("sidebar", view ?? "none");
  };

  /** 從側邊欄跳頁：手機版的側邊欄蓋住內容，跳完就收起來 */
  const navigate = (go: () => void) => {
    go();
    if (narrow()) setSidebar(null);
  };

  // 鍵盤快捷鍵（閱讀器隱藏時不作用，避免搶走工具頁的 Ctrl+F）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!scrollRef.current?.offsetParent || status.kind !== "ready") return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoom(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoom(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        api.current?.setScale("page-width");
      } else if (!typing && !mod && e.key === "ArrowRight") {
        api.current?.goToPage(page + 1);
      } else if (!typing && !mod && e.key === "ArrowLeft") {
        api.current?.goToPage(page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commitPage = () => {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n)) api.current?.goToPage(n);
    else setPageInput(String(page));
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (passwordInput) setPassword(passwordInput);
  };

  const ready = status.kind === "ready";

  return (
    <div className="reader">
      <div className="reader__toolbar" role="toolbar" aria-label="閱讀器工具列">
        <button type="button" className="icon" aria-label="關閉檔案" onClick={onClose}>✕</button>
        {ready && (
          <button
            type="button"
            className={`icon${sidebar ? " icon--on" : ""}`}
            aria-label="側邊欄"
            aria-pressed={sidebar !== null}
            onClick={() => toggleSidebar(sidebar ? null : loadPref<SidebarView>("lastView", "thumbs"))}
          >
            <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15" /></svg>
          </button>
        )}
        <span className="reader__title" title={file.name}>{file.name}</span>
        <span className="reader__spacer" />
        {ready && (
          <>
            <button type="button" className={`icon${searchOpen ? " icon--on" : ""}`} aria-label="搜尋（Ctrl+F）" aria-pressed={searchOpen} onClick={() => (searchOpen ? closeSearch() : openSearch())}>
              <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            </button>
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

      {ready && searchOpen && (
        <div className="reader__search" role="search">
          <input
            ref={searchRef}
            className="reader__search-input"
            type="search"
            placeholder="搜尋文件內容"
            aria-label="搜尋文件內容"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) api.current?.find(e.target.value, {});
              else setFindStatus(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query) api.current?.find(query, { again: true, previous: e.shiftKey });
              else if (e.key === "Escape") closeSearch();
            }}
          />
          <span className="reader__search-count" aria-live="polite">
            {!query || !findStatus ? "" : findStatus.notFound ? "找不到" : findStatus.total > 0 ? `${findStatus.current} / ${findStatus.total}` : findStatus.pending ? "搜尋中…" : ""}
          </span>
          <button type="button" className="icon" aria-label="上一個符合項目" disabled={!findStatus?.total} onClick={() => api.current?.find(query, { again: true, previous: true })}>↑</button>
          <button type="button" className="icon" aria-label="下一個符合項目" disabled={!findStatus?.total} onClick={() => api.current?.find(query, { again: true })}>↓</button>
          <button type="button" className="icon" aria-label="關閉搜尋" onClick={closeSearch}>✕</button>
        </div>
      )}

      <div className="reader__main">
        {ready && sidebar && (
          <aside className="reader__sidebar" aria-label="側邊欄">
            <div className="reader__side-tabs" role="tablist">
              {(["thumbs", "outline"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={sidebar === v}
                  className={`side-tab${sidebar === v ? " side-tab--active" : ""}`}
                  onClick={() => {
                    toggleSidebar(v);
                    savePref("lastView", v);
                  }}
                >
                  {v === "thumbs" ? "縮圖" : "目錄"}
                </button>
              ))}
            </div>
            {sidebar === "thumbs" && thumbs && (
              <div className="side-thumbs" ref={thumbListRef}>
                {Array.from({ length: pageCount }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    data-page={i + 1}
                    className={`side-thumb${page === i + 1 ? " side-thumb--active" : ""}`}
                    aria-label={`第 ${i + 1} 頁`}
                    aria-current={page === i + 1 ? "page" : undefined}
                    onClick={() => navigate(() => api.current?.goToPage(i + 1))}
                  >
                    <PageThumb doc={thumbs} index={i} className="side-thumb__frame" />
                    <span className="side-thumb__num">{i + 1}</span>
                  </button>
                ))}
              </div>
            )}
            {sidebar === "outline" && (
              <div className="side-outline">
                {outline === null ? (
                  <p className="note">讀取中…</p>
                ) : outline.length === 0 ? (
                  <p className="note">這份文件沒有目錄（書籤）。</p>
                ) : (
                  <OutlineTree
                    nodes={outline}
                    depth={0}
                    onSelect={(n) =>
                      navigate(() => (n.dest ? api.current?.goToDest(n.dest) : n.url && openExternal(n.url)))
                    }
                  />
                )}
              </div>
            )}
          </aside>
        )}

        <div className="reader__body">
          <div ref={scrollRef} className="reader__scroll">
            <div ref={innerRef} className="pdfViewer" />
          </div>
          {resumed !== null && (
            <div className="reader__toast" role="status">
              從上次讀到的第 {resumed} 頁繼續 ·{" "}
              <button type="button" className="link" onClick={() => (api.current?.goToPage(1), setResumed(null))}>回到第 1 頁</button>
            </div>
          )}
          {status.kind === "loading" && <div className="reader__overlay"><span className="spinner" aria-hidden="true" /> 開啟中…</div>}
          {status.kind === "password" && (
            <div className="reader__overlay">
              <form className="notice reader__password" onSubmit={submitPassword}>
                <div className="notice__title">這個 PDF 有密碼保護</div>
                <label className="field">
                  <span className="field__label">請輸入開啟密碼</span>
                  <input
                    type="password"
                    autoFocus
                    autoComplete="off"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    aria-invalid={status.wrong}
                  />
                </label>
                {status.wrong && <p className="note note--error">密碼不正確，請再試一次。</p>}
                <div className="notice__actions">
                  <button type="submit" className="primary" disabled={!passwordInput}>開啟</button>
                  <button type="button" className="btn" onClick={onClose}>換一個檔案</button>
                </div>
              </form>
            </div>
          )}
          {status.kind === "error" && (
            <div className="reader__overlay">
              <div className="notice">
                <div className="notice__title">{status.message}</div>
                <div className="notice__actions"><button type="button" className="btn" onClick={onClose}>換一個檔案</button></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OutlineTree({ nodes, depth, onSelect }: { nodes: OutlineNode[]; depth: number; onSelect: (n: OutlineNode) => void }) {
  return (
    <ul className="outline" role={depth === 0 ? "tree" : "group"}>
      {nodes.map((n, i) => (
        <OutlineItem key={i} node={n} depth={depth} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function OutlineItem({ node, depth, onSelect }: { node: OutlineNode; depth: number; onSelect: (n: OutlineNode) => void }) {
  const [open, setOpen] = useState(depth === 0 && node.items.length <= 20);
  const hasChildren = node.items.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div className="outline__row" style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? (
          <button type="button" className="outline__toggle" aria-label={open ? "收合" : "展開"} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="outline__toggle" />
        )}
        <button type="button" className="outline__title" title={node.title} onClick={() => onSelect(node)}>
          {node.title || "（未命名）"}
        </button>
      </div>
      {hasChildren && open && <OutlineTree nodes={node.items} depth={depth + 1} onSelect={onSelect} />}
    </li>
  );
}

function toNode(raw: { title: string; dest: unknown; url: string | null; items: unknown[] }): OutlineNode {
  return {
    title: raw.title,
    dest: raw.dest,
    url: raw.url,
    items: (raw.items as (typeof raw)[]).map(toNode),
  };
}

function openExternal(url: string) {
  if (desktop.isDesktop) void desktop.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
