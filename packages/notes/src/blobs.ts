/**
 * 檔案庫：原始 PDF、圖片等大型檔案。
 * 以 SHA-256 雜湊當作檔案代號：同一個檔案只存一份，同步時也只傳一次。
 */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Uint8Array | undefined>;
  has(id: string): Promise<boolean>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 記憶體中的檔案庫（測試與暫時使用；正式版會改用 IndexedDB 或檔案系統） */
export class MemoryBlobStore implements BlobStore {
  private map = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array) {
    const id = await sha256Hex(bytes);
    if (!this.map.has(id)) this.map.set(id, bytes.slice());
    return id;
  }
  async get(id: string) {
    return this.map.get(id);
  }
  async has(id: string) {
    return this.map.has(id);
  }
}
