import { useState } from "react";
import { MergeTool } from "./tools/MergeTool";
import { SplitTool } from "./tools/SplitTool";

const TOOLS = [
  { id: "merge", label: "合併 PDF", desc: "把多個 PDF 依順序合成一個", Component: MergeTool },
  { id: "split", label: "分割 PDF", desc: "把一個 PDF 拆成多個，或擷取部分頁面", Component: SplitTool },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];

function initialTool(): ToolId {
  const hash = location.hash.slice(1);
  return TOOLS.some((t) => t.id === hash) ? (hash as ToolId) : "merge";
}

export function App() {
  const [toolId, setToolId] = useState<ToolId>(initialTool);
  const tool = TOOLS.find((t) => t.id === toolId)!;

  const select = (id: ToolId) => {
    setToolId(id);
    history.replaceState(null, "", `#${id}`);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src="./favicon.svg" alt="" width={28} height={28} />
          <span>PDF 工具箱</span>
        </div>
        <p className="privacy">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" /></svg>
          所有處理都在你的瀏覽器完成，檔案不會上傳
        </p>
      </header>

      <nav className="tabs" role="tablist" aria-label="工具">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === toolId}
            className={`tab${t.id === toolId ? " tab--active" : ""}`}
            onClick={() => select(t.id)}
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
    </div>
  );
}
