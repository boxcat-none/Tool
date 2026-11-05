import type { Notebook, PaperTemplate } from "@tool/notes/notebook";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { PageThumb } from "../components/PageThumb";
import * as desktop from "../lib/desktop";
import { MAX_PAGE_CANVAS_PIXELS } from "../lib/device";
import type { Library, NotebookMeta } from "../lib/library";
import { notebookPdf, WRONG_PASSWORD } from "../lib/pdf";
import { loadPdfViewer, openPdf, type OpenedPdf } from "../lib/pdfjs";
import { platform } from "../lib/platform";
import { loadPosition, loadPref, savePosition, savePref } from "../lib/readingPosition";
import { createThumbnailer, type ThumbnailDoc } from "../lib/thumbnails";
import { attachTouchGestures } from "./gestures";
import { InkController, paintStrokes, type InkSettings, type RemoteLiveStroke } from "./ink";
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_SIZES, InkToolbar, PEN_COLORS, PEN_SIZES } from "./InkToolbar";
import { PasswordForm } from "./PasswordForm";
import { Awareness, SyncSession } from "@tool/notes/sync";
import { syncHub, type Peer } from "../sync/hub";
import { InviteDialog } from "../sync/SyncDialogs";
import { deviceName } from "../sync/webrtc";

/** 本機修改的標記：復原只會復原這個來源的動作 */
const LOCAL = "this-device";

type ZoomPreset = "page-width" | "page-fit" | "auto";
type SidebarView = "thumbs" | "outline";
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
/** pdf.js 的 FindState */
const FIND_NOT_FOUND = 1;
const FIND_PENDING = 3;

const PAPER: { value: PaperTemplate; label: string }[] = [
  { value: "blank", label: "空白" },
  { value: "lined", label: "橫線" },
  { value: "grid", label: "方格" },
  { value: "dot", label: "點陣" },
];

type UndoManager = ReturnType<Notebook["createUndoManager"]>;

interface OutlineNode {
  title: string;
  dest: unknown;
  url: string | null;
  items: OutlineNode[];
}

/** 目前顯示用的 PDF：原始 PDF（沒改過結構時），或由筆記本產生的 PDF */
interface Display {
  bytes: Uint8Array;
  /** 顯示的第 i 頁對應的筆記頁 */
  pageIds: string[];
  /** 就是原始 PDF（可以顯示目錄、有密碼時需要輸入） */
  plain: boolean;
  /** 載入後跳到這一頁 */
  focusPageId?: string;
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

interface ViewerParts {
  viewer: {
    currentPageNumber: number;
    currentScale: number;
    currentScaleValue: string;
    pagesCount: number;
    setDocument(doc: unknown): void;
  };
  linkService: { setDocument(doc: unknown): void; goToDestination(dest: unknown): Promise<void> };
  findController: { setDocument(doc: unknown): void };
  eventBus: { dispatch(name: string, data: unknown): void };
}

function loadInkSettings(): InkSettings {
  const num = (key: string, fallback: number, allowed: number[]) => {
    const v = Number(loadPref<string>(key, String(fallback)));
    return allowed.includes(v) ? v : fallback;
  };
  return {
    tool: "read", // 一開啟都是閱讀模式，避免誤畫
    penColor: loadPref<string>("penColor", PEN_COLORS[1]),
    penSize: num("penSize", PEN_SIZES[1], PEN_SIZES),
    highlighterColor: loadPref<string>("highlighterColor", HIGHLIGHTER_COLORS[0]),
    highlighterSize: num("highlighterSize", HIGHLIGHTER_SIZES[1], HIGHLIGHTER_SIZES),
    penOnly: loadPref<string>("penOnly", "false") === "true",
  };
}

/** 筆記本就是「原封不動的一份 PDF」時，回傳那份 PDF 的檔案代號（可以直接顯示原檔） */
function plainSource(nb: Notebook): string | null {
  const pages = nb.pageList;
  const first = pages[0]?.source;
  if (!first || first.kind !== "pdf") return null;
  const file = nb.getFile(first.fileId);
  if (!file?.pageCount || file.pageCount !== pages.length) return null;
  return pages.every((p, i) => p.source.kind === "pdf" && p.source.fileId === first.fileId && p.source.index === i)
    ? first.fileId
    : null;
}

interface Props {
  library: Library;
  notebookId: string;
  /** 剛從有密碼的 PDF 建立時，帶入使用者剛輸入的密碼 */
  initialPassword?: string;
  onClose: () => void;
}

export function NotebookView({ library, notebookId, initialPassword, onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const thumbListRef = useRef<HTMLDivElement>(null);

  const parts = useRef<ViewerParts | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const docRef = useRef<OpenedPdf | null>(null);
  /** 文件載入後要跳到的頁碼（pagesinit 時套用） */
  const pendingPage = useRef<number | null>(null);

  const [nb, setNb] = useState<Notebook | null>(null);
  const metaRef = useRef<NotebookMeta | null>(null);
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [encrypted, setEncrypted] = useState(false);
  const [display, setDisplay] = useState<Display | null>(null);
  const displayRef = useRef<Display | null>(null);
  displayRef.current = display;
  const [rebuilding, setRebuilding] = useState(false);
  const focusNext = useRef<string | null>(null);

  const [password, setPassword] = useState<string | undefined>(initialPassword);
  /** rebuild 是非同步的，用 ref 取得最新的密碼 */
  const passwordRef = useRef<string | undefined>(initialPassword);
  const nbRef = useRef<Notebook | null>(null);
  const peersRef = useRef<Peer[]>([]);
  const awarenessRef = useRef<Awareness | null>(null);
  /** 每台連上的裝置正在看第幾頁（key = Peer.key） */
  const [presence, setPresence] = useState<Record<number, number | undefined>>({});
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
  const thumbsRef = useRef<ThumbnailDoc | null>(null);
  const [thumbVersions, setThumbVersions] = useState<Record<number, number>>({});
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);

  const [ink, setInk] = useState<InkSettings>(loadInkSettings);
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const inkCtl = useRef<InkController | null>(null);
  const undoRef = useRef<UndoManager | null>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  /** 連上的其他裝置 */
  const [peers, setPeers] = useState<Peer[]>(() => syncHub.list(notebookId));
  const [inviteOpen, setInviteOpen] = useState(false);
  /** 「選取」工具選到的東西：圖片代號、"lasso"（套索選取）或 null */
  const [selection, setSelection] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findStatus, setFindStatus] = useState<FindStatus | null>(null);
  const positionKey = `nb:${notebookId}`;

