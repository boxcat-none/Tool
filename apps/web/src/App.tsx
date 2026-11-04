import { lazy, Suspense, useEffect, useState } from "react";
import { isDesktop } from "./lib/desktop";
import { ImagesTool } from "./tools/ImagesTool";
import { MergeTool } from "./tools/MergeTool";
import { OfficeTool } from "./tools/OfficeTool";
import { OrganizeTool } from "./tools/OrganizeTool";
import { SplitTool } from "./tools/SplitTool";
import { ToImagesTool } from "./tools/ToImagesTool";

const ALL_TOOLS = [
  { id: "merge", label: "合併 PDF", desc: "把多個 PDF 依順序合成一個", Component: MergeTool },
  { id: "split", label: "分割 PDF", desc: "把一個 PDF 拆成多個，或擷取部分頁面", Component: SplitTool },
  { id: "organize", label: "整理頁面", desc: "旋轉、刪除頁面，或拖拉調整頁面順序", Component: OrganizeTool },
  { id: "images", label: "JPG/PNG 轉 PDF", desc: "把多張 JPG、PNG 等圖片合成一個 PDF，每張圖片一頁", Component: ImagesTool },
  { id: "to-images", label: "PDF 轉 JPG/PNG", desc: "把 PDF 的每一頁轉成 PNG 或 JPG 圖片", Component: ToImagesTool },
  {
    id: "office",
    label: "Office 轉 PDF",
    desc: "把 Word、Excel、PowerPoint 檔案轉成 PDF（需要安裝 LibreOffice）",
    Component: OfficeTool,
    desktopOnly: true,
  },
] as const;

/** Office 轉 PDF 需要 LibreOffice，只有軟體版提供 */
const TOOLS = ALL_TOOLS.filter((t) => isDesktop || !("desktopOnly" in t));

type ToolId = (typeof ALL_TOOLS)[number]["id"];

/** 閱讀器（含 pdf.js 閱讀器元件）延遲載入，只用工具時不需要下載 */
const Reader = lazy(() => import("./reader/Reader"));

type Route = { mode: "reader" } | { mode: "tools"; tool: ToolId };

function currentRoute(): Route {
  const hash = location.hash.slice(1);
  if (hash === "reader") return { mode: "reader" };
  return { mode: "tools", tool: TOOLS.some((t) => t.id === hash) ? (hash as ToolId) : "merge" };
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [lastTool, setLastTool] = useState<ToolId>(route.mode === "tools" ? route.tool : "merge");
  // 開過閱讀器之後保持掛載（切到工具再切回來，開啟中的文件還在）
  const [readerMounted, setReaderMounted] = useState(route.mode === "reader");
  const toolId = route.mode === "tools" ? route.tool : lastTool;
  const tool = TOOLS.find((t) => t.id === toolId)!;

  // 手動修改網址或按上一頁時，切換到對應的畫面
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (route.mode === "reader") setReaderMounted(true);
    else setLastTool(route.tool);
  }, [route]);

  const go = (next: Route) => {
    setRoute(next);
    history.replaceState(null, "", `#${next.mode === "reader" ? "reader" : next.tool}`);
  };

  const reading = route.mode === "reader";

  return (
    <div className={`app${reading ? " app--reader" : ""}`}>
      <header className="header">
        <div className="brand">
          <img src="./favicon.svg" alt="" width={28} height={28} />
          <span>PDF 工具箱</span>
        </div>
        <nav className="mode-switch" aria-label="功能">
          <button type="button" className={`mode-btn${reading ? " mode-btn--active" : ""}`} aria-current={reading ? "page" : undefined} onClick={() => go({ mode: "reader" })}>
            閱讀與筆記
          </button>
          <button type="button" className={`mode-btn${!reading ? " mode-btn--active" : ""}`} aria-current={!reading ? "page" : undefined} onClick={() => go({ mode: "tools", tool: lastTool })}>
            PDF 工具
          </button>
        </nav>
        <p className="privacy">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" /></svg>
          {isDesktop ? "所有處理都在你的電腦上完成，檔案不會上傳" : "所有處理都在你的瀏覽器完成，檔案不會上傳"}
        </p>
      </header>

      {readerMounted && (
        <div className="reader-host" hidden={!reading}>
          <Suspense fallback={<div className="reader__overlay"><span className="spinner" aria-hidden="true" /></div>}>
            <Reader />
          </Suspense>
        </div>
      )}

      {!reading && (
      <>
      <nav className="tabs" role="tablist" aria-label="工具">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === toolId}
            className={`tab${t.id === toolId ? " tab--active" : ""}`}
            onClick={() => go({ mode: "tools", tool: t.id })}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="panel" role="tabpanel">
        <h1 className="panel__title">{tool.label}</h1>
        <p className="panel__desc">{tool.desc}</p>
        {/* key 讓切換工具時狀態重置 */}
        <tool.Component key={tool.id} />
      </main>
      </>
      )}
    </div>
  );
}
