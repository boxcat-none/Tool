import type { Stroke } from "@tool/core/ink";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MemoryBlobStore, Notebook, sha256Hex, type BlobStore } from "../src";
import { CHUNK_SIZE, channelPair, exchangeHello, PeerLink, SYNC_PROTOCOL, SyncSession, type Hello } from "../src/sync";

const A4 = { width: 595.28, height: 841.89 };
const lined = { source: { kind: "template" as const, template: "lined" as const }, ...A4 };
const stroke = (x: number): Stroke => ({ tool: "pen", color: "#1e3a8a", size: 1.6, points: [[x, 100, 0.5], [x + 10, 110, 0.6]] });
const xs = (nb: Notebook, pageId: string) => nb.strokes(pageId).map((s) => s.stroke.points[0][0]).sort((a, b) => a - b);

function randomBytes(n: number) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/** 有 PDF 原檔的筆記本（內容隨機，只測傳輸） */
async function withFile(size: number) {
  const blobs = new MemoryBlobStore();
  const bytes = randomBytes(size);
  const fileId = await blobs.put(bytes);
  const nb = Notebook.create("課本");
  nb.addFile({ id: fileId, name: "課本.pdf", mime: "application/pdf", size, pageCount: 2 });
  nb.insertPages(0, [0, 1].map((index) => ({ source: { kind: "pdf" as const, fileId, index }, ...A4 })));
  return { nb, blobs, bytes, fileId };
}

function connect(a: Notebook, b: Notebook, blobsA: BlobStore = new MemoryBlobStore(), blobsB: BlobStore = new MemoryBlobStore(), opts: ConstructorParameters<typeof SyncSession>[3] = {}) {
  const [ca, cb] = channelPair();
  const la = new PeerLink(ca);
  const lb = new PeerLink(cb);
  const sa = new SyncSession(la, a, blobsA);
  const sb = new SyncSession(lb, b, blobsB, opts);
  return { sa, sb, la, lb };
}

const clone = (nb: Notebook) => {
  const other = new Notebook();
  Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(nb.doc));
  return other;
};

describe("同步：筆記本內容", () => {
  it("兩台裝置離線時各自修改，連線後合併成一樣", async () => {
    const a = Notebook.create("筆記");
    a.insertPages(0, [lined]);
    const b = clone(a);
    const page = a.pageIds[0];
    a.addStroke(page, stroke(1));
    a.insertPages(1, [lined]);
    b.addStroke(page, stroke(2));
    b.title = "改過的名稱";

    const { sa, sb } = connect(a, b);
    await Promise.all([sa.synced, sb.synced]);
    expect(xs(a, page)).toEqual([1, 2]);
    expect(xs(b, page)).toEqual([1, 2]);
    expect(b.pageIds).toEqual(a.pageIds);
    expect(a.pageIds).toHaveLength(2);
    expect(a.title).toBe("改過的名稱");
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });

  it("連線中的修改即時傳到對方，每筆只傳一次", async () => {
    const a = Notebook.create("筆記");
    a.insertPages(0, [lined]);
    const b = clone(a);
    const { sa, sb } = connect(a, b);
    await Promise.all([sa.synced, sb.synced]);
    const page = a.pageIds[0];

    const sent: number[] = [];
    b.doc.on("update", (u: Uint8Array) => sent.push(u.length));
    for (let i = 0; i < 20; i++) a.addStroke(page, stroke(i));
    await vi.waitFor(() => expect(b.strokes(page)).toHaveLength(20));
    expect(sent).toHaveLength(20);
    // 收到的修改不會再送回去（不會無限迴圈）
    b.addStroke(page, stroke(99));
    await vi.waitFor(() => expect(a.strokes(page)).toHaveLength(21));
    expect(xs(a, page)).toEqual(xs(b, page));
  });

  it("復原只復原自己的動作，不會復原對方的", async () => {
    const a = Notebook.create("筆記");
    a.insertPages(0, [lined]);
    const b = clone(a);
    const page = a.pageIds[0];
    const { sa, sb } = connect(a, b);
    await Promise.all([sa.synced, sb.synced]);
    const undoB = b.createUndoManager("this-device");

    a.addStroke(page, stroke(1));
    await vi.waitFor(() => expect(b.strokes(page)).toHaveLength(1));
    b.doc.transact(() => b.addStroke(page, stroke(2)), "this-device");
    undoB.undo();
    expect(xs(b, page)).toEqual([1]);
    await vi.waitFor(() => expect(xs(a, page)).toEqual([1]));
  });

  it("新裝置從空白開始：收到整本筆記本（代號、標題、頁面）與原始檔", async () => {
    const { nb: a, blobs: blobsA, bytes, fileId } = await withFile(CHUNK_SIZE * 5 + 123);
    a.addStroke(a.pageIds[0], stroke(5));
    const b = new Notebook();
    const blobsB = new MemoryBlobStore();
    const files: string[] = [];
    const progress: number[] = [];
    const { sb } = connect(a, b, blobsA, blobsB, { onFile: (id) => files.push(id), onProgress: (p) => progress.push(p.received) });
    await sb.synced;
    expect(b.id).toBe(a.id);
    expect(b.title).toBe("課本");
    expect(b.pageIds).toEqual(a.pageIds);
    expect(await sb.whenFilesReady()).toEqual([]);
    expect(await blobsB.get(fileId)).toEqual(bytes);
    expect(files).toEqual([fileId]);
    expect(progress.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...progress)).toBe(bytes.length);
  });

  it("連線中對方插入引用新檔案的頁面 → 自動下載該檔案", async () => {
    const a = Notebook.create("筆記");
    a.insertPages(0, [lined]);
    const b = clone(a);
    const blobsA = new MemoryBlobStore();
    const blobsB = new MemoryBlobStore();
    const { sb } = connect(a, b, blobsA, blobsB);
    await sb.synced;
    const bytes = randomBytes(1000);
    const fileId = await blobsA.put(bytes);
    a.addFile({ id: fileId, name: "附件.pdf", mime: "application/pdf", size: bytes.length, pageCount: 1 });
    a.insertPages(1, [{ source: { kind: "pdf", fileId, index: 0 }, ...A4 }]);
    await vi.waitFor(async () => expect(await blobsB.has(fileId)).toBe(true));
    expect(await sb.whenFilesReady()).toEqual([]);
  });

  it("收到的檔案和代號不符（損毀）→ 丟棄並回報，不會存進檔案庫", async () => {
    const { nb: a, blobs: good, fileId } = await withFile(5000);
    const tampered: BlobStore = {
      put: (b) => good.put(b),
      has: (id) => good.has(id),
      get: async (id) => {
        const b = (await good.get(id))!.slice();
        b[10] ^= 0xff;
        return b;
      },
    };
    const b = new Notebook();
    const blobsB = new MemoryBlobStore();
    const errors: string[] = [];
    const { sb } = connect(a, b, tampered, blobsB, { onError: (e) => errors.push(e.message) });
    await sb.synced;
    expect(await sb.whenFilesReady()).toEqual([fileId]);
    expect(await blobsB.has(fileId)).toBe(false);
    expect(errors).toEqual(["收到的檔案已損毀，已丟棄。"]);
  });

  it("兩邊都沒有的檔案：不會一直等", async () => {
    const { nb: a, fileId } = await withFile(100);
    const b = new Notebook();
    const { sb } = connect(a, b, new MemoryBlobStore(), new MemoryBlobStore());
    await sb.synced;
    expect(await sb.whenFilesReady()).toEqual([fileId]);
  });

  it("大檔案（20 MB）分塊傳送，內容正確", async () => {
    const { nb: a, blobs: blobsA, bytes, fileId } = await withFile(20 * 1024 * 1024);
    const b = new Notebook();
    const blobsB = new MemoryBlobStore();
    const { sb } = connect(a, b, blobsA, blobsB);
    await sb.synced;
    const t = performance.now();
    expect(await sb.whenFilesReady()).toEqual([]);
    const got = (await blobsB.get(fileId))!;
    expect(got.length).toBe(bytes.length);
    expect(await sha256Hex(got)).toBe(fileId);
    console.log(`20 MB 檔案傳輸（記憶體通道）：${Math.round(performance.now() - t)} ms`);
  });
});

