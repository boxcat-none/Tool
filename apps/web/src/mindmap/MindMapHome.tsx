import { IMPORT_EXTENSIONS, MindMap, openAnyMindMapFile } from "@tool/mindmap";
import { useEffect, useRef, useState } from "react";
import { MindMapEditor } from "./MindMapEditor";
import { openMindMapStore, type MindMapMeta, type MindMapStore, type OpenedMindMap } from "./store";
import "./mindmap.css";

/** 心智圖：清單（新增、開啟檔案、刪除）與編輯畫面 */
export default function MindMapHome() {
  const [store, setStore] = useState<MindMapStore | null>(null);
  const [list, setList] = useState<MindMapMeta[]>([]);
  const [opened, setOpened] = useState<(OpenedMindMap & { createdAt: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = async (s = store) => {
    if (s) setList(await s.list());
  };

  useEffect(() => {
    void openMindMapStore().then((s) => {
      setStore(s);
      void refresh(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 離開畫面時關閉（停止寫入 IndexedDB）
  const openedRef = useRef(opened);
  openedRef.current = opened;
  useEffect(() => () => openedRef.current?.close(), []);

  const create = async () => {
    if (!store) return;
    // 一開始是一個圓角方塊，文字「主題」（使用者指定）
    const map = MindMap.create(`心智圖 ${new Date().toLocaleDateString("zh-TW")}`, "主題");
    map.setNodeStyle([map.rootId], { shape: "rounded" });
    const o = await store.add(map);
    setOpened({ ...o, createdAt: Date.now() });
  };

  const open = async (meta: MindMapMeta) => {
    if (!store) return;
    const o = await store.open(meta.id);
    if (!o.map.rootId) {
      o.close();
      setError("這張心智圖的內容讀不到（可能已被瀏覽器清除）");
      return;
    }
    setOpened({ ...o, createdAt: meta.createdAt });
  };

  const openFile = async (file: File) => {
    if (!store) return;
    try {
      // .gugamap 是完整內容；OPML、FreeMind、Markdown、純文字建立一張新的心智圖
      const map = openAnyMindMapFile(file.name, await file.text());
      const existing = list.find((m) => m.id === map.id);
      // 同一張心智圖（例如另一台裝置存的檔案）：合併進現有的
      const o = await store.add(map);
      setOpened({ ...o, createdAt: existing?.createdAt ?? Date.now() });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (meta: MindMapMeta) => {
    if (!store || !confirm(`刪除「${meta.title}」？刪除後無法復原。`)) return;
    await store.remove(meta.id);
    await refresh();
  };

  const back = async () => {
    opened?.close();
    setOpened(null);
    await refresh();
  };

  if (opened && store) {
    return <MindMapEditor key={opened.map.id} map={opened.map} store={store} createdAt={opened.createdAt} onBack={() => void back()} />;
  }

  return (
    <main className="mm-home">
      <div className="mm-home__head">
        <h1>心智圖</h1>
        <p>整理想法、架構與思考脈絡。內容自動儲存在這台裝置。</p>
      </div>
      {store && !store.persistent && <p className="mm-warn">這個瀏覽器不允許儲存資料（例如私密瀏覽），關閉分頁後心智圖會消失，請用「匯出」存成檔案。</p>}
      {error && <p className="mm-warn" role="alert">{error}</p>}
      <div className="mm-home__actions">
        <button type="button" className="btn btn--primary" onClick={() => void create()} disabled={!store}>新增心智圖</button>
        <button type="button" className="btn" onClick={() => fileInput.current?.click()} disabled={!store}>開啟檔案</button>
        <input
          ref={fileInput}
          type="file"
          accept={[...IMPORT_EXTENSIONS, "application/json", "text/x-opml", "text/markdown", "text/plain"].join(",")}
          hidden
          aria-label="選擇心智圖檔"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void openFile(f);
          }}
        />
      </div>
      <p className="mm-formats">可以開啟：心智圖檔（.gugamap）、FreeMind（.mm，XMind、MindNode、Freeplane 都能匯出）、OPML、Markdown、純文字（縮排表示層級）</p>
      {list.length > 0 ? (
        <ul className="mm-list" aria-label="我的心智圖">
          {list.map((m) => (
            <li key={m.id} className="mm-list__item">
              <button type="button" className="mm-list__open" onClick={() => void open(m)}>
                <span className="mm-list__title">{m.title || "未命名"}</span>
                <span className="mm-list__meta">{m.nodeCount} 個元件 · {new Date(m.updatedAt).toLocaleString("zh-TW")}</span>
              </button>
              <button type="button" className="mm-list__delete" onClick={() => void remove(m)} aria-label={`刪除「${m.title}」`}>刪除</button>
            </li>
          ))}
        </ul>
      ) : (
        store && <p className="mm-empty">還沒有心智圖。按「新增心智圖」開始。</p>
      )}
    </main>
  );
}