  // ── 1. 建立 pdf.js 閱讀器（只做一次；之後換文件不必重建） ───────────
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
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
        textLayerMode: 1,
        maxCanvasPixels: MAX_PAGE_CANVAS_PIXELS,
      });
      linkService.setViewer(viewer);
      let saveTimer: number | undefined;

      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
        const target = pendingPage.current;
        pendingPage.current = null;
        if (target && target > 1 && target <= viewer.pagesCount) viewer.currentPageNumber = target;
      });
      eventBus.on("pagechanging", (e: { pageNumber: number }) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
        awarenessRef.current?.setLocalStateField("page", e.pageNumber);
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => savePosition(positionKey, e.pageNumber), 500);
      });
      eventBus.on("scalechanging", (e: { scale: number; presetValue?: string }) => {
        setScale(e.scale);
        setPreset((e.presetValue as ZoomPreset) ?? null);
      });
      eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => {
        setFindStatus((s) => ({ pending: s?.pending ?? false, notFound: false, ...e.matchesCount }));
      });
      eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
        setFindStatus({ ...e.matchesCount, pending: e.state === FIND_PENDING, notFound: e.state === FIND_NOT_FOUND });
      });
      // 頁面畫好（包含縮放後重畫）就掛上手寫層
      eventBus.on("pagerendered", (e: { source: Parameters<InkController["attach"]>[0] }) => inkCtl.current?.attach(e.source));

      const ro = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
        const v = viewer.currentScaleValue;
        if (v === "page-width" || v === "page-fit" || v === "auto") viewer.currentScaleValue = v;
      });
      ro.observe(scrollRef.current!);

      // 軟體版：外部連結交給系統瀏覽器
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

      // 觸控：兩指縮放與平移（iPad）；兩指放下時，手指正在畫的那一筆作廢
      const offGestures = attachTouchGestures(container, () => (viewer.pdfDocument ? viewer : undefined), {
        onPinchStart: () => inkCtl.current?.cancelTouchStroke(),
      });

      parts.current = { viewer, linkService, findController, eventBus } as unknown as ViewerParts;
      setViewerReady(true);
      cleanup = () => {
        window.clearTimeout(saveTimer);
        ro.disconnect();
        container.removeEventListener("click", onLinkClick, true);
        offGestures();
        findController.setDocument(null as never);
        viewer.setDocument(null as never);
        linkService.setDocument(null);
      };
    })();
    return () => {
      disposed = true;
      cleanup?.();
      parts.current = null;
      void docRef.current?.task.destroy();
      docRef.current = null;
    };
  }, [positionKey]);

  // ── 2. 開啟筆記本（內容自動儲存）、手寫層、復原 ─────────────────
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    (async () => {
      const [opened, meta] = await Promise.all([library.open(notebookId), library.get(notebookId)]);
      if (disposed) return opened.close();
      const notebook = opened.notebook;
      metaRef.current = meta ?? null;
      setTitle(notebook.title);
      setEncrypted(notebook.pageList.some((p) => p.source.kind === "pdf" && notebook.getFile(p.source.fileId)?.encrypted));

      const ctl = new InkController(notebook, (i) => displayRef.current?.pageIds[i], () => inkRef.current, LOCAL, () => {
        // 第一次用觸控筆：自動開啟「只用觸控筆」（手指用來捲動、縮放），只做一次，之後尊重使用者的選擇
        if (inkRef.current.penOnly || loadPref<string>("penAuto", "") === "done") return;
        savePref("penAuto", "done");
        setInk((s) => ({ ...s, penOnly: true }));
        setToast({ text: "偵測到觸控筆，已開啟「只用觸控筆」：手指用來捲動和縮放。" });
      }, (live) => awarenessRef.current?.setLocalStateField("live", live && encodeLive(live)),
      (fileId) => library.blobs.get(fileId),
      setSelection);
      inkCtl.current = ctl;
      const undo = notebook.createUndoManager(LOCAL);
      undoRef.current = undo;
      const syncHistory = () => setHistory({ undo: undo.undoStack.length > 0, redo: undo.redoStack.length > 0 });
      undo.on("stack-item-added", syncHistory);
      undo.on("stack-item-popped", syncHistory);

      // 書櫃資訊（標題、頁數、更新時間）
      let metaTimer: number | undefined;
      const offChange = notebook.onChange(({ local }) => {
        if (local) setDirty(true);
        else setTitle(notebook.title);
        window.clearTimeout(metaTimer);
        metaTimer = window.setTimeout(() => {
          const base = metaRef.current;
          const next: NotebookMeta = {
            id: notebook.id,
            title: notebook.title,
            createdAt: base?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            pageCount: notebook.pageIds.length,
            sourceHash: base?.sourceHash,
            fileIds: notebook.usedFileIds,
          };
          metaRef.current = next;
          void library.save(next);
        }, 800);
      });

      // 頁面結構改變（插頁、刪頁、移動、復原、其他裝置同步）→ 重新產生顯示用 PDF
      let rebuildTimer: number | undefined;
      const offPages = notebook.onPagesChange(() => {
        window.clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(() => void rebuild(notebook), 120);
      });
      // 筆跡或圖片改變 → 對應頁面的縮圖重畫
      const onPageContent = (ids: Set<string>) => {
        const d = displayRef.current;
        const t = thumbsRef.current;
        if (!d || !t) return;
        const changed: number[] = [];
        ids.forEach((id) => {
          const i = d.pageIds.indexOf(id);
          if (i >= 0) {
            t.invalidate(i);
            changed.push(i);
          }
        });
        if (changed.length) setThumbVersions((v) => Object.fromEntries([...Object.entries(v), ...changed.map((i) => [i, (v[i] ?? 0) + 1])]));
      };
      const offStrokes = notebook.onStrokesChange(onPageContent);
      const offImages = notebook.onImagesChange(onPageContent);

      // 其他裝置的同步：每條連線一個 SyncSession，共用一份線上狀態（awareness）
      const awareness = new Awareness(notebook.doc);
      awareness.setLocalState({ device: deviceName(), page: parts.current?.viewer.currentPageNumber ?? 1 });
      awarenessRef.current = awareness;
      // 對方的線上狀態：正在畫的筆畫、正在看的頁
      const onAwareness = () => {
        const live: RemoteLiveStroke[] = [];
        for (const [client, state] of awareness.getStates()) {
          if (client === awareness.clientID) continue;
          const l = decodeLive(state.live);
          if (l) live.push(l);
        }
        ctl.setRemoteLive(live);
        const pages: Record<number, number | undefined> = {};
        for (const [key, session] of sessions) {
          const state = session.peers.values().next().value;
          pages[key] = typeof state?.page === "number" ? state.page : undefined;
        }
        setPresence((old) => (JSON.stringify(old) === JSON.stringify(pages) ? old : pages));
      };
      awareness.on("change", onAwareness);
      const sessions = new Map<number, SyncSession>();
      const attachPeers = () => {
        const list = syncHub.list(notebookId);
        for (const [key, session] of sessions) {
          if (!list.some((p) => p.key === key)) {
            session.close();
            sessions.delete(key);
            const left = peersRef.current.find((p) => p.key === key);
            if (left && !disposed) setToast({ text: `與 ${left.remote.device} 的連線已中斷。` });
          }
        }
        for (const p of list) {
          if (sessions.has(p.key)) continue;
          sessions.set(
            p.key,
            new SyncSession(p.link, notebook, library.blobs, {
              // 對方傳來新的原始檔（例如插入了另一份 PDF 的頁面）→ 重新產生顯示用 PDF
              onFile: (fileId) => {
                ctl.redrawAll(); // 圖片檔到了：直接顯示
                // 原始 PDF 到了才需要重新產生顯示用 PDF（圖片不在裡面）
                if (pdfFileIds(notebook).includes(fileId)) void rebuild(notebook);
              },
              onError: (e) => setToast({ text: e.message, error: true }),
            }, awareness),
          );
        }
        peersRef.current = list;
        setPeers(list);
        onAwareness();
      };
      const offHub = syncHub.subscribe(notebookId, attachPeers);
      attachPeers();

      setNb(notebook);
      nbRef.current = notebook;
      await rebuild(notebook, true);
      cleanup = () => {
        offHub();
        awareness.off("change", onAwareness);
        awarenessRef.current = null;
        sessions.forEach((s) => s.close());
        // 離開筆記本就中斷連線
        syncHub.closeAll(notebookId);
        awareness.destroy();
        window.clearTimeout(metaTimer);
        window.clearTimeout(rebuildTimer);
        offChange();
        offPages();
        offStrokes();
        offImages();
        ctl.destroy();
        undo.destroy();
        inkCtl.current = null;
        undoRef.current = null;
        opened.close();
      };
    })().catch(() => {
      if (!disposed) setStatus({ kind: "error", message: "無法開啟這本筆記本。" });
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
    // rebuild 只用到 ref 與 library，不需要列入依賴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, notebookId]);

  /** 產生顯示用的 PDF：原封不動時直接用原檔，否則在 Worker 裡由筆記本產生 */
  async function rebuild(notebook: Notebook, first = false) {
    // 其他裝置剛插入用到新原始檔的頁面，檔案還在傳：收到後（onFile）會再呼叫一次
    if (syncHub.list(notebookId).length) {
      const has = await Promise.all(pdfFileIds(notebook).map((id) => library.blobs.has(id)));
      if (has.includes(false)) return;
    }
    const pageIds = notebook.pageIds;
    const prev = displayRef.current;
    const focusPageId =
      focusNext.current ?? (prev ? prev.pageIds[(parts.current?.viewer.currentPageNumber ?? 1) - 1] : undefined);
    focusNext.current = null;
    if (!first) setRebuilding(true);
    try {
      const plainId = plainSource(notebook);
      let bytes: Uint8Array;
      if (plainId) {
        const blob = await library.blobs.get(plainId);
        if (!blob) throw new Error("找不到原始檔案。");
        bytes = blob;
      } else {
        // 用到有密碼的原始檔：要先有密碼才能在 Worker 裡解密、重新產生
        const locked = encryptedFileIds(notebook);
        if (locked.length && !passwordRef.current) {
          setStatus({ kind: "password", wrong: false });
          return;
        }
        bytes = await notebookPdf(
          Y.encodeStateAsUpdate(notebook.doc),
          // 顯示用 PDF 不含圖片，只需要原始 PDF
          { ids: pdfFileIds(notebook), get: (id) => library.blobs.get(id) },
          "none",
          passwordsFor(notebook),
        );
      }
      setDisplay({
        bytes,
        pageIds,
        plain: !!plainId,
        focusPageId: first ? undefined : focusPageId && pageIds.includes(focusPageId) ? focusPageId : undefined,
      });
    } catch (e) {
      if ((e as Error).message === WRONG_PASSWORD) {
        passwordRef.current = undefined;
        setStatus({ kind: "password", wrong: true });
      } else {
        setToast({ text: (e as Error).message || "無法更新頁面。", error: true });
      }
    } finally {
      setRebuilding(false);
    }
  }

  /** 有密碼的原始檔都用使用者輸入的密碼（密碼只放在記憶體，不會儲存） */
  function passwordsFor(notebook: Notebook): Record<string, string> | undefined {
    const pw = passwordRef.current;
    if (!pw) return undefined;
    return Object.fromEntries(encryptedFileIds(notebook).map((id) => [id, pw]));
  }

  const submitPassword = (pw: string) => {
    passwordRef.current = pw;
    setStatus({ kind: "loading" });
    setPassword(pw);
    // 顯示的是重新產生的 PDF（不是原檔）時，要用密碼重新產生一次
    const notebook = nbRef.current;
    if (notebook && !plainSource(notebook)) void rebuild(notebook, !displayRef.current);
  };

  // ── 3. 顯示用 PDF 換了 → 載入到閱讀器 ──────────────────────
  useEffect(() => {
    if (!viewerReady || !display || !nb) return;
    let cancelled = false;
    (async () => {
      const p = parts.current!;
      let opened: OpenedPdf;
      try {
        // pdf.js 會把資料轉移到它的 Worker，所以傳一份複本
        opened = await openPdf(display.bytes.slice(), display.plain ? password : undefined);
      } catch (e) {
        const err = e as { name?: string; code?: number };
        if (cancelled) return;
        if (err?.name === "PasswordException") setStatus({ kind: "password", wrong: err.code === 2 });
        else setStatus({ kind: "error", message: "無法開啟這個 PDF，檔案可能已損毀。" });
        return;
      }
      if (cancelled) return void opened.task.destroy();
      const previous = docRef.current;
      docRef.current = opened;

      // 跳到哪一頁：插頁後的新頁、原本看的那一頁，或上次讀到的地方
      if (display.focusPageId) {
        pendingPage.current = display.pageIds.indexOf(display.focusPageId) + 1;
      } else if (!previous) {
        const last = loadPosition(positionKey);
        pendingPage.current = last;
        if (last && last > 1 && last <= display.pageIds.length) setResumed(last);
      }

      inkCtl.current?.reset();
      p.viewer.setDocument(opened.doc);
      p.linkService.setDocument(opened.doc);
      p.findController.setDocument(opened.doc);
      void previous?.task.destroy();
      setPageCount(opened.doc.numPages);

      thumbsRef.current?.destroy();
      const t = createThumbnailer(opened.doc, {
        decorate: (ctx, transform, index) => {
          const id = displayRef.current?.pageIds[index];
          if (!id) return;
          inkCtl.current?.paintImages(ctx, transform, id);
          paintStrokes(ctx, transform, nb.strokes(id).map((s) => s.stroke), 1.2);
        },
      });
      thumbsRef.current = t;
      setThumbs(t);
      setThumbVersions({});
      setStatus({ kind: "ready" });

      // 顯示用 PDF 由筆記本產生時，目錄已經對應到新頁碼（見 notes/outline.ts）
      const raw = await opened.doc.getOutline().catch(() => null);
      if (!cancelled) setOutline(raw ? raw.map(toNode) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewerReady, display, nb, password, positionKey]);

  useEffect(() => () => thumbsRef.current?.destroy(), []);

  // ── 其他效果 ─────────────────────────────────────────
  useEffect(() => {
    inkCtl.current?.refreshTool();
    savePref("penColor", ink.penColor);
    savePref("penSize", String(ink.penSize));
    savePref("highlighterColor", ink.highlighterColor);
    savePref("highlighterSize", String(ink.highlighterSize));
    savePref("penOnly", String(ink.penOnly));
  }, [ink]);

  // 無法自動儲存（例如私密瀏覽）而且有修改時，關閉分頁前提醒
  useEffect(() => {
    if (!dirty || library.persistent) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, library.persistent]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.error ? 8000 : 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (resumed === null) return;
    const t = window.setTimeout(() => setResumed(null), 6000);
    return () => window.clearTimeout(t);
  }, [resumed]);

  useEffect(() => {
    if (sidebar !== "thumbs") return;
    thumbListRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`)?.scrollIntoView({ block: "nearest" });
  }, [page, sidebar, thumbs]);

  // ── 動作 ─────────────────────────────────────────────
  const goToPage = (n: number) => {
    const v = parts.current?.viewer;
    if (v && v.pagesCount) v.currentPageNumber = Math.max(1, Math.min(n, v.pagesCount));
  };
  const setZoom = (value: number | ZoomPreset) => {
    const v = parts.current?.viewer;
    if (!v) return;
    if (typeof value === "number") v.currentScale = value;
    else v.currentScaleValue = value;
  };
  const zoom = (dir: 1 | -1) => {
    const current = parts.current?.viewer.currentScale ?? scale;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > current + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001);
    if (next) setZoom(next);
  };
  const find = (q: string, { again = false, previous = false } = {}) =>
    parts.current?.eventBus.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query: q,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
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
    parts.current?.eventBus.dispatch("findbarclose", { source: null });
  };
  const toggleSidebar = (view: SidebarView | null) => {
    setSidebar(view);
    if (!narrow()) savePref("sidebar", view ?? "none");
  };
  const navigate = (go: () => void) => {
    go();
    if (narrow()) setSidebar(null);
  };

  const structureBlocked = encrypted && !password ? "請先輸入 PDF 的開啟密碼" : undefined;

  const currentPageId = () => display?.pageIds[page - 1];

  const insertPage = (template: PaperTemplate) => {
    setInsertOpen(false);
    if (!nb || structureBlocked) return;
    const id = currentPageId();
    const info = id ? nb.getPage(id) : undefined;
    // 新頁和目前頁「看起來」一樣大小與方向
    const turned = info && (info.rotation === 90 || info.rotation === 270);
    const width = info ? (turned ? info.height : info.width) : 595.28;
    const height = info ? (turned ? info.width : info.height) : 841.89;
    const at = id ? nb.pageIds.indexOf(id) + 1 : nb.pageIds.length;
    let created: string[] = [];
    nb.doc.transact(() => {
      created = nb.insertPages(at, [{ source: { kind: "template", template }, width, height }]);
    }, LOCAL);
    focusNext.current = created[0];
  };

  /** 插入圖片：放在目前這一頁的中間，然後切到「選取」工具並選取它 */
  const insertImages = async (files: File[]) => {
    const notebook = nbRef.current;
    const ctl = inkCtl.current;
    const pageId = currentPageId();
    const info = pageId && notebook ? notebook.getPage(pageId) : undefined;
    if (!notebook || !ctl || !pageId || !info) return;
    const { prepareNoteImage, defaultImageSize } = await import("../lib/noteImage");
    let last: string | null = null;
    for (const [i, file] of files.entries()) {
      try {
        const img = await prepareNoteImage(file, file.name || "圖片");
        const fileId = await library.blobs.put(img.bytes);
        // 頁面有旋轉（例如掃描檔的橫向頁）時，圖片反方向轉回來，畫面上看起來才是正的
        const turned = info.rotation === 90 || info.rotation === 270;
        const shown = defaultImageSize(img, turned ? { width: info.height, height: info.width } : info);
        const size = turned ? { width: shown.height, height: shown.width } : shown;
        const rotation = ((360 - info.rotation) % 360) as 0 | 90 | 180 | 270;
        // 一次插入多張時稍微錯開
        const offset = i * 18;
        notebook.doc.transact(() => {
          notebook.addFile({ id: fileId, name: file.name || "圖片", mime: img.mime, size: img.bytes.length });
          last = notebook.addImage(pageId, {
            fileId,
            x: Math.max(0, (info.width - size.width) / 2 + offset),
            y: Math.max(0, (info.height - size.height) / 2 - offset),
            ...size,
            rotation,
          });
        }, LOCAL);
      } catch (e) {
        setToast({ text: (e as Error).message, error: true });
      }
    }
    if (last) {
      setInk((s) => ({ ...s, tool: "select" }));
      // 等工具切換生效後再選取
      window.setTimeout(() => inkCtl.current?.select(last), 0);
    }
  };

  const deletePage = (id: string) => {
    if (!nb || structureBlocked) return;
    const ids = nb.pageIds;
    if (ids.length <= 1) return setToast({ text: "至少要保留一頁。", error: true });
    const i = ids.indexOf(id);
    focusNext.current = ids[i + 1] ?? ids[i - 1];
    nb.doc.transact(() => nb.deletePages([id]), LOCAL);
    setToast({ text: "已刪除頁面（可以按復原救回）。" });
  };

  const movePage = (id: string, dir: -1 | 1) => {
    if (!nb || structureBlocked) return;
    const i = nb.pageIds.indexOf(id);
    const to = i + dir;
    if (to < 0 || to >= nb.pageIds.length) return;
    focusNext.current = id;
    nb.doc.transact(() => nb.movePage(id, to), LOCAL);
  };

  const commitTitle = (value: string) => {
    setEditingTitle(false);
    const v = value.trim();
    if (nb && v && v !== nb.title) {
      nb.title = v;
      setTitle(v);
    }
  };

  const exportNotes = async () => {
    if (!nb) return;
    setExporting(true);
    try {
      const data = await notebookPdf(
        Y.encodeStateAsUpdate(nb.doc),
        { ids: nb.usedFileIds, get: (id) => library.blobs.get(id) },
        "flatten",
        passwordsFor(nb),
      );
      const saved = await platform.saveFile({ name: `${safeName(title)}.pdf`, data });
      if (saved) setToast({ text: `${saved}。${encrypted ? "注意：匯出的 PDF 沒有密碼保護。" : ""}` });
    } catch (e) {
      setToast({ text: `匯出失敗：${(e as Error).message}`, error: true });
    } finally {
      setExporting(false);
    }
  };

  const saveNotebook = async () => {
    if (!nb) return;
    try {
      const { saveNotebookFile, NOTEBOOK_EXTENSION } = await import("@tool/notes/file");
      const data = await saveNotebookFile(nb, library.blobs);
      const saved = await platform.saveFile({ name: `${safeName(title)}.${NOTEBOOK_EXTENSION}`, data });
      if (saved) {
        setDirty(false);
        setToast({ text: `${saved}。` });
      }
    } catch (e) {
      setToast({ text: `儲存失敗：${(e as Error).message}`, error: true });
    }
  };

  const close = () => {
    if (dirty && !library.persistent && !window.confirm("這個瀏覽器無法自動儲存，關閉後筆記會遺失。確定要關閉嗎？")) return;
    onClose();
  };

  // 鍵盤快捷鍵（閱讀器隱藏時不作用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!scrollRef.current?.offsetParent || status.kind !== "ready") return;
      const mod = e.ctrlKey || e.metaKey;
      // 只有文字輸入框（頁碼、搜尋、標題）才算「正在打字」；勾選框、按鈕不影響快捷鍵
      const typing =
        (e.target instanceof HTMLInputElement && !["checkbox", "radio", "button", "color"].includes(e.target.type)) ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
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
        setZoom("page-width");
      } else if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveNotebook();
      } else if (!typing && mod && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undoRef.current?.undo();
      } else if (!typing && mod && (((e.key === "z" || e.key === "Z") && e.shiftKey) || e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        undoRef.current?.redo();
      } else if (!typing && !mod && (e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        inkCtl.current?.deleteSelection();
      } else if (!typing && e.key === "Escape" && selection) {
        inkCtl.current?.clearSelection();
      } else if (!typing && !mod && !e.altKey && ["v", "p", "h", "e", "s"].includes(e.key.toLowerCase())) {
        const tools = { v: "read", p: "pen", h: "highlighter", e: "eraser", s: "select" } as const;
        setInk((s) => ({ ...s, tool: tools[e.key.toLowerCase() as keyof typeof tools] }));
      } else if (!typing && !mod && e.key === "ArrowRight") {
        goToPage(page + 1);
      } else if (!typing && !mod && e.key === "ArrowLeft") {
        goToPage(page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 貼上圖片（例如截圖後 Ctrl+V）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length || status.kind !== "ready") return;
      e.preventDefault();
      void insertImages(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const commitPage = () => {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n)) goToPage(n);
    else setPageInput(String(page));
  };

  const ready = status.kind === "ready";

  return (
    <div className={`reader${ink.tool !== "read" ? " reader--drawing" : ""}`}>
      <div className="reader__toolbar" role="toolbar" aria-label="閱讀器工具列">
        <button type="button" className="icon" aria-label="回到書櫃" title="回到書櫃" onClick={close}>
          <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7" /></svg>
        </button>
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
        {editingTitle ? (
          <input
            className="reader__title-input"
            aria-label="筆記本名稱"
            autoFocus
            defaultValue={title}
            onBlur={(e) => commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle((e.target as HTMLInputElement).value);
              else if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <button type="button" className="reader__title" title="點一下修改名稱" onClick={() => setEditingTitle(true)}>
            {title || "未命名筆記本"}
          </button>
        )}
        <span className="reader__saved" aria-live="polite">
          {library.persistent ? (rebuilding ? "更新頁面中…" : "已自動儲存") : "不會自動儲存"}
        </span>
        <span className="reader__spacer" />
        {ready && (
          <>
            <button
              type="button"
              className={`btn reader__connect${peers.length ? " btn--on" : ""}`}
              aria-haspopup="dialog"
              title={peers.length ? peers.map((p) => `${p.remote.device}${presence[p.key] ? `：第 ${presence[p.key]} 頁` : ""}`).join("、") : "和其他裝置同時編輯這本筆記本"}
              onClick={() => setInviteOpen(true)}
            >
              {peers.length ? <><span className="sync__dot" aria-hidden="true" />已連線 {peers.length} 台</> : "連線"}
            </button>
            <span className="reader__menu">
              <button
                type="button"
                className={`btn reader__insert${insertOpen ? " btn--on" : ""}`}
                aria-haspopup="menu"
                aria-expanded={insertOpen}
                disabled={!!structureBlocked}
                title={structureBlocked ?? "在目前這一頁後面插入新頁"}
                onClick={() => setInsertOpen((o) => !o)}
              >
                ＋ 插入頁面
              </button>
              {insertOpen && (
                <div className="menu" role="menu" aria-label="插入頁面">
                  {PAPER.map((p) => (
                    <button key={p.value} type="button" role="menuitem" className="menu__item" onClick={() => insertPage(p.value)}>
                      <span className={`paper-icon paper-icon--${p.value}`} aria-hidden="true" />
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </span>
            <button type="button" className={`icon${searchOpen ? " icon--on" : ""}`} aria-label="搜尋（Ctrl+F）" aria-pressed={searchOpen} onClick={() => (searchOpen ? closeSearch() : openSearch())}>
              <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            </button>
            <span className="reader__group">
              <button type="button" className="icon" aria-label="上一頁" disabled={page <= 1} onClick={() => goToPage(page - 1)}>‹</button>
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
              <button type="button" className="icon" aria-label="下一頁" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>›</button>
            </span>
            <span className="reader__group">
              <button type="button" className="icon" aria-label="縮小" onClick={() => zoom(-1)}>−</button>
              <select className="reader__zoom" aria-label="縮放" value={preset ?? "custom"} onChange={(e) => setZoom(e.target.value as ZoomPreset)}>
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

      {ready && (
        <InkToolbar
          settings={ink}
          onChange={(patch) => setInk((s) => ({ ...s, ...patch }))}
          canUndo={history.undo}
          canRedo={history.redo}
          onUndo={() => undoRef.current?.undo()}
          onRedo={() => undoRef.current?.redo()}
          onExport={() => void exportNotes()}
          onInsertImage={() => imageInput.current?.click()}
          onSave={() => void saveNotebook()}
          exportBlocked={encrypted && !password ? "請先輸入 PDF 的開啟密碼" : undefined}
          exporting={exporting}
        />
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="選擇要插入的圖片"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void insertImages(files);
        }}
      />

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
              if (e.target.value) find(e.target.value);
              else setFindStatus(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query) find(query, { again: true, previous: e.shiftKey });
              else if (e.key === "Escape") closeSearch();
            }}
          />
          <span className="reader__search-count" aria-live="polite">
            {!query || !findStatus ? "" : findStatus.notFound ? "找不到" : findStatus.total > 0 ? `${findStatus.current} / ${findStatus.total}` : findStatus.pending ? "搜尋中…" : ""}
          </span>
          <button type="button" className="icon" aria-label="上一個符合項目" disabled={!findStatus?.total} onClick={() => find(query, { again: true, previous: true })}>↑</button>
          <button type="button" className="icon" aria-label="下一個符合項目" disabled={!findStatus?.total} onClick={() => find(query, { again: true })}>↓</button>
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
                  {v === "thumbs" ? "頁面" : "目錄"}
                </button>
              ))}
            </div>
            {sidebar === "thumbs" && thumbs && display && (
              <div className="side-thumbs" ref={thumbListRef}>
                {display.pageIds.map((id, i) => (
                  <div key={id} className={`side-thumb${page === i + 1 ? " side-thumb--active" : ""}`} data-page={i + 1}>
                    <button
                      type="button"
                      className="side-thumb__select"
                      aria-label={`第 ${i + 1} 頁`}
                      aria-current={page === i + 1 ? "page" : undefined}
                      onClick={() => navigate(() => goToPage(i + 1))}
                    >
                      <PageThumb doc={thumbs} index={i} version={thumbVersions[i] ?? 0} className="side-thumb__frame" />
                      <span className="side-thumb__num">{i + 1}</span>
                    </button>
                    {!structureBlocked && (
                      <span className="side-thumb__actions">
                        <button type="button" className="icon icon--sm" aria-label={`第 ${i + 1} 頁往前移`} disabled={i === 0} onClick={() => movePage(id, -1)}>↑</button>
                        <button type="button" className="icon icon--sm" aria-label={`第 ${i + 1} 頁往後移`} disabled={i === display.pageIds.length - 1} onClick={() => movePage(id, 1)}>↓</button>
                        <button type="button" className="icon icon--sm icon--danger" aria-label={`刪除第 ${i + 1} 頁`} onClick={() => deletePage(id)}>✕</button>
                      </span>
                    )}
                  </div>
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
                      navigate(() => (n.dest ? void parts.current?.linkService.goToDestination(n.dest) : n.url && openExternal(n.url)))
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
          {toast && (
            <div className={`reader__toast${toast.error ? " reader__toast--error" : ""}`} role={toast.error ? "alert" : "status"}>
              {toast.text}
            </div>
          )}
          {resumed !== null && !toast && (
            <div className="reader__toast" role="status">
              從上次讀到的第 {resumed} 頁繼續 ·{" "}
              <button type="button" className="link" onClick={() => (goToPage(1), setResumed(null))}>回到第 1 頁</button>
            </div>
          )}
          {inviteOpen && (
            <InviteDialog notebookId={notebookId} title={title} peers={peers} presence={presence} onGoToPage={(n) => (setInviteOpen(false), goToPage(n))} onClose={() => setInviteOpen(false)} />
          )}
          {status.kind === "loading" && <div className="reader__overlay"><span className="spinner" aria-hidden="true" /> 開啟中…</div>}
          {status.kind === "password" && (
            <div className="reader__overlay">
              <PasswordForm wrong={status.wrong} onSubmit={submitPassword} onCancel={onClose} />
            </div>
          )}
          {status.kind === "error" && (
            <div className="reader__overlay">
              <div className="notice">
                <div className="notice__title">{status.message}</div>
                <div className="notice__actions"><button type="button" className="btn" onClick={onClose}>回到書櫃</button></div>
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
  return { title: raw.title, dest: raw.dest, url: raw.url, items: (raw.items as (typeof raw)[]).map(toNode) };
}

function openExternal(url: string) {
  if (desktop.isDesktop) void desktop.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** 檔名不能有的字元換掉 */
function safeName(name: string): string {
  return (name.trim() || "筆記").replace(/[\\/:*?"<>|]/g, "_");
}

function encryptedFileIds(nb: Notebook): string[] {
  return nb.usedFileIds.filter((id) => nb.getFile(id)?.encrypted);
}

/**
 * 正在畫的筆畫放進 awareness 的格式：座標取到 0.1 pt、筆壓取到 0.01，攤平成一個數字陣列，
 * 每 50 毫秒送一次整筆（awareness 每次都送完整狀態）。
 */
interface LiveState {
  page: string;
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  pts: number[];
}

function encodeLive({ pageId, stroke }: RemoteLiveStroke): LiveState {
  const pts: number[] = [];
  for (const [x, y, p] of stroke.points) pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round((p ?? 0.5) * 100) / 100);
  return { page: pageId, tool: stroke.tool, color: stroke.color, size: stroke.size, pts };
}

function decodeLive(value: unknown): RemoteLiveStroke | null {
  const v = value as LiveState | null | undefined;
  if (!v || typeof v.page !== "string" || !Array.isArray(v.pts) || v.pts.length < 3) return null;
  if (v.tool !== "pen" && v.tool !== "highlighter") return null;
  const points: [number, number, number][] = [];
  for (let i = 0; i + 2 < v.pts.length; i += 3) points.push([v.pts[i], v.pts[i + 1], v.pts[i + 2]]);
  return { pageId: v.page, stroke: { tool: v.tool, color: String(v.color), size: Number(v.size) || 1, points } };
}

/** 頁面用到的原始 PDF（不含插入的圖片） */
function pdfFileIds(nb: Notebook): string[] {
  return [...new Set(nb.pageList.flatMap((p) => (p.source.kind === "pdf" ? [p.source.fileId] : [])))];
}
