import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import * as Y from "yjs";
import { MemoryBlobStore, sha256Hex, type BlobStore } from "./blobs";
import { Notebook } from "./notebook";

/**
 * 筆記本檔案（.toolnote）：一個 ZIP 檔，內容：
 *
 *   manifest.json      格式名稱、版本、標題、儲存時間
 *   notebook.yjs       Yjs 文件（頁面、筆跡；保留合併所需的資訊，之後可以和其他裝置同步）
 *   files/<sha256>     原始 PDF、圖片（以內容雜湊命名）
 *
 * 用 ZIP 是為了：單一檔案方便備份與分享；格式公開，必要時可以手動解開取回原始 PDF。
 */

export const NOTEBOOK_EXTENSION = "toolnote";
export const NOTEBOOK_FORMAT = "pdf-toolbox-notebook";
export const NOTEBOOK_FILE_VERSION = 1;

interface Manifest {
  format: string;
  version: number;
  title: string;
  savedAt: string;
  pages: number;
}

export async function saveNotebookFile(nb: Notebook, blobs: BlobStore): Promise<Uint8Array> {
  const manifest: Manifest = {
    format: NOTEBOOK_FORMAT,
    version: NOTEBOOK_FILE_VERSION,
    title: nb.title,
    savedAt: new Date().toISOString(),
    pages: nb.pageIds.length,
  };
  const entries: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "notebook.yjs": [Y.encodeStateAsUpdate(nb.doc), { level: 6 }],
  };
  for (const id of nb.usedFileIds) {
    const bytes = await blobs.get(id);
    if (!bytes) throw new Error(`找不到原始檔案「${nb.getFile(id)?.name ?? id}」，無法儲存。`);
    // PDF、圖片本身多半已壓縮，不再壓縮
    entries[`files/${id}`] = [bytes, { level: 0 }];
  }
  return zipSync(entries);
}

export async function openNotebookFile(
  bytes: Uint8Array,
  blobs: BlobStore = new MemoryBlobStore(),
): Promise<{ notebook: Notebook; blobs: BlobStore }> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("不是筆記本檔案，或檔案已損毀。");
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  } catch {
    throw new Error("不是筆記本檔案，或檔案已損毀。");
  }
  if (manifest.format !== NOTEBOOK_FORMAT) throw new Error("不是筆記本檔案。");
  if (manifest.version > NOTEBOOK_FILE_VERSION) {
    throw new Error("這個筆記本是用較新版本的程式建立的，請先更新程式。");
  }

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, entries["notebook.yjs"]);
  } catch {
    throw new Error("筆記本內容已損毀。");
  }
  const notebook = new Notebook(doc);

  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith("files/")) continue;
    const id = path.slice("files/".length);
    if ((await sha256Hex(data)) !== id) throw new Error("筆記本內的原始檔案已損毀。");
    await blobs.put(data);
  }
  for (const id of notebook.usedFileIds) {
    if (!(await blobs.has(id))) throw new Error(`筆記本缺少原始檔案「${notebook.getFile(id)?.name ?? id}」。`);
  }
  return { notebook, blobs };
}
