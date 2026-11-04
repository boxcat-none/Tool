import type { PaperTemplate } from "@tool/notes/notebook";
import { useEffect, useState } from "react";
import * as Y from "yjs";
import { openLibrary, type Library as LibraryStore } from "../lib/library";
import { openPdf } from "../lib/pdfjs";
import { Library } from "./Library";
import { NotebookView } from "./NotebookView";
import { PasswordForm } from "./PasswordForm";
import "./reader.css";

const A4 = { width: 595.28, height: 841.89 };

type View = { kind: "library" } | { kind: "notebook"; id: string; password?: string };

interface PendingPdf {
  bytes: Uint8Array;
  name: string;
  hash: string;
}

/**
 * 閱讀與筆記：書櫃（所有筆記本）與筆記本檢視。
 * 整個模組延遲載入，只用 PDF 工具時不需要下載。
 */
export default function Reader() {
  const [library, setLibrary] = useState<LibraryStore | null>(null);
  const [view, setView] = useState<View>({ kind: "library" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 同一份 PDF 已經有筆記本：問要接續還是建立新的 */
  const [choice, setChoice] = useState<(PendingPdf & { existing: { id: string; title: string; pageCount: number } }) | null>(null);
  /** 建立筆記本前，有密碼的 PDF 需要先輸入密碼（才能讀出每頁大小） */
  const [askPassword, setAskPassword] = useState<(PendingPdf & { wrong: boolean }) | null>(null);

  useEffect(() => {
    void openLibrary().then(setLibrary);
  }, []);

  if (!library) {
    return <div className="reader__overlay"><span className="spinner" aria-hidden="true" /></div>;
  }

  /** 書櫃裡已有同名筆記本時加上編號：目錄 → 目錄 (2) */
  const uniqueTitle = async (base: string) => {
    const taken = new Set((await library.list()).map((m) => m.title));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
  };

  const fail = (message: string) => {
    setBusy(null);
    setError(message);
  };

  const openFiles = async ([file]: File[]) => {
    if (!file) return;
    setError(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".guganote")) return openNotebookFile(file);
    if (!(file.type === "application/pdf" || lower.endsWith(".pdf"))) return fail("只能開啟 PDF 或 .guganote 檔案。");
    setBusy("讀取 PDF…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { sha256Hex } = await import("@tool/notes/blobs");
      const hash = await sha256Hex(bytes);
      const existing = await library.findBySource(hash);
      setBusy(null);
      if (existing) setChoice({ bytes, name: file.name, hash, existing });
      else await createFromPdf({ bytes, name: file.name, hash });
    } catch {
      fail("無法讀取這個檔案。");
    }
  };

  /** 由 PDF 建立筆記本（每頁 PDF 對應一個筆記頁） */
  const createFromPdf = async (pdf: PendingPdf, password?: string) => {
    setBusy("建立筆記本…");
    let opened;
    try {
      opened = await openPdf(pdf.bytes.slice(), password);
    } catch (e) {
      const err = e as { name?: string; code?: number };
      setBusy(null);
      if (err?.name === "PasswordException") return setAskPassword({ ...pdf, wrong: err.code === 2 });
      return fail(`「${pdf.name}」不是有效的 PDF，或檔案已損毀。`);
    }
    try {
      const { Notebook } = await import("@tool/notes/notebook");
      const pages = await Promise.all(Array.from({ length: opened.doc.numPages }, (_, i) => opened.doc.getPage(i + 1)));
      const title = await uniqueTitle(pdf.name.replace(/\.pdf$/i, ""));
      const nb = Notebook.create(title);
      const fileId = await library.blobs.put(pdf.bytes);
      nb.addFile({
        id: fileId,
        name: pdf.name,
        mime: "application/pdf",
        size: pdf.bytes.length,
        pageCount: pages.length,
        encrypted: password !== undefined,
      });
      nb.insertPages(
        0,
        pages.map((p, index) => ({
          source: { kind: "pdf" as const, fileId, index },
          width: p.view[2] - p.view[0],
          height: p.view[3] - p.view[1],
          rotation: (((p.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270,
        })),
      );
      const added = await library.add(nb, { title, pageCount: pages.length, sourceHash: pdf.hash, fileIds: [fileId] });
      added.close();
      setBusy(null);
      setAskPassword(null);
      setView({ kind: "notebook", id: nb.id, password });
    } catch {
      fail("建立筆記本時發生錯誤。");
    } finally {
      void opened.task.destroy();
    }
  };

  /** 開啟 .guganote：書櫃裡已經有同一本（代號相同）就合併內容，否則加入書櫃 */
  const openNotebookFile = async (file: File) => {
    setBusy("開啟筆記本…");
    try {
      const { openNotebookFile: read } = await import("@tool/notes/file");
      const { notebook } = await read(new Uint8Array(await file.arrayBuffer()), library.blobs);
      const existing = await library.get(notebook.id);
      if (existing) {
        const opened = await library.open(notebook.id);
        Y.applyUpdate(opened.notebook.doc, Y.encodeStateAsUpdate(notebook.doc));
        opened.close();
      } else {
        const added = await library.add(notebook, {
          title: notebook.title,
          pageCount: notebook.pageIds.length,
          fileIds: notebook.usedFileIds,
        });
        added.close();
      }
      setBusy(null);
      setView({ kind: "notebook", id: notebook.id });
    } catch (e) {
      fail((e as Error).message || "無法開啟這個筆記本檔案。");
    }
  };

  const createBlank = async (template: PaperTemplate) => {
    setError(null);
    setBusy("建立筆記本…");
    try {
      const { Notebook } = await import("@tool/notes/notebook");
      const nb = Notebook.create(await uniqueTitle("未命名筆記本"));
      nb.insertPages(0, [{ source: { kind: "template", template }, ...A4 }]);
      const added = await library.add(nb, { title: nb.title, pageCount: 1, fileIds: [] });
      added.close();
      setBusy(null);
      setView({ kind: "notebook", id: nb.id });
    } catch {
      fail("建立筆記本時發生錯誤。");
    }
  };

  if (view.kind === "notebook") {
    return (
      <NotebookView
        key={view.id}
        library={library}
        notebookId={view.id}
        initialPassword={view.password}
        onClose={() => setView({ kind: "library" })}
      />
    );
  }

  return (
    <>
      <Library
        library={library}
        busy={busy}
        error={error}
        onFiles={(files) => void openFiles(files)}
        onNew={(t) => void createBlank(t)}
        onOpen={(id) => setView({ kind: "notebook", id })}
      />
      {choice && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="choice-title">
          <div className="notice modal__box">
            <div className="notice__title" id="choice-title">這份 PDF 已經有筆記本</div>
            <p>「{choice.existing.title}」（{choice.existing.pageCount} 頁）就是用這份 PDF 建立的。要接續之前的筆記，還是建立一本新的？</p>
            <div className="notice__actions">
              <button type="button" className="primary" autoFocus onClick={() => (setChoice(null), setView({ kind: "notebook", id: choice.existing.id }))}>
                接續之前的筆記
              </button>
              <button type="button" className="btn" onClick={() => { const c = choice; setChoice(null); void createFromPdf(c); }}>
                建立新的筆記本
              </button>
              <button type="button" className="btn" onClick={() => setChoice(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {askPassword && (
        <div className="modal" role="dialog" aria-modal="true">
          <PasswordForm
            wrong={askPassword.wrong}
            onSubmit={(pw) => { const p = askPassword; setAskPassword(null); void createFromPdf(p, pw); }}
            onCancel={() => setAskPassword(null)}
          />
        </div>
      )}
    </>
  );
}
