import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { sha256Hex, type BlobStore } from "./blobs";
import type { Notebook } from "./notebook";

/**
 * 裝置之間的同步協定，和連線方式無關（WebRTC、WebSocket、同一台電腦的分頁都可以用）。
 *
 * 一條連線傳三種資料：
 *   1. Yjs 更新：頁面、筆跡、標題…（y-protocols 的 sync：先交換「我有什麼」，再補對方缺的，之後即時傳每個修改）
 *   2. awareness：暫時狀態，例如誰在線上、正在看哪一頁、正在畫還沒放開的筆畫（不寫進筆記本）
 *   3. 檔案庫：原始 PDF、圖片。Yjs 只記錄檔案代號（SHA-256），缺的檔案才向對方要，分塊傳送，收完驗證雜湊
 *
 * 每則訊息的第一個 byte 是種類。
 */

export const SYNC_PROTOCOL = 1;

export { Awareness } from "y-protocols/awareness";

/** 一條雙向、可靠、有順序的訊息通道 */
export interface Channel {
  send(data: Uint8Array): void;
  /** 還沒送出的資料量（bytes）；傳大檔案時用來控制速度 */
  readonly bufferedAmount?: number;
  /** 等待送出佇列變小 */
  waitDrain?(): Promise<void>;
  onMessage(callback: (data: Uint8Array) => void): () => void;
  onClose(callback: () => void): () => void;
  close(): void;
}

/** 連線一開始交換的資訊 */
export interface Hello {
  app: "guganote";
  protocol: number;
  notebookId: string;
  title: string;
  device: string;
}

const MSG_HELLO = 0;
const MSG_SYNC = 1;
const MSG_AWARENESS = 2;
const MSG_BLOB_WANT = 3;
const MSG_BLOB_DATA = 4;
const MSG_BLOB_NONE = 5;
const MSG_BYE = 6;

/** 每塊大小：WebRTC 各瀏覽器都能可靠傳送的訊息大小 */
export const CHUNK_SIZE = 64 * 1024;
/** 送出佇列超過這個量就先等一下，避免大檔案塞爆記憶體 */
const HIGH_WATER = 1024 * 1024;

const json = (type: number, value: unknown) => {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
};
const parseJson = <T>(data: Uint8Array): T => JSON.parse(new TextDecoder().decode(data.subarray(1))) as T;

const hexToBytes = (hex: string) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * 把通道包起來：收到的訊息先排隊，等真正的處理者接上才交出去。
 * 連線後要先交換 Hello、再開啟（或建立）筆記本，這段時間對方送來的同步訊息不能遺失。
 */
export class PeerLink {
  private queue: Uint8Array[] = [];
  private handler: ((data: Uint8Array) => void) | null = null;
  private offMessage: () => void;
  private offClose: () => void;
  private closeHandlers = new Set<() => void>();
  closed = false;

  constructor(readonly channel: Channel) {
    this.offMessage = channel.onMessage((data) => {
      if (data[0] === MSG_BYE) return this.handleClose();
      if (this.handler) this.handler(data);
      else this.queue.push(data);
    });
    this.offClose = channel.onClose(() => this.handleClose());
  }

  send(data: Uint8Array) {
    if (!this.closed) this.channel.send(data);
  }

  setHandler(handler: ((data: Uint8Array) => void) | null) {
    this.handler = handler;
    if (handler) {
      const pending = this.queue;
      this.queue = [];
      pending.forEach(handler);
    }
  }

  onClose(callback: () => void): () => void {
    if (this.closed) {
      callback();
      return () => {};
    }
    this.closeHandlers.add(callback);
    return () => this.closeHandlers.delete(callback);
  }

  close() {
    if (this.closed) return;
    try {
      this.channel.send(Uint8Array.of(MSG_BYE));
    } catch {
      // 通道已經斷了
    }
    this.channel.close();
    this.handleClose();
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.offMessage();
    this.offClose();
    this.closeHandlers.forEach((cb) => cb());
    this.closeHandlers.clear();
  }

  async drain() {
    const c = this.channel;
    while (!this.closed && (c.bufferedAmount ?? 0) > HIGH_WATER && c.waitDrain) await c.waitDrain();
  }
}

/** 交換 Hello：送出自己的、等對方的。版本不合或不是這個程式時拋出錯誤 */
export function exchangeHello(link: PeerLink, mine: Hello, timeoutMs = 15000): Promise<Hello> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("對方沒有回應。")), timeoutMs);
    const offClose = link.onClose(() => finish(new Error("連線已中斷。")));
    const finish = (result: Hello | Error) => {
      clearTimeout(timer);
      offClose();
      link.setHandler(null);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    link.setHandler((data) => {
      if (data[0] !== MSG_HELLO) return finish(new Error("對方傳來無法辨識的資料。"));
      let hello: Hello;
      try {
        hello = parseJson<Hello>(data);
      } catch {
        return finish(new Error("對方傳來無法辨識的資料。"));
      }
      if (hello.app !== "guganote") return finish(new Error("對方不是筆記本程式。"));
      if (hello.protocol !== SYNC_PROTOCOL) return finish(new Error("兩台裝置的程式版本不同，請都更新到最新版再連線。"));
      finish(hello);
    });
    link.send(json(MSG_HELLO, mine));
  });
}

