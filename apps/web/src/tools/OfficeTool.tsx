import { useEffect, useState } from "react";
import { FileDrop } from "../components/FileDrop";
import { Segmented } from "../components/Segmented";
import { Status, type StatusState } from "../components/Status";
import * as desktop from "../lib/desktop";

type ItemState = "pending" | "converting" | "done" | "error";

interface Item {
  id: number;
  name: string;
  /** 要轉換的檔案路徑（拖放進來的是暫存路徑） */
  path: string;
  /** 拖放進來的檔案拿不到原始位置，只能存到指定資料夾 */
  temp: boolean;
  state: ItemState;
  output?: string;
  error?: string;
}

type OutMode = "same" | "folder";

const DOWNLOAD_URL = "https://www.libreoffice.org/download/download-libreoffice/";
let nextId = 1;

export function OfficeTool() {
  const [office, setOffice] = useState<desktop.OfficeStatus | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [outMode, setOutMode] = useState<OutMode>("same");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  const detect = () => {
    setOffice(null);
    desktop.officeStatus().then(setOffice, () => setOffice({ soffice: null, extensions: [] }));
  };
  useEffect(detect, []);

  const extensions = office?.extensions ?? [];
  const supported = (name: string) => extensions.includes(name.split(".").pop()?.toLowerCase() ?? "");
  const hasTemp = items.some((it) => it.temp && it.state !== "done");
  const mode: OutMode = hasTemp ? "folder" : outMode;

  const add = (entries: { name: string; path: string; temp: boolean }[]) => {
    setStatus({ kind: "idle" });
    setItems((prev) => [
      ...prev,
      ...entries.map((e): Item => ({
        id: nextId++,
        ...e,
        state: supported(e.name) ? "pending" : "error",
        error: supported(e.name) ? undefined : "不支援這種檔案格式",
      })),
    ]);
  };

  const pick = async () => {
    const paths = await desktop.pickFiles("選擇要轉成 PDF 的檔案", "Office 文件", extensions);
    add(paths.map((path) => ({ name: desktop.fileName(path), path, temp: false })));
  };

  const drop = async (files: File[]) => {
    const entries = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        // 不支援的格式不用寫暫存檔
        path: supported(f.name) ? await desktop.writeTemp(f) : "",
        temp: true,
      })),
    );
    add(entries);
  };

  const chooseFolder = async () => {
    const dir = await desktop.pickFolder("選擇 PDF 要存放的資料夾");
    if (dir) setOutDir(dir);
    return dir;
  };

  const update = (id: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const todo = items.filter((it) => it.state === "pending" || (it.state === "error" && it.path && supported(it.name)));
  const busy = status.kind === "busy";

  const run = async () => {
    let dir = mode === "folder" ? outDir : null;
    if (mode === "folder" && !dir) {
      dir = await chooseFolder();
      if (!dir) return;
    }
    let ok = 0;
    let failed = 0;
    for (const [i, it] of todo.entries()) {
      setStatus({ kind: "busy", text: `轉換中… ${i + 1} / ${todo.length}${i === 0 ? "（第一個檔案需要多等幾秒啟動 LibreOffice）" : ""}` });
      update(it.id, { state: "converting", error: undefined });
      try {
        const output = await desktop.convertOffice(it.path, dir);
        update(it.id, { state: "done", output });
        ok++;
      } catch (e) {
        update(it.id, { state: "error", error: String(e) });
        failed++;
      }
    }
    setStatus(
      failed === 0
        ? { kind: "done", text: `完成！${ok} 個檔案已轉成 PDF。` }
        : { kind: "error", text: `${ok} 個成功，${failed} 個失敗，失敗原因請看清單。` },
    );
  };

  if (!office) {
    return (
      <section className="tool">
        <Status state={{ kind: "busy", text: "正在尋找 LibreOffice…" }} />
      </section>
    );
  }

  if (!office.soffice) {
    return (
      <section className="tool">
        <div className="notice">
          <div className="notice__title">需要先安裝 LibreOffice</div>
          <p>
            Word、Excel、PowerPoint 轉 PDF 是交給 LibreOffice 處理的。LibreOffice 是免費、開放原始碼的辦公軟體，
            安裝完成後回到這裡按「重新偵測」即可使用。
          </p>
          <div className="notice__actions">
            <button type="button" className="primary" onClick={() => void desktop.openUrl(DOWNLOAD_URL)}>
              前往下載 LibreOffice
            </button>
            <button type="button" className="btn" onClick={detect}>重新偵測</button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="tool">
      <FileDrop
        multiple
        accept={extensions.map((e) => `.${e}`).join(",")}
        compact={items.length > 0}
        onPick={() => void pick()}
        onFiles={(files) => void drop(files)}
        title={items.length ? "加入更多檔案" : "拖放檔案到這裡，或點擊選擇檔案"}
        hint={items.length ? undefined : "支援 Word（doc、docx）、Excel（xls、xlsx）、PowerPoint（ppt、pptx）及 OpenDocument 格式"}
      />

      {items.length > 0 && (
        <>
          <div className="list-head">
            <span>{items.length} 個檔案</span>
            <span className="list-head__actions">
              {items.some((it) => it.state === "done") && !busy && (
                <button type="button" className="link" onClick={() => setItems((prev) => prev.filter((it) => it.state !== "done"))}>
                  清除已完成
                </button>
              )}
              {!busy && (
                <button type="button" className="link" onClick={() => { setItems([]); setStatus({ kind: "idle" }); }}>全部清除</button>
              )}
            </span>
          </div>

          <ol className="files">
            {items.map((it) => (
              <li key={it.id} className={`file${it.state === "error" ? " file--error" : ""}${it.state === "done" ? " file--done" : ""}`}>
                <span className={`file__badge file__badge--${badgeKind(it.name)}`}>{badgeLabel(it.name)}</span>
                <span className="file__main">
                  <span className="file__name" title={it.temp ? it.name : it.path}>{it.name}</span>
                  <span className="file__meta">
                    {it.state === "pending" && (it.temp ? "等待轉換 · 拖放的檔案" : `等待轉換 · ${desktop.dirName(it.path)}`)}
                    {it.state === "converting" && "轉換中…"}
                    {it.state === "done" && `已轉換 → ${it.output && desktop.fileName(it.output)}`}
                    {it.state === "error" && it.error}
                  </span>
                </span>
                <span className="file__actions">
                  {it.state === "converting" && <span className="spinner" aria-hidden="true" />}
                  {it.state === "done" && it.output && (
                    <button type="button" className="link" onClick={() => void desktop.revealInFolder(it.output!)}>
                      在資料夾中顯示
                    </button>
                  )}
                  {it.state !== "converting" && !busy && (
                    <button type="button" className="icon icon--danger" aria-label={`移除 ${it.name}`} onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}>✕</button>
                  )}
                </span>
              </li>
            ))}
          </ol>

          <div className="options">
            <Segmented
              label="PDF 存放位置"
              value={mode}
              onChange={(m) => {
                setOutMode(m);
                if (m === "folder" && !outDir) void chooseFolder();
              }}
              options={[
                { value: "same", label: "與原檔相同資料夾" },
                { value: "folder", label: "指定資料夾" },
              ]}
            />
          </div>
          {mode === "folder" && (
            <p className="note">
              {outDir ? <>存放到「{outDir}」 · </> : "還沒有選擇資料夾 · "}
              <button type="button" className="link" onClick={() => void chooseFolder()}>{outDir ? "更換" : "選擇資料夾"}</button>
            </p>
          )}
          {hasTemp && <p className="note">拖放進來的檔案無法得知原本的位置，所以需要指定存放的資料夾。若要存在原檔旁邊，請改用點擊選擇檔案。</p>}

          <div className="actions">
            <button type="button" className="primary" disabled={todo.length === 0 || busy} onClick={() => void run()}>
              {todo.length > 0 ? `開始轉換（${todo.length} 個）` : "開始轉換"}
            </button>
          </div>
        </>
      )}

      <Status state={status} />
    </section>
  );
}

function badgeKind(name: string): "word" | "excel" | "ppt" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "word";
  if (["xls", "xlsx", "ods", "csv"].includes(ext)) return "excel";
  if (["ppt", "pptx", "odp"].includes(ext)) return "ppt";
  return "other";
}

function badgeLabel(name: string): string {
  return { word: "W", excel: "X", ppt: "P", other: "?" }[badgeKind(name)];
}
