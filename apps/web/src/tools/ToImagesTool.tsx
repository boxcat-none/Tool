import { parsePageRanges } from "@tool/core/pageRange";
import { rasterSize } from "@tool/core/raster";
import { useMemo, useRef, useState } from "react";
import { FileDrop } from "../components/FileDrop";
import { Segmented } from "../components/Segmented";
import { Status, type StatusState } from "../components/Status";
import { baseName, formatBytes, isPdf } from "../lib/format";
import * as pdf from "../lib/pdf";
import { platform } from "../lib/platform";
import { firstPageSize, rasterizePdf, type ImageType } from "../lib/rasterize";

interface Source {
  file: File;
  pages?: number;
  size?: { width: number; height: number };
  error?: string;
}

type Scope = "all" | "custom";

export function ToImagesTool() {
  const [source, setSource] = useState<Source | null>(null);
  const [format, setFormat] = useState<ImageType>("png");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.92);
  const [scope, setScope] = useState<Scope>("all");
  const [rangeText, setRangeText] = useState("");
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const current = useRef<File | null>(null);

  const pick = async ([file]: File[]) => {
    setStatus({ kind: "idle" });
    current.current = file;
    if (!isPdf(file)) {
      setSource({ file, error: "不是 PDF 檔案" });
      return;
    }
    setSource({ file });
    try {
      const pages = await pdf.pageCount(file);
      const size = await firstPageSize(file);
      if (current.current === file) setSource({ file, pages, size });
    } catch (e) {
      if (current.current === file) setSource({ file, error: (e as Error).message });
    }
  };

  const selection = useMemo((): { pages: number[] } | { error: string } | null => {
    const total = source?.pages;
    if (!total) return null;
    if (scope === "all") return { pages: Array.from({ length: total }, (_, i) => i) };
    if (!rangeText.trim()) return null;
    try {
      // 去除重複頁面，保留第一次出現的順序
      return { pages: [...new Set(parsePageRanges(rangeText, total).flat())] };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [source, scope, rangeText]);

  const pages = selection && "pages" in selection ? selection.pages : null;
  const busy = status.kind === "busy";
  const estimate = source?.size ? rasterSize(source.size.width, source.size.height, dpi) : null;

  const run = async () => {
    if (!source || !pages) return;
    setStatus({ kind: "busy", text: "準備中…" });
    try {
      const { files, clampedCount } = await rasterizePdf(source.file, {
        format,
        dpi,
        quality,
        pages,
        onProgress: (done, total) => setStatus({ kind: "busy", text: `轉換中… ${done} / ${total} 頁` }),
      });
      const zipName = `${baseName(source.file.name)}_${format.toUpperCase()}.zip`;
      setStatus({ kind: "busy", text: "打包中…" });
      await platform.saveFiles(files, zipName);
      const total = files.reduce((s, f) => s + f.data.byteLength, 0);
      const note = clampedCount > 0 ? `其中 ${clampedCount} 頁太大，已自動降低解析度。` : "";
      setStatus({
        kind: "done",
        text:
          (files.length === 1
            ? `完成！已下載「${files[0].name}」（${formatBytes(total)}）。`
            : `完成！已將 ${files.length} 張圖片打包成「${zipName}」下載（${formatBytes(total)}）。`) + note,
      });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  if (!source) {
    return (
      <section className="tool">
        <FileDrop onFiles={pick} title="拖放一個 PDF 到這裡，或點擊選擇檔案" hint="每一頁轉成一張 PNG 或 JPG 圖片" />
      </section>
    );
  }

  return (
    <section className="tool">
      <div className={`file file--single${source.error ? " file--error" : ""}`}>
        <span className="file__main">
          <span className="file__name" title={source.file.name}>{source.file.name}</span>
          <span className="file__meta">
            {source.error ?? `${formatBytes(source.file.size)} · ${source.pages === undefined || !source.size ? "讀取中…" : `${source.pages} 頁`}`}
          </span>
        </span>
        <button type="button" className="link" onClick={() => { current.current = null; setSource(null); setStatus({ kind: "idle" }); }}>
          換一個檔案
        </button>
      </div>

      {source.pages !== undefined && source.size && (
        <>
          <div className="options">
            <Segmented
              label="圖片格式"
              value={format}
              onChange={setFormat}
              options={[
                { value: "png", label: "PNG" },
                { value: "jpg", label: "JPG" },
              ]}
            />
            <Segmented
              label="解析度"
              value={dpi}
              onChange={setDpi}
              options={[
                { value: 72, label: "72 DPI" },
                { value: 150, label: "150 DPI" },
                { value: 300, label: "300 DPI" },
              ]}
            />
            {format === "jpg" && (
              <Segmented
                label="JPG 品質"
                value={quality}
                onChange={setQuality}
                options={[
                  { value: 0.92, label: "高" },
                  { value: 0.8, label: "中" },
                  { value: 0.6, label: "低" },
                ]}
              />
            )}
          </div>
          <p className="note">
            PNG 畫質無損、適合文字和圖表；JPG 檔案較小、適合照片。
            72 DPI 適合螢幕瀏覽，300 DPI 適合列印。
            {estimate && <> 第 1 頁約 {estimate.width}×{estimate.height} 像素{estimate.clamped && "（已達上限）"}。</>}
          </p>

          <Segmented
            label="頁面"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: `全部 ${source.pages} 頁` },
              { value: "custom", label: "指定頁面" },
            ]}
          />
          {scope === "custom" && (
            <label className="field">
              <span className="field__label">頁碼範圍（共 {source.pages} 頁）</span>
              <input
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                placeholder="例如：1, 3, 5-8"
                aria-invalid={selection !== null && "error" in selection}
                autoFocus
              />
              <span className="field__hint">用逗號分隔，「8-」代表第 8 頁到最後一頁。</span>
            </label>
          )}
          {selection && "error" in selection && <p className="note note--error">{selection.error}</p>}

          <div className="actions actions--between">
            <span className="note">{pages ? `將產生 ${pages.length} 張 ${format.toUpperCase()} 圖片` : ""}</span>
            <button type="button" className="primary" disabled={!pages || busy} onClick={run}>
              {pages && pages.length > 1 ? "轉換並下載 ZIP" : "轉換並下載"}
            </button>
          </div>
          {pages && pages.length > 50 && dpi === 300 && (
            <p className="note">頁數多又是 300 DPI，轉換可能需要一點時間。</p>
          )}
        </>
      )}

      <Status state={status} />
    </section>
  );
}
