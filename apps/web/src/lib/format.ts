export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

/** 確保檔名以 .pdf 結尾，並去掉作業系統不允許的字元。 */
export function ensurePdfName(name: string, fallback: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "_");
  const base = baseName(cleaned) || fallback;
  return `${base}.pdf`;
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}
