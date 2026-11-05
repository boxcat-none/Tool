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

/**
 * 頁面上的圖片。座標是 PDF 使用者空間（pt，原點左下），和筆跡相同。
 * (x, y, width, height) 是圖片「轉過之後」在頁面上佔的框；rotation 是圖片內容順時針轉幾度
 * （以未旋轉的頁面來看）。轉 90 或 270 度時，原圖的寬對應框的高。
 */
export interface ImageInfo {
  id: string;
  pageId: string;
  /** 圖片檔（檔案庫裡的代號，JPEG 或 PNG） */
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export type NewImage = Omit<ImageInfo, "id" | "pageId" | "rotation"> & { rotation?: ImageInfo["rotation"] };
export type ImagePatch = Partial<Pick<ImageInfo, "x" | "y" | "width" | "height" | "rotation">>;
