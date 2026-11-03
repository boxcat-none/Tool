export type PdfToolErrorCode =
  | "INVALID_PDF"
  | "ENCRYPTED"
  | "EMPTY_INPUT"
  | "INVALID_RANGE";

/** 所有工具共用的錯誤型別，`message` 為可直接顯示給使用者的中文訊息。 */
export class PdfToolError extends Error {
  readonly code: PdfToolErrorCode;

  constructor(code: PdfToolErrorCode, message: string) {
    super(message);
    this.name = "PdfToolError";
    this.code = code;
  }
}
