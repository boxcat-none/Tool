import { normalizeRotation, type Rotation } from "@tool/core/rotation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { PageThumb } from "../components/PageThumb";
import { FileDrop } from "../components/FileDrop";
import { moveItem } from "../components/SortableFileList";
import { Status, type StatusState } from "../components/Status";
import { baseName, formatBytes, isPdf } from "../lib/format";
import * as pdf from "../lib/pdf";
import { platform } from "../lib/platform";
import { openThumbnails, type ThumbnailDoc } from "../lib/thumbnails";

interface PageItem {
  /** 穩定的 key（= 原始頁面索引） */
  key: number;
  /** 原始頁面索引（0 起算） */
  index: number;
  /** 要額外旋轉的角度（輸出用） */
  rotate: Rotation;
  /** 累計旋轉角度（動畫用，避免 270→0 時倒轉一大圈） */
  spin: number;
  deleted: boolean;
}

interface Source {
  file: File;
  error?: string;
}

export function OrganizeTool() {
  const [source, setSource] = useState<Source | null>(null);
  const [thumbs, setThumbs] = useState<ThumbnailDoc | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [dragKey, setDragKey] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const current = useRef<File | null>(null);

  useEffect(() => () => thumbs?.destroy(), [thumbs]);

  const reset = () => {
    current.current = null;
    setSource(null);
    setThumbs(null);
    setPages([]);
    setSelected(new Set());
    setAnchor(null);
    setStatus({ kind: "idle" });
  };

  const pick = async ([file]: File[]) => {
    reset();
    current.current = file;
    if (!isPdf(file)) {
      setSource({ file, error: "不是 PDF 檔案" });
      return;
    }
    setSource({ file });
    try {
      // 先用 pdf-lib 檢查（加密、損毀會在這裡回報清楚的錯誤），再用 pdf.js 畫縮圖
      const count = await pdf.pageCount(file);
      const doc = await openThumbnails(file);
      if (current.current !== file) return doc.destroy();
      setThumbs(doc);
      setPages(
        Array.from({ length: count }, (_, i) => ({ key: i, index: i, rotate: 0, spin: 0, deleted: false })),
      );
    } catch (e) {
      if (current.current === file) setSource({ file, error: (e as Error).message });
    }
  };

  const rotate = (keys: Set<number>, delta: 90 | -90) =>
    setPages((prev) =>
      prev.map((p) =>
        keys.has(p.key) ? { ...p, rotate: normalizeRotation(p.rotate + delta), spin: p.spin + delta } : p,
      ),
    );

  const setDeleted = (keys: Set<number>, deleted: boolean) =>
    setPages((prev) => prev.map((p) => (keys.has(p.key) ? { ...p, deleted } : p)));

  const toggleSelect = (key: number, e: MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && anchor !== null) {
        // Shift + 點擊：選取上一次點擊到這一頁之間的所有頁面
        const a = pages.findIndex((p) => p.key === anchor);
        const b = pages.findIndex((p) => p.key === key);
        for (const p of pages.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(p.key);
      } else if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    setAnchor(key);
  };

  const allKeys = new Set(pages.map((p) => p.key));
  const kept = pages.filter((p) => !p.deleted);
  const deletedCount = pages.length - kept.length;
  const rotatedCount = kept.filter((p) => p.rotate !== 0).length;
  const reordered = pages.some((p, i) => p.index !== i);
  const selectedPages = pages.filter((p) => selected.has(p.key));
  const allSelectedDeleted = selectedPages.length > 0 && selectedPages.every((p) => p.deleted);
  const changed = deletedCount > 0 || rotatedCount > 0 || reordered;
  const busy = status.kind === "busy";

  const run = async () => {
    if (!source) return;
    setStatus({ kind: "busy", text: "處理中…" });
    try {
      const data = await pdf.rearrange(
        source.file,
        kept.map((p) => ({ index: p.index, rotate: p.rotate })),
      );
      const name = `${baseName(source.file.name)}_已整理.pdf`;
      const saved = await platform.saveFile({ name, data });
      if (!saved) return setStatus({ kind: "idle" });
      setStatus({ kind: "done", text: `完成！${saved}，共 ${kept.length} 頁（${formatBytes(data.byteLength)}）。` });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  if (!source) {
    return (
      <section className="tool">
        <FileDrop onFiles={pick} title="拖放一個 PDF 到這裡，或點擊選擇檔案" hint="可以旋轉、刪除頁面，或拖拉調整頁面順序" />
      </section>
    );
  }

  const summary = [
    `輸出 ${kept.length} 頁`,
    deletedCount > 0 && `刪除 ${deletedCount} 頁`,
    rotatedCount > 0 && `旋轉 ${rotatedCount} 頁`,
    reordered && "已調整順序",
  ].filter(Boolean).join("，");

  return (
    <section className="tool">
      <div className={`file file--single${source.error ? " file--error" : ""}`}>
        <span className="file__main">
          <span className="file__name" title={source.file.name}>{source.file.name}</span>
          <span className="file__meta">
            {source.error ?? `${formatBytes(source.file.size)} · ${thumbs ? `${pages.length} 頁` : "讀取中…"}`}
          </span>
        </span>
        <button type="button" className="link" onClick={reset}>換一個檔案</button>
      </div>

      {thumbs && (
        <>
          <div className="toolbar">
            {selected.size === 0 ? (
              <>
                <span className="toolbar__label">全部頁面</span>
                <button type="button" className="btn" onClick={() => rotate(allKeys, -90)}>↺ 向左轉</button>
                <button type="button" className="btn" onClick={() => rotate(allKeys, 90)}>↻ 向右轉</button>
                <span className="toolbar__spacer" />
                <button type="button" className="link" onClick={() => setSelected(new Set(allKeys))}>全選</button>
              </>
            ) : (
              <>
                <span className="toolbar__label">已選取 {selected.size} 頁</span>
                <button type="button" className="btn" onClick={() => rotate(selected, -90)}>↺ 向左轉</button>
                <button type="button" className="btn" onClick={() => rotate(selected, 90)}>↻ 向右轉</button>
                {allSelectedDeleted ? (
                  <button type="button" className="btn" onClick={() => setDeleted(selected, false)}>復原</button>
                ) : (
                  <button type="button" className="btn btn--danger" onClick={() => setDeleted(selected, true)}>刪除</button>
                )}
                <span className="toolbar__spacer" />
                <button type="button" className="link" onClick={() => setSelected(new Set())}>取消選取</button>
              </>
            )}
          </div>
          <p className="note">點頁面可以選取（按住 Shift 可選取一段範圍），拖拉可以調整順序。</p>

          <ol className="pages">
            {pages.map((p, i) => (
              <li
                key={p.key}
                className={`page${p.deleted ? " page--deleted" : ""}${selected.has(p.key) ? " page--selected" : ""}${dragKey === p.key ? " page--dragging" : ""}`}
                draggable
                onDragStart={(e) => {
                  setDragKey(p.key);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragKey(null)}
                onDragOver={(e) => {
                  if (dragKey === null) return;
                  e.preventDefault();
                  const from = pages.findIndex((x) => x.key === dragKey);
                  if (from !== i) setPages((prev) => moveItem(prev, from, i));
                }}
              >
                <button
                  type="button"
                  className="page__select"
                  aria-pressed={selected.has(p.key)}
                  aria-label={`第 ${p.index + 1} 頁${p.deleted ? "（已刪除）" : ""}`}
                  onClick={(e) => toggleSelect(p.key, e)}
                >
                  <PageThumb doc={thumbs} index={p.index} spin={p.spin} className="page__frame" />
                  {p.deleted && <span className="page__badge">已刪除</span>}
                  <span className="page__check" aria-hidden="true">✓</span>
                </button>
                <div className="page__bar">
                  <span className="page__num">{p.index + 1}</span>
                  <button type="button" className="icon icon--sm" aria-label={`第 ${p.index + 1} 頁向左轉`} onClick={() => rotate(new Set([p.key]), -90)}>↺</button>
                  <button type="button" className="icon icon--sm" aria-label={`第 ${p.index + 1} 頁向右轉`} onClick={() => rotate(new Set([p.key]), 90)}>↻</button>
                  {p.deleted ? (
                    <button type="button" className="icon icon--sm" aria-label={`復原第 ${p.index + 1} 頁`} onClick={() => setDeleted(new Set([p.key]), false)}>↩</button>
                  ) : (
                    <button type="button" className="icon icon--sm icon--danger" aria-label={`刪除第 ${p.index + 1} 頁`} onClick={() => setDeleted(new Set([p.key]), true)}>✕</button>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <div className="actions actions--between">
            <span className="note">
              {summary}
              {changed && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setPages((prev) =>
                        [...prev].sort((a, b) => a.index - b.index).map((p) => ({ ...p, rotate: 0, spin: 0, deleted: false })),
                      );
                      setSelected(new Set());
                    }}
                  >
                    全部還原
                  </button>
                </>
              )}
            </span>
            <button type="button" className="primary" disabled={kept.length === 0 || !changed || busy} onClick={run}>
              套用並下載
            </button>
          </div>
          {kept.length === 0 && <p className="note note--error">至少要保留一頁。</p>}
        </>
      )}

      <Status state={status} />
    </section>
  );
}
