import { zipSync } from "fflate";
import * as desktop from "./desktop";

/**
 * 平台層：網頁版和軟體版只有這裡不同。
 * - 網頁版：觸發瀏覽器下載，多個檔案打包成 ZIP
 * - 軟體版：跳出「另存新檔」或「選擇資料夾」對話框，直接寫入硬碟
 */
export interface OutputFile {
  name: string;
  data: Uint8Array;
}

/** 儲存結果的說明（例如「已下載「a.pdf」」）；使用者取消時為 null */
export type SaveResult = string | null;

export interface Platform {
  kind: "web" | "desktop";
  saveFile(file: OutputFile): Promise<SaveResult>;
  /** 儲存多個檔案；網頁版打包成一個 ZIP 下載，軟體版存到選擇的資料夾 */
  saveFiles(files: OutputFile[], zipName: string): Promise<SaveResult>;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  zip: "application/zip",
};

function mimeType(name: string): string {
  return MIME[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 給瀏覽器一點時間開始下載再釋放
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function uniqueName(name: string, taken: Record<string, unknown>): string {
  if (!(name in taken)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  while (`${base} (${i})${ext}` in taken) i++;
  return `${base} (${i})${ext}`;
}

const webPlatform: Platform = {
  kind: "web",
  async saveFile({ name, data }) {
    download(name, new Blob([data as BlobPart], { type: mimeType(name) }));
    return `已下載「${name}」`;
  },
  async saveFiles(files, zipName) {
    if (files.length === 1) return this.saveFile(files[0]);
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[uniqueName(f.name, entries)] = f.data;
    // PDF、PNG、JPG 本身都已經壓縮過，ZIP 只打包不再壓縮，速度快很多
    const zipped = zipSync(entries, { level: 0 });
    download(zipName, new Blob([zipped as BlobPart], { type: "application/zip" }));
    return `已將 ${files.length} 個檔案打包成「${zipName}」下載`;
  },
};

const desktopPlatform: Platform = {
  kind: "desktop",
  async saveFile({ name, data }) {
    const path = await desktop.saveDialog(name);
    if (!path) return null;
    await desktop.writeFile(path, data);
    return `已儲存到「${path}」`;
  },
  async saveFiles(files, _zipName) {
    if (files.length === 1) return this.saveFile(files[0]);
    const dir = await desktop.pickFolder(`選擇要儲存 ${files.length} 個檔案的資料夾`);
    if (!dir) return null;
    for (const f of files) {
      // 不覆蓋資料夾裡已有的同名檔案
      await desktop.writeFile(await desktop.uniqueFilePath(dir, f.name), f.data);
    }
    return `已將 ${files.length} 個檔案儲存到「${dir}」`;
  },
};

export const platform: Platform = desktop.isDesktop ? desktopPlatform : webPlatform;
