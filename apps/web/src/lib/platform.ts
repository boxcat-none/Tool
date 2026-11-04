import { zipSync } from "fflate";

/**
 * 平台層：網頁版和軟體版（之後的 Tauri）只有這裡不同。
 * 軟體版會改成呼叫原生的「另存新檔」對話框，直接寫入硬碟。
 */
export interface OutputFile {
  name: string;
  data: Uint8Array;
}

export interface Platform {
  /** 儲存單一檔案 */
  saveFile(file: OutputFile): Promise<void>;
  /** 儲存多個檔案；網頁版打包成一個 ZIP 下載 */
  saveFiles(files: OutputFile[], zipName: string): Promise<void>;
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

const webPlatform: Platform = {
  async saveFile({ name, data }) {
    download(name, new Blob([data as BlobPart], { type: mimeType(name) }));
  },
  async saveFiles(files, zipName) {
    if (files.length === 1) return this.saveFile(files[0]);
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[uniqueName(f.name, entries)] = f.data;
    // PDF、PNG、JPG 本身都已經壓縮過，ZIP 只打包不再壓縮，速度快很多
    const zipped = zipSync(entries, { level: 0 });
    download(zipName, new Blob([zipped as BlobPart], { type: "application/zip" }));
  },
};

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  zip: "application/zip",
};

function mimeType(name: string): string {
  return MIME[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
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

export const platform: Platform = webPlatform;
