/** 頁面的來源：原始 PDF 的某一頁，或是插入的紙張 */
export type PageSource =
  | { kind: "pdf"; fileId: string; index: number }
  | { kind: "template"; template: PaperTemplate };

/** 插入頁的紙張樣式 */
export type PaperTemplate = "blank" | "lined" | "grid" | "dot";

export interface PageInfo {
  id: string;
  source: PageSource;
  /** 頁面大小（pt），未旋轉時的寬高 */
  width: number;
  height: number;
  /** 顯示旋轉角度 */
  rotation: 0 | 90 | 180 | 270;
}

export interface NewPage {
  source: PageSource;
  width: number;
  height: number;
  rotation?: PageInfo["rotation"];
}

/** 筆記本引用的檔案（原始 PDF、圖片）。檔案本身不放在 Yjs 文件裡，以內容雜湊命名。 */
export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** PDF 的總頁數（判斷筆記本是否就是「原封不動的原始 PDF」） */
  pageCount?: number;
  /** 有密碼保護的 PDF：只能閱讀與書寫，不能插頁、刪頁或匯出 */
  encrypted?: boolean;
}
