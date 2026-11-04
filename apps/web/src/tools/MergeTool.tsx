import { useState } from "react";
import { FileDrop } from "../components/FileDrop";
import { moveItem, SortableFileList } from "../components/SortableFileList";
import { Status, type StatusState } from "../components/Status";
import { ensurePdfName, formatBytes, isPdf } from "../lib/format";
import * as pdf from "../lib/pdf";
import { platform } from "../lib/platform";

interface Item {
  id: number;
  file: File;
  pages?: number;
  error?: string;
}

let nextId = 1;

export function MergeTool() {
  const [items, setItems] = useState<Item[]>([]);
  const [outName, setOutName] = useState("合併.pdf");
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  const addFiles = (files: File[]) => {
    const added: Item[] = files.map((file) =>
      isPdf(file)
        ? { id: nextId++, file }
        : { id: nextId++, file, error: "不是 PDF 檔案" },
    );
    setItems((prev) => [...prev, ...added]);
    setStatus({ kind: "idle" });
    for (const item of added) {
      if (item.error) continue;
      pdf
        .pageCount(item.file)
        .then((pages) => update(item.id, { pages }))
        .catch((e: Error) => update(item.id, { error: e.message }));
    }
  };

  const update = (id: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const remove = (id: number) => setItems((prev) => prev.filter((it) => it.id !== id));

  const sortByName = () =>
    setItems((prev) =>
      [...prev].sort((a, b) =>
        a.file.name.localeCompare(b.file.name, "zh-Hant", { numeric: true }),
      ),
    );

  const hasErrors = items.some((it) => it.error);
  const loading = items.some((it) => !it.error && it.pages === undefined);
  const totalPages = items.reduce((sum, it) => sum + (it.pages ?? 0), 0);
  const busy = status.kind === "busy";
  const canMerge = items.length >= 2 && !hasErrors && !loading && !busy;

  const run = async () => {
    setStatus({ kind: "busy", text: "合併中…" });
    try {
      const data = await pdf.merge(items.map((it) => it.file));
      const name = ensurePdfName(outName, "合併");
      await platform.saveFile({ name, data });
      setStatus({ kind: "done", text: `完成！已下載「${name}」，共 ${totalPages} 頁（${formatBytes(data.byteLength)}）。` });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <section className="tool">
      <FileDrop
        multiple
        compact={items.length > 0}
        onFiles={addFiles}
        title={items.length ? "加入更多 PDF" : "拖放 PDF 到這裡，或點擊選擇檔案"}
        hint={items.length ? undefined : "可一次選擇多個檔案，合併後的順序可以再調整"}
      />

      {items.length > 0 && (
        <>
          <div className="list-head">
            <span>
              {items.length} 個檔案{totalPages > 0 && ` · 共 ${totalPages} 頁`}
            </span>
            <span className="list-head__actions">
              <button type="button" className="link" onClick={sortByName}>依檔名排序</button>
              <button type="button" className="link" onClick={() => { setItems([]); setStatus({ kind: "idle" }); }}>全部清除</button>
            </span>
          </div>

          <SortableFileList
            items={items.map((it) => ({
              id: it.id,
              name: it.file.name,
              error: it.error,
              meta: `${formatBytes(it.file.size)} · ${it.pages === undefined ? "讀取中…" : `${it.pages} 頁`}`,
            }))}
            onMove={(from, to) => setItems((prev) => moveItem(prev, from, to))}
            onRemove={remove}
          />

          <div className="actions">
            <label className="field">
              <span className="field__label">輸出檔名</span>
              <input value={outName} onChange={(e) => setOutName(e.target.value)} />
            </label>
            <button type="button" className="primary" disabled={!canMerge} onClick={run}>
              合併並下載
            </button>
          </div>
          {items.length === 1 && <p className="note">至少需要兩個檔案才能合併。</p>}
          {hasErrors && <p className="note note--error">請先移除標示錯誤的檔案。</p>}
        </>
      )}

      <Status state={status} />
    </section>
  );
}
