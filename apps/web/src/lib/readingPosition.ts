/**
 * 記住每份 PDF 讀到第幾頁（以 pdf.js 的文件指紋識別，同一份檔案改名或移動也認得）。
 * 存在瀏覽器的 localStorage，只是方便用，讀寫失敗（私密瀏覽等）時直接略過。
 */
const KEY = "reader.positions.v1";
const MAX_ENTRIES = 200;

type Store = Record<string, { page: number; t: number }>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function loadPosition(fingerprint: string): number | null {
  const page = read()[fingerprint]?.page;
  return typeof page === "number" && page >= 1 ? page : null;
}

export function savePosition(fingerprint: string, page: number): void {
  try {
    const all = read();
    all[fingerprint] = { page, t: Date.now() };
    const entries = Object.entries(all);
    if (entries.length > MAX_ENTRIES) {
      // 只保留最近讀過的
      entries.sort((a, b) => b[1].t - a[1].t);
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.slice(0, MAX_ENTRIES))));
    } else {
      localStorage.setItem(KEY, JSON.stringify(all));
    }
  } catch {
    // 無法儲存就算了
  }
}

/** 側邊欄等小設定 */
export function loadPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`reader.${key}`) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`reader.${key}`, value);
  } catch {
    // 略過
  }
}
