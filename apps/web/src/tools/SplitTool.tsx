import {
  describeGroup,
  groupsEachPage,
  groupsEveryN,
  parsePageRanges,
  type PageGroup,
} from "@tool/core/pageRange"; // 只引入頁碼解析，避免把 pdf-lib 打包進主程式
import { useMemo, useState } from "react";
import { FileDrop } from "../components/FileDrop";
import { Status, type StatusState } from "../components/Status";
import { baseName, formatBytes, isPdf } from "../lib/format";
import * as pdf from "../lib/pdf";
import { platform } from "../lib/platform";

type Mode = "ranges" | "each" | "everyN" | "extract";

const MODES: { value: Mode; label: string; desc: string }[] = [
  { value: "ranges", label: "依範圍分割", desc: "每個範圍各自成為一個檔案" },
  { value: "each", label: "每頁一個檔案", desc: "把每一頁都拆成獨立檔案" },
  { value: "everyN", label: "每 N 頁一份", desc: "依固定頁數切分" },
  { value: "extract", label: "擷取頁面", desc: "選出的頁面合成一個檔案" },
];

interface Source {
  file: File;
  pages?: number;
  error?: string;
}

export function SplitTool() {
  const [source, setSource] = useState<Source | null>(null);
  const [mode, setMode] = useState<Mode>("ranges");
  const [rangeText, setRangeText] = useState("");
  const [everyN, setEveryN] = useState(1);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  const pick = ([file]: File[]) => {
    setStatus({ kind: "idle" });
    if (!isPdf(file)) {
      setSource({ file, error: "不是 PDF 檔案" });
      return;
    }
    const next: Source = { file };
    setSource(next);
    pdf
      .pageCount(file)
      .then((pages) => setSource((cur) => (cur?.file === file ? { file, pages } : cur)))
      .catch((e: Error) => setSource((cur) => (cur?.file === file ? { file, error: e.message } : cur)));
  };

  // 依目前設定算出輸出分組；輸入不合法時回傳錯誤訊息
  const plan = useMemo((): { groups: PageGroup[] } | { error: string } | null => {
    const pages = source?.pages;
    if (!pages) return null;
    try {
      switch (mode) {
        case "each":
          return { groups: groupsEachPage(pages) };
        case "everyN":
          return { groups: groupsEveryN(pages, everyN) };
        case "ranges":
          if (!rangeText.trim()) return null;
          return { groups: parsePageRanges(rangeText, pages) };
        case "extract":
          if (!rangeText.trim()) return null;
          return { groups: [parsePageRanges(rangeText, pages).flat()] };
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [source, mode, rangeText, everyN]);

  const groups = plan && "groups" in plan ? plan.groups : null;
  const busy = status.kind === "busy";

  const run = async () => {
    if (!source || !groups) return;
    setStatus({ kind: "busy", text: "分割中…" });
    try {
      const outputs = await pdf.split(source.file, groups);
      const base = baseName(source.file.name);
      const files = outputs.map((data, i) => ({
        name: mode === "extract" ? `${base}_擷取.pdf` : `${base}_p${describeGroup(groups[i]).replace(/,/g, "_")}.pdf`,
        data,
      }));
      await platform.saveFiles(files, `${base}_分割.zip`);
      const total = outputs.reduce((s, o) => s + o.byteLength, 0);
      setStatus({
        kind: "done",
        text:
          files.length === 1
            ? `完成！已下載「${files[0].name}」（${formatBytes(total)}）。`
            : `完成！已將 ${files.length} 個檔案打包成「${base}_分割.zip」下載（${formatBytes(total)}）。`,
      });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  };

  if (!source) {
    return (
      <section className="tool">
        <FileDrop onFiles={pick} title="拖放一個 PDF 到這裡，或點擊選擇檔案" hint="選好檔案後再設定要怎麼分割" />
      </section>
    );
  }

  const needsRange = mode === "ranges" || mode === "extract";

  return (
    <section className="tool">
      <div className={`file file--single${source.error ? " file--error" : ""}`}>
        <span className="file__main">
          <span className="file__name" title={source.file.name}>{source.file.name}</span>
          <span className="file__meta">
            {source.error ?? `${formatBytes(source.file.size)} · ${source.pages === undefined ? "讀取中…" : `${source.pages} 頁`}`}
          </span>
        </span>
        <button type="button" className="link" onClick={() => { setSource(null); setStatus({ kind: "idle" }); }}>
          換一個檔案
        </button>
      </div>

      {source.pages !== undefined && (
        <>
          <fieldset className="modes">
            <legend>分割方式</legend>
            {MODES.map((m) => (
              <label key={m.value} className={`mode${mode === m.value ? " mode--active" : ""}`}>
                <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span className="mode__label">{m.label}</span>
                <span className="mode__desc">{m.desc}</span>
              </label>
            ))}
          </fieldset>

          {needsRange && (
            <label className="field">
              <span className="field__label">頁碼範圍（共 {source.pages} 頁）</span>
              <input
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                placeholder={mode === "ranges" ? "例如：1-3, 4-6, 7-" : "例如：1, 3, 5-8"}
                aria-invalid={plan !== null && "error" in plan}
                autoFocus
              />
              <span className="field__hint">
                用逗號分隔，「8-」代表第 8 頁到最後一頁。
                {mode === "ranges" ? "每個範圍輸出一個檔案。" : "所有選到的頁面依輸入順序合成一個檔案。"}
              </span>
            </label>
          )}

          {mode === "everyN" && (
            <label className="field field--narrow">
              <span className="field__label">每份頁數</span>
              <input
                type="number"
                min={1}
                max={source.pages}
                value={everyN}
                onChange={(e) => setEveryN(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              />
            </label>
          )}

          {plan && "error" in plan && <p className="note note--error">{plan.error}</p>}

          {groups && (
            <div className="preview">
              <div className="preview__title">將產生 {groups.length} 個檔案</div>
              <ul className="preview__list">
                {groups.slice(0, 12).map((g, i) => (
                  <li key={i}>
                    <span className="chip">{i + 1}</span>
                    第 {describeGroup(g)} 頁<span className="muted">（{g.length} 頁）</span>
                  </li>
                ))}
                {groups.length > 12 && <li className="muted">…還有 {groups.length - 12} 個</li>}
              </ul>
            </div>
          )}

          <div className="actions">
            <button type="button" className="primary" disabled={!groups || busy} onClick={run}>
              {groups && groups.length > 1 ? "分割並下載 ZIP" : "分割並下載"}
            </button>
          </div>
        </>
      )}

      <Status state={status} />
    </section>
  );
}