describe("同步：線上狀態（awareness）", () => {
  it("看得到對方的狀態；斷線後自動移除", async () => {
    const a = Notebook.create("筆記");
    const b = clone(a);
    const { sa, sb, la } = connect(a, b);
    sa.awareness.setLocalState({ device: "iPad", page: 3 });
    await vi.waitFor(() => expect([...sb.peers.values()]).toEqual([{ device: "iPad", page: 3 }]));
    sb.awareness.setLocalStateField("device", "電腦");
    await vi.waitFor(() => expect([...sa.peers.values()]).toEqual([{ device: "電腦" }]));
    // 正在畫的筆畫（暫時狀態）：每次移動都更新，不寫進筆記本
    const before = Y.encodeStateVector(b.doc);
    sa.awareness.setLocalStateField("live", { page: "p1", points: [[1, 2, 0.5]] });
    await vi.waitFor(() => expect(sb.peers.values().next().value?.live).toBeTruthy());
    expect(Y.encodeStateVector(b.doc)).toEqual(before);

    la.close();
    await vi.waitFor(() => expect(sb.peers.size).toBe(0));
  });
});

describe("同步：連線開始（Hello）", () => {
  const hello = (over: Partial<Hello> = {}): Hello => ({ app: "guganote", protocol: SYNC_PROTOCOL, notebookId: "n1", title: "筆記", device: "電腦", ...over });

  it("交換筆記本代號與裝置名稱；之後送來的同步訊息不會遺失", async () => {
    const a = Notebook.create("筆記");
    a.insertPages(0, [lined]);
    const [ca, cb] = channelPair();
    const la = new PeerLink(ca);
    const lb = new PeerLink(cb);
    const [ha, hb] = await Promise.all([
      exchangeHello(la, hello({ notebookId: a.id, device: "電腦" })),
      exchangeHello(lb, hello({ notebookId: "", device: "iPad" })),
    ]);
    expect(ha.device).toBe("iPad");
    expect(hb.notebookId).toBe(a.id);
    // a 立刻開始同步，b 過一陣子才準備好筆記本
    const sa = new SyncSession(la, a, new MemoryBlobStore());
    await new Promise((r) => setTimeout(r, 30));
    const b = new Notebook();
    const sb = new SyncSession(lb, b, new MemoryBlobStore());
    await Promise.all([sa.synced, sb.synced]);
    expect(b.pageIds).toEqual(a.pageIds);
  });

  it("版本不同時拒絕連線", async () => {
    const [ca, cb] = channelPair();
    const r = exchangeHello(new PeerLink(ca), hello());
    void exchangeHello(new PeerLink(cb), hello({ protocol: SYNC_PROTOCOL + 1 })).catch(() => {});
    await expect(r).rejects.toThrow("版本不同");
  });

  it("對方斷線時不會一直等", async () => {
    const [ca, cb] = channelPair();
    const r = exchangeHello(new PeerLink(ca), hello());
    cb.close();
    await expect(r).rejects.toThrow("連線已中斷");
  });
});
