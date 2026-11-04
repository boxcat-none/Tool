import type { Orientation, PageSizeName } from "@tool/core";
import { useEffect, useRef, useState } from "react";
import { FileDrop } from "../components/FileDrop";
import { Segmented } from "../components/Segmented";
import { moveItem, SortableFileList } from "../components/SortableFileList";
import { Status, type StatusState } from "../components/Status";
import { ensurePdfName, formatBytes } from "../lib/format";
import * as pdf from "../lib/pdf";
import { platform } from "../lib/platform";

interface Img {
  id: number;
  file: File;
  url: string;
  width?: number;
  height?: number;
  error?: string;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
const MARGINS = [
  { value: 0, label: "無" },
  { value: 20, label: "窄" },
  { value: 50, label: "寬" },
];

let nextId = 1;

export function ImagesTool() {
  const [items, setItems] = useState<Img[]>([]);
  const [pageSize, setPageSize] = useState<PageSizeName>("A4");
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [margin, setMargin] = useState(20);
  const [outName, setOutName] = useState("圖片.pdf");
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  // 離開這個工具時釋放所有預覽網址
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => () => latest.current.forEach((it) => URL.revokeObjectURL(it.url)), []);

  const update = (id: number, patch: Partial<Img>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const addFiles = (files: File[]) => {
    setStatus({ kind: "idle" });
    const added = files.map((file): Img => {
      const url = URL.createObjectURL(file);
      const isImage = file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
      return { id: nextId++, file, url, error: isImage ? undefined : "不是圖片檔" };
    });
    setItems((prev) => [...prev, ...added]);
    for (const it of added) {
      if (it.error) continue;
      // 先用瀏覽器試著載入，順便取得尺寸；載入失敗代表瀏覽器不支援（例如 HEIC）
      const img = new Image();
      img.onload = () => update(it.id, { width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => update(it.id, { error: "無法讀取，可能是不支援的格式（例如 HEIC）" });
      img.src = it.url;
    }
  };

  const remove = (id: number) =>
    setItems((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it) URL.revokeObjectURL(it.url);
      return prev.filter((x) => x.id !== id);
    });

  const clear = () => {
    items.forEach((it) => URL.revokeObjectURL(it.url));
    setItems([]);
    setStatus({ kind: "idle" });
  };

  const hasErrors = items.some((it) => it.error);
  const loading = items.some((it) => !it.error && it.width === undefined);
  const busy = status.kind === "busy";
  const canRun = items.length > 0 && !hasErrors && !loading && !busy;

  const run = async () => {
    setStatus({ kind: "busy", text: "轉換中…" });
    try {
      const data = await pdf.imagesToPdf(
        items.map((it) => it.file),
        { pageSize, orientation, margin },
      );
      const name = ensurePdfName(outName, "圖片");
      await platform.saveFile({ name, data });
      setStatus({ kind: "done", text: `完成！已下載「${name}」，共 ${items.length} 頁（${formatBytes(data.byteLength)}）。` });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <section className="tool">
      <FileDrop
        multiple
        accept="image/*,.heic,.heif"
        compact={items.length > 0}
        onFiles={addFiles}
        title={items.length ? "加入更多圖片" : "拖放圖片到這裡，或點擊選擇檔案"}
        hint={items.length ? undefined : "支援 JPG、PNG，以及 WebP、GIF 等格式，每張圖片一頁"}
      />

      {items.length > 0 && (
        <>
          <div className="list-head">
            <span>{items.length} 張圖片</span>
            <span className="list-head__actions">
              <button type="button" className="link" onClick={clear}>全部清除</button>
            </span>
          </div>

          <SortableFileList
            items={items.map((it) => ({
              id: it.id,
              name: it.file.name,
              thumb: it.error ? undefined : it.url,
              error: it.error,
              meta: `${formatBytes(it.file.size)}${it.width ? ` · ${it.width}×${it.height}` : " · 讀取中…"}`,
            }))}
            onMove={(from, to) => setItems((prev) => moveItem(prev, from, to))}
            onRemove={remove}
          />

          <div className="options">
            <Segmented
              label="頁面大小"
              value={pageSize}
              onChange={setPageSize}
              options={[
                { value: "A4", label: "A4" },
                { value: "Letter", label: "Letter" },
                { value: "fit", label: "與圖片相同" },
              ]}
            />
            <Segmented
              label="方向"
              value={orientation}
              onChange={setOrientation}
              disabled={pageSize === "fit"}
              options={[
                { value: "auto", label: "自動" },
                { value: "portrait", label: "直式" },
                { value: "landscape", label: "橫式" },
              ]}
            />
            <Segmented label="邊界" value={margin} onChange={setMargin} options={MARGINS} />
          </div>

          <div className="actions">
            <label className="field">
              <span className="field__label">輸出檔名</span>
              <input value={outName} onChange={(e) => setOutName(e.target.value)} />
            </label>
            <button type="button" className="primary" disabled={!canRun} onClick={run}>
              轉換並下載
            </button>
          </div>
          {hasErrors && <p className="note note--error">請先移除標示錯誤的檔案。</p>}
        </>
      )}

      <Status state={status} />
    </section>
  );
}