export interface TransferProgress {
  /** 還在接收的檔案 */
  files: number;
  received: number;
  total: number;
}

export interface SyncSessionOptions {
  /** 收到（並驗證、存好）一個檔案 */
  onFile?: (id: string) => void;
  onProgress?: (progress: TransferProgress) => void;
  /** 收到的檔案內容與代號不符（損毀或被竄改），已丟棄 */
  onError?: (error: Error) => void;
}

interface Incoming {
  buffer: Uint8Array;
  received: number;
}

/**
 * 一本筆記本在一條連線上的同步。
 * 收到的修改以這個物件作為 transaction origin，所以本機的復原（只追蹤本機 origin）不會復原對方的動作。
 */
export class SyncSession {
  readonly awareness: awarenessProtocol.Awareness;
  /** 收到對方的完整內容（sync step 2）後完成 */
  readonly synced: Promise<void>;
  private resolveSynced!: () => void;
  private incoming = new Map<string, Incoming>();
  /** 對方也沒有的檔案（不再重複要） */
  private unavailable = new Set<string>();
  private remoteClients = new Set<number>();
  private offs: (() => void)[] = [];
  private fileWaiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private link: PeerLink,
    private notebook: Notebook,
    private blobs: BlobStore,
    private options: SyncSessionOptions = {},
    awareness?: awarenessProtocol.Awareness,
  ) {
    this.synced = new Promise((r) => (this.resolveSynced = r));
    const doc = notebook.doc;
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc);

    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeUint8(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.link.send(encoding.toUint8Array(enc));
    };
    doc.on("update", onUpdate);
    this.offs.push(() => doc.off("update", onUpdate));

    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      this.sendAwareness(changed);
    };
    this.awareness.on("update", onAwareness);
    this.offs.push(() => this.awareness.off("update", onAwareness));

    // 頁面引用了新的檔案（例如對方插入了圖片）→ 檢查要不要下載
    this.offs.push(notebook.onChange(() => this.requestMissing()));
    this.offs.push(link.onClose(() => this.close()));
    link.setHandler((data) => this.receive(data));

    // 開始：告訴對方「我有什麼」，並送出自己的線上狀態
    const enc = encoding.createEncoder();
    encoding.writeUint8(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, doc);
    this.link.send(encoding.toUint8Array(enc));
    if (this.awareness.getLocalState() !== null) this.sendAwareness([doc.clientID]);
  }

  /** 對方裝置在 awareness 裡的狀態 */
  get peers(): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    for (const id of this.remoteClients) {
      const s = this.awareness.getStates().get(id);
      if (s) out.set(id, s);
    }
    return out;
  }

  /** 筆記本用到的檔案都已經在本機（必要時等對方傳完）。對方也沒有的檔案不會等 */
  async whenFilesReady(): Promise<string[]> {
    for (;;) {
      const missing = await this.missingFiles();
      const pending = missing.filter((id) => !this.unavailable.has(id));
      if (!pending.length || this.closed) return missing;
      await new Promise<void>((r) => this.fileWaiters.push(r));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.offs.forEach((off) => off());
    this.offs = [];
    // 對方的游標、正在畫的筆畫等暫時狀態一併移除
    awarenessProtocol.removeAwarenessStates(this.awareness, [...this.remoteClients], this);
    this.link.setHandler(null);
    this.wake();
  }

  private sendAwareness(clients: number[]) {
    const enc = encoding.createEncoder();
    encoding.writeUint8(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.link.send(encoding.toUint8Array(enc));
  }

  private receive(data: Uint8Array) {
    if (this.closed) return;
    switch (data[0]) {
      case MSG_SYNC: {
        const dec = decoding.createDecoder(data.subarray(1));
        const reply = encoding.createEncoder();
        encoding.writeUint8(reply, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(dec, reply, this.notebook.doc, this);
        if (encoding.length(reply) > 1) this.link.send(encoding.toUint8Array(reply));
        if (kind === syncProtocol.messageYjsSyncStep2) {
          this.resolveSynced();
          this.requestMissing();
        }
        break;
      }
      case MSG_AWARENESS: {
        const dec = decoding.createDecoder(data.subarray(1));
        const update = decoding.readVarUint8Array(dec);
        // 記下哪些 client 是對方的（斷線時移除）
        const peek = decoding.createDecoder(update);
        const n = decoding.readVarUint(peek);
        for (let i = 0; i < n; i++) {
          const client = decoding.readVarUint(peek);
          decoding.readVarUint(peek); // clock
          const state = JSON.parse(decoding.readVarString(peek));
          if (state === null) this.remoteClients.delete(client);
          else this.remoteClients.add(client);
        }
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
        break;
      }
      case MSG_BLOB_WANT:
        void this.sendFiles(parseJson<string[]>(data));
        break;
      case MSG_BLOB_DATA:
        void this.receiveChunk(data);
        break;
      case MSG_BLOB_NONE: {
        const id = bytesToHex(data.subarray(1, 33));
        this.incoming.delete(id);
        this.unavailable.add(id);
        this.report();
        this.wake();
        break;
      }
    }
  }

  private async missingFiles(): Promise<string[]> {
    const ids = this.notebook.usedFileIds;
    const has = await Promise.all(ids.map((id) => this.blobs.has(id)));
    return ids.filter((_, i) => !has[i]);
  }

  private requesting = false;
  private requestAgain = false;
  private async requestMissing() {
    if (this.closed) return;
    if (this.requesting) {
      this.requestAgain = true;
      return;
    }
    this.requesting = true;
    try {
      const want = (await this.missingFiles()).filter((id) => !this.incoming.has(id) && !this.unavailable.has(id));
      if (want.length && !this.closed) {
        // 先登記（大小等收到第一塊才知道）
        for (const id of want) this.incoming.set(id, { buffer: new Uint8Array(0), received: 0 });
        this.link.send(json(MSG_BLOB_WANT, want));
      }
    } finally {
      this.requesting = false;
      if (this.requestAgain) {
        this.requestAgain = false;
        void this.requestMissing();
      }
    }
  }

  private async sendFiles(ids: string[]) {
    for (const id of ids) {
      if (this.closed) return;
      const bytes = await this.blobs.get(id);
      if (!bytes) {
        const msg = new Uint8Array(33);
        msg[0] = MSG_BLOB_NONE;
        msg.set(hexToBytes(id), 1);
        this.link.send(msg);
        continue;
      }
      const head = hexToBytes(id);
      // 空檔案也要送一塊，對方才知道收完了
      for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK_SIZE) {
        await this.link.drain();
        if (this.closed) return;
        const part = bytes.subarray(offset, offset + CHUNK_SIZE);
        const msg = new Uint8Array(1 + 32 + 8 + part.length);
        const view = new DataView(msg.buffer);
        msg[0] = MSG_BLOB_DATA;
        msg.set(head, 1);
        view.setUint32(33, offset);
        view.setUint32(37, bytes.length);
        msg.set(part, 41);
        this.link.send(msg);
        if (bytes.length === 0) break;
      }
    }
  }

  private async receiveChunk(data: Uint8Array) {
    const id = bytesToHex(data.subarray(1, 33));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const offset = view.getUint32(33);
    const total = view.getUint32(37);
    const part = data.subarray(41);
    const entry = this.incoming.get(id);
    if (!entry) return; // 沒有要過的檔案
    if (entry.buffer.length !== total) {
      entry.buffer = new Uint8Array(total);
      entry.received = 0;
    }
    if (offset + part.length > total) return;
    entry.buffer.set(part, offset);
    entry.received += part.length;
    this.report();
    if (entry.received < total) return;

    this.incoming.delete(id);
    const actual = await sha256Hex(entry.buffer);
    if (actual !== id) {
      this.unavailable.add(id);
      this.options.onError?.(new Error("收到的檔案已損毀，已丟棄。"));
    } else {
      await this.blobs.put(entry.buffer);
      this.options.onFile?.(id);
    }
    this.report();
    this.wake();
  }

  private report() {
    let received = 0;
    let total = 0;
    for (const e of this.incoming.values()) {
      received += e.received;
      total += e.buffer.length;
    }
    this.options.onProgress?.({ files: this.incoming.size, received, total });
  }

  private wake() {
    const waiters = this.fileWaiters;
    this.fileWaiters = [];
    waiters.forEach((w) => w());
  }
}

/** 測試與同一個程式內使用：一對互相連接的通道 */
export function channelPair(): [Channel, Channel] {
  const make = () => {
    const listeners = new Set<(d: Uint8Array) => void>();
    const closers = new Set<() => void>();
    return { listeners, closers, open: true };
  };
  const a = make();
  const b = make();
  const side = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): Channel => ({
    send(data) {
      if (!self.open) throw new Error("closed");
      const copy = data.slice();
      // 非同步送達，和真的網路一樣
      queueMicrotask(() => other.open && other.listeners.forEach((l) => l(copy)));
    },
    bufferedAmount: 0,
    onMessage(cb) {
      self.listeners.add(cb);
      return () => self.listeners.delete(cb);
    },
    onClose(cb) {
      self.closers.add(cb);
      return () => self.closers.delete(cb);
    },
    close() {
      for (const s of [self, other]) {
        if (!s.open) continue;
        s.open = false;
        queueMicrotask(() => s.closers.forEach((c) => c()));
      }
    },
  });
  return [side(a, b), side(b, a)];
}
