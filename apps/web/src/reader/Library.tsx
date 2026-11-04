import type { PaperTemplate } from "@tool/notes/notebook";
import { useEffect, useState } from "react";
import { FileDrop } from "../components/FileDrop";
import type { Library as LibraryStore, NotebookMeta } from "../lib/library";

const TEMPLATES: { value: PaperTemplate; label: string }[] = [
  { value: "lined", label: "橫線" },
  { value: "grid", label: "方格" },
  { value: "dot", label: "點陣" },
  { value: "blank", label: "空白" },
];

const dateFormat = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" });

interface Props {
  library: LibraryStore;
  busy: string | null;
  error: string | null;
  onFiles: (files: File[]) => void;
  onNew: (template: PaperTemplate) => void;
  onOpen: (id: string) => void;
}

/** 書櫃：所有筆記本（自動儲存在這台裝置） */
export function Library({ library, busy, error, onFiles, onNew, onOpen }: Props) {
  const [items, setItems] = useState<NotebookMeta[] | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    library.list().then((list) => !cancelled && setItems(list));
    return () => {
      cancelled = true;
    };
  }, [library, refresh]);

  const remove = async (m: NotebookMeta) => {
    if (!window.confirm(`確定要刪除「${m.title}」嗎？筆記本和裡面的筆記會一起刪除，無法復原。`)) return;
    await library.remove(m.id);
    setRefresh((n) => n + 1);
  };

  return (
    <div className="reader-empty">
      <div className="library">
        <div className="library__head">
          <div>
            <h1 className="panel__title">閱讀與筆記</h1>
            <p className="panel__desc">
              開啟 PDF 閱讀、手寫筆記，或建立空白筆記本。
              {library.persistent ? "筆記會自動儲存在這台裝置上。" : ""}
            </p>
          </div>
        </div>

        {!library.persistent && (
          <p className="note note--error">這個瀏覽器（可能是私密瀏覽模式）無法自動儲存，關閉分頁後筆記會消失，請記得存成 .guganote 或匯出 PDF。</p>
        )}

        <FileDrop
          multiple={false}
          accept="application/pdf,.pdf,.guganote"
          onFiles={onFiles}
          title="拖放 PDF 或 .guganote 到這裡，或點擊選擇檔案"
          hint="PDF 會建立一本筆記本；同一份 PDF 再開啟時可以接續之前的筆記"
          compact={!!items?.length}
        />

        <div className="library__new">
          <span className="field__label">新增空白筆記本</span>
          <span className="library__templates">
            {TEMPLATES.map((t) => (
              <button key={t.value} type="button" className="btn" disabled={!!busy} onClick={() => onNew(t.value)}>
                <span className={`paper-icon paper-icon--${t.value}`} aria-hidden="true" />
                {t.label}
              </button>
            ))}
          </span>
        </div>

        {busy && <div className="status status--busy"><span className="spinner" aria-hidden="true" />{busy}</div>}
        {error && <div className="status status--error" role="alert">{error}</div>}

        {items && items.length > 0 && (
          <>
            <div className="list-head"><span>我的筆記本（{items.length}）</span></div>
            <ul className="library__list">
              {items.map((m) => (
                <li key={m.id} className="library__item">
                  <button type="button" className="library__open" onClick={() => onOpen(m.id)}>
                    <span className="library__title">{m.title || "未命名筆記本"}</span>
                    <span className="library__meta">{m.pageCount} 頁 · 更新於 {dateFormat.format(m.updatedAt)}</span>
                  </button>
                  <button type="button" className="icon icon--danger" aria-label={`刪除 ${m.title}`} onClick={() => void remove(m)}>✕</button>
                </li>
              ))}
            </ul>
          </>
        )}
        {items && items.length === 0 && <p className="note">還沒有筆記本。開啟一份 PDF，或新增一本空白筆記本開始吧。</p>}
      </div>
    </div>
  );
}
