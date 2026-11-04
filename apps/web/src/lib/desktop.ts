/**
 * 軟體版（Tauri）專用的功能。全部用動態 import，
 * 網頁版不會下載這些程式碼。
 */

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 自動化測試用：以 VITE_E2E=1 建置時，原生對話框改由 window.__e2e 提供結果
 * （測試程式無法點擊系統對話框）。一般建置時這段會被整個移除。
 */
function e2eHook(name: string): ((...args: unknown[]) => unknown) | undefined {
  if (import.meta.env.VITE_E2E !== "1") return undefined;
  return (window as unknown as { __e2e?: Record<string, (...args: unknown[]) => unknown> }).__e2e?.[name];
}

const core = () => import("@tauri-apps/api/core");
const dialog = () => import("@tauri-apps/plugin-dialog");
const opener = () => import("@tauri-apps/plugin-opener");

/** 寫入檔案（內容以原始位元組傳給 Rust，不經過 JSON） */
export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  const { invoke } = await core();
  await invoke("save_file", data, { headers: { "x-path": encodeURIComponent(path) } });
}

/** 把拖放進來的檔案寫到暫存區，回傳暫存路徑 */
export async function writeTemp(file: File): Promise<string> {
  const { invoke } = await core();
  const data = new Uint8Array(await file.arrayBuffer());
  return invoke<string>("write_temp", data, { headers: { "x-name": encodeURIComponent(file.name) } });
}

export async function uniqueFilePath(dir: string, name: string): Promise<string> {
  const { invoke } = await core();
  return invoke<string>("unique_file_path", { dir, name });
}

export async function saveDialog(defaultName: string): Promise<string | null> {
  const hook = e2eHook("save");
  if (hook) return hook(defaultName) as string | null;
  const ext = defaultName.split(".").pop() ?? "";
  const { save } = await dialog();
  return save({
    defaultPath: defaultName,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
}

export async function pickFolder(title: string): Promise<string | null> {
  const hook = e2eHook("pickFolder");
  if (hook) return hook(title) as string | null;
  const { open } = await dialog();
  const result = await open({ directory: true, title });
  return typeof result === "string" ? result : null;
}

export async function pickFiles(title: string, name: string, extensions: string[]): Promise<string[]> {
  const hook = e2eHook("pickFiles");
  if (hook) return hook(extensions) as string[];
  const { open } = await dialog();
  const result = await open({ multiple: true, title, filters: [{ name, extensions }] });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function revealInFolder(path: string): Promise<void> {
  const hook = e2eHook("reveal");
  if (hook) return void hook(path);
  const { revealItemInDir } = await opener();
  await revealItemInDir(path);
}

export async function openUrl(url: string): Promise<void> {
  const hook = e2eHook("openUrl");
  if (hook) return void hook(url);
  const { openUrl } = await opener();
  await openUrl(url);
}

export interface OfficeStatus {
  soffice: string | null;
  extensions: string[];
}

export async function officeStatus(): Promise<OfficeStatus> {
  const hook = e2eHook("officeStatus");
  const fake = hook?.() as OfficeStatus | undefined;
  if (fake) return fake;
  const { invoke } = await core();
  return invoke<OfficeStatus>("office_status");
}

export async function convertOffice(input: string, outDir: string | null): Promise<string> {
  const { invoke } = await core();
  return invoke<string>("convert_office", { input, outDir });
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}
