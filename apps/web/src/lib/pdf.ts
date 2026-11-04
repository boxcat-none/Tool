import type { ImagesToPdfOptions, PageSpec } from "@tool/core";
import type { PageGroup } from "@tool/core/pageRange";
import type { WorkerRequest, WorkerResponse } from "./worker";

/**
 * 主執行緒這邊的 PDF API。實際處理在 Web Worker 裡進行，
 * 處理大檔案時介面不會卡住。
 */

let worker: Worker | undefined;
/** 已經傳進 Worker 的原始檔（Worker 重新啟動時清空） */
const sentBlobs = new Set<string>();
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    sentBlobs.clear();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const res = event.data;
      const entry = pending.get(res.id);
      if (!entry) return;
      pending.delete(res.id);
      if (res.ok) entry.resolve(res.result);
      else entry.reject(new Error(res.message));
    };
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error("處理程序意外中止，請重新整理頁面。"));
      pending.clear();
      worker = undefined;
    };
  }
  return worker;
}

function call<T>(req: WorkerRequest, transfer: Transferable[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, ...req }, transfer);
  });
}

export async function pageCount(file: File): Promise<number> {
  const data = await file.arrayBuffer();
  return call<number>({ op: "pageCount", data, name: file.name }, [data]);
}

export async function merge(files: File[]): Promise<Uint8Array> {
  const sources = await Promise.all(
    files.map(async (f) => ({ data: await f.arrayBuffer(), name: f.name })),
  );
  return call<Uint8Array>(
    { op: "merge", sources },
    sources.map((s) => s.data),
  );
}

export async function split(file: File, groups: PageGroup[]): Promise<Uint8Array[]> {
  const data = await file.arrayBuffer();
  return call<Uint8Array[]>({ op: "split", data, name: file.name, groups }, [data]);
}

export async function rearrange(file: File, pages: PageSpec[]): Promise<Uint8Array> {
  const data = await file.arrayBuffer();
  return call<Uint8Array>({ op: "rearrange", data, name: file.name, pages }, [data]);
}

export async function imagesToPdf(files: File[], options: ImagesToPdfOptions): Promise<Uint8Array> {
  const images = await Promise.all(
    files.map(async (f) => ({ data: await f.arrayBuffer(), name: f.name })),
  );
  return call<Uint8Array>(
    { op: "images", images, options },
    images.map((i) => i.data),
  );
}

/**
 * 由筆記本產生 PDF（在 Worker 裡做，介面不會卡住）。
 * - ink: "none"：閱讀器顯示用（筆跡由畫面另外畫）
 * - ink: "flatten" / "annotations"：匯出
 * `update` 是 Y.encodeStateAsUpdate(notebook.doc)；呼叫端計算，主程式不必載入 Yjs。
 */
export async function notebookPdf(
  update: Uint8Array,
  files: { ids: string[]; get(id: string): Promise<Uint8Array | undefined> },
  ink: "none" | "flatten" | "annotations",
): Promise<Uint8Array> {
  for (const id of files.ids) {
    if (sentBlobs.has(id)) continue;
    const bytes = await files.get(id);
    if (!bytes) continue; // Worker 會回報「找不到原始檔案」
    const data = bytes.slice().buffer as ArrayBuffer;
    await call<null>({ op: "putBlob", blobId: id, data }, [data]);
    sentBlobs.add(id);
  }
  const copy = update.slice();
  return call<Uint8Array>({ op: "notebookPdf", update: copy, ink }, [copy.buffer as ArrayBuffer]);
}
