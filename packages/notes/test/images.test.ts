import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { fakeJpeg, makePng } from "../../core/test/helpers";
import { exportPdf, MemoryBlobStore, Notebook } from "../src";
import { imagePlacement } from "../src/notebook";
import { channelPair, PeerLink, SyncSession } from "../src/sync";

const A4 = { width: 595.28, height: 841.89 };
const blank = { source: { kind: "template" as const, template: "blank" as const }, ...A4 };
const clone = (nb: Notebook) => {
  const other = new Notebook();
  Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(nb.doc));
  return other;
};
const sync = (a: Notebook, b: Notebook) => {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
};

async function withImages() {
  const blobs = new MemoryBlobStore();
  const png = await blobs.put(makePng(40, 20));
  const jpg = await blobs.put(fakeJpeg(30, 60));
  const nb = Notebook.create("圖片");
  const [p1, p2] = nb.insertPages(0, [blank, blank]);
  for (const [id, name, mime] of [[png, "a.png", "image/png"], [jpg, "b.jpg", "image/jpeg"]]) {
    nb.addFile({ id, name, mime, size: 1 });
  }
  return { nb, blobs, png, jpg, p1, p2 };
}

/** 頁面用到的圖片 XObject 數量 */
function imageXObjects(doc: PDFDocument, index: number): number {
  const res = doc.getPage(index).node.Resources();
  const xo = res?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xo) return 0;
  return xo.keys().filter((k) => (xo.lookup(k) as PDFRawStream).dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;
}

function contentText(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const streams = contents instanceof PDFRawStream ? [contents] : (contents as unknown as { asArray(): unknown[] }).asArray().map((r) => doc.context.lookup(r as never));
  return streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s as PDFRawStream).decode())).join("\n");
}

describe("圖片", () => {
  it("新增、移動、縮放、刪除；依疊放順序列出", async () => {
    const { nb, png, jpg, p1, p2 } = await withImages();
    const a = nb.addImage(p1, { fileId: png, x: 50, y: 60, width: 200, height: 100 });
    const b = nb.addImage(p1, { fileId: jpg, x: 10, y: 10, width: 30, height: 60 });
    nb.addImage(p2, { fileId: jpg, x: 0, y: 0, width: 30, height: 60 });
    expect(nb.images(p1).map((i) => i.id)).toEqual([a, b]); // 後加的在上面
    nb.updateImage(a, { x: 70.123, width: 300 });
    expect(nb.getImage(a)).toMatchObject({ x: 70.12, y: 60, width: 300, height: 100, pageId: p1, fileId: png });
    nb.removeImages([b]);
    expect(nb.images(p1).map((i) => i.id)).toEqual([a]);
    expect(nb.images(p2)).toHaveLength(1);
  });

  it("用到的檔案包含圖片；刪頁時一併刪除該頁的圖片", async () => {
    const { nb, png, jpg, p1, p2 } = await withImages();
    nb.addImage(p1, { fileId: png, x: 0, y: 0, width: 10, height: 10 });
    nb.addImage(p2, { fileId: jpg, x: 0, y: 0, width: 10, height: 10 });
    expect(nb.usedFileIds.sort()).toEqual([png, jpg].sort());
    nb.deletePages([p2]);
    expect(nb.usedFileIds).toEqual([png]);
    expect(nb.images(p2)).toEqual([]);
  });

  it("復原：只復原本機的插入與移動", async () => {
    const { nb, png, p1 } = await withImages();
    const undo = nb.createUndoManager("me");
    let id = "";
    nb.doc.transact(() => (id = nb.addImage(p1, { fileId: png, x: 0, y: 0, width: 10, height: 10 })), "me");
    nb.doc.transact(() => nb.updateImage(id, { x: 100, y: 100 }), "me");
    undo.undo();
    expect(nb.getImage(id)).toMatchObject({ x: 0, y: 0 });
    undo.undo();
    expect(nb.getImage(id)).toBeUndefined();
    undo.redo();
    expect(nb.getImage(id)).toMatchObject({ x: 0, y: 0, fileId: png });
  });

  it("兩台裝置同時移動、縮放同一張圖：每個欄位以最後一次為準，兩邊一致", async () => {
    const { nb: a, png, p1 } = await withImages();
    const id = a.addImage(p1, { fileId: png, x: 0, y: 0, width: 10, height: 10 });
    const b = clone(a);
    a.updateImage(id, { x: 100, y: 100 });
    b.updateImage(id, { width: 50, height: 50 });
    sync(a, b);
    expect(a.getImage(id)).toEqual(b.getImage(id));
    expect(a.getImage(id)).toMatchObject({ width: 50, height: 50 });
    // 一台刪除、另一台同時移動 → 刪除
    a.removeImages([id]);
    b.updateImage(id, { x: 5 });
    sync(a, b);
    expect(a.getImage(id)).toBeUndefined();
    expect(b.getImage(id)).toBeUndefined();
  });

  it("變動通知告訴是哪些頁面", async () => {
    const { nb, png, p1, p2 } = await withImages();
    const seen: string[][] = [];
    nb.onImagesChange((ids) => seen.push([...ids]));
    const id = nb.addImage(p1, { fileId: png, x: 0, y: 0, width: 10, height: 10 });
    nb.updateImage(id, { x: 3 });
    nb.addImage(p2, { fileId: png, x: 0, y: 0, width: 10, height: 10 });
    nb.removeImages([id]);
    expect(seen).toEqual([[p1], [p1], [p2], [p1]]);
  });

  it("匯出 PDF：圖片畫在指定位置與大小，同一張圖只嵌入一次；images: false 時不含", async () => {
    const { nb, blobs, png, jpg, p1, p2 } = await withImages();
    nb.addImage(p1, { fileId: png, x: 50, y: 60, width: 200, height: 100 });
    nb.addImage(p1, { fileId: jpg, x: 300, y: 400, width: 30, height: 60 });
    nb.addImage(p2, { fileId: png, x: 0, y: 0, width: 20, height: 10 });
    nb.addStroke(p1, { tool: "pen", color: "#000000", size: 2, points: [[10, 10, 0.5], [20, 20, 0.5]] });
    const doc = await PDFDocument.load(await exportPdf(nb, blobs));
    expect(imageXObjects(doc, 0)).toBe(2);
    expect(imageXObjects(doc, 1)).toBe(1);
    // 兩頁共用同一個 PNG 物件
    const all = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    expect(all).toHaveLength(2);
    // 位置與大小：單位正方形 → (x, y, 寬, 高)
    const text = contentText(doc, 0);
    expect(text).toContain("200 0 0 100 50 60 cm");
    expect(text).toContain("30 0 0 60 300 400 cm");
    // 筆跡在圖片之後（上面）
    expect(text.lastIndexOf(" Do")).toBeLessThan(text.lastIndexOf(" f"));

    const none = await PDFDocument.load(await exportPdf(nb, blobs, { images: false, ink: "none" }));
    expect(imageXObjects(none, 0)).toBe(0);
  });

  it("旋轉：原圖四個角都落在框裡，方向正確；匯出時用同一個矩陣", async () => {
    const box = { x: 10, y: 20, width: 60, height: 30 };
    const apply = (m: number[], u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
    for (const rotation of [0, 90, 180, 270] as const) {
      const b = rotation % 180 ? box : { ...box, width: 30, height: 60 };
      const { naturalWidth: nw, naturalHeight: nh, matrix } = imagePlacement({ ...b, rotation });
      const corners = [[0, 0], [nw, 0], [nw, nh], [0, nh]].map(([u, v]) => apply(matrix, u, v));
      for (const [px, py] of corners) {
        expect(px).toBeGreaterThanOrEqual(b.x - 1e-9);
        expect(px).toBeLessThanOrEqual(b.x + b.width + 1e-9);
        expect(py).toBeGreaterThanOrEqual(b.y - 1e-9);
        expect(py).toBeLessThanOrEqual(b.y + b.height + 1e-9);
      }
      // 原圖的左上角：0 度在框的左上、90 度（順時針）在右上、180 度在右下、270 度在左下
      const expected = { 0: [b.x, b.y + b.height], 90: [b.x + b.width, b.y + b.height], 180: [b.x + b.width, b.y], 270: [b.x, b.y] }[rotation];
      expect(corners[0]).toEqual(expected);
    }

    const { nb, blobs, png, p1 } = await withImages();
    nb.addImage(p1, { fileId: png, x: 10, y: 20, width: 60, height: 30, rotation: 90 });
    const doc = await PDFDocument.load(await exportPdf(nb, blobs));
    // 原圖 30×60 順時針轉 90 度：單位正方形 (s, t) → (10 + 60t, 50 − 30s)
    expect(contentText(doc, 0)).toContain("0 -30 60 0 10 50 cm");
  });

  it("旋轉可以修改、同步、復原", async () => {
    const { nb, png, p1 } = await withImages();
    const undo = nb.createUndoManager("me");
    const id = nb.addImage(p1, { fileId: png, x: 0, y: 0, width: 40, height: 20 });
    expect(nb.getImage(id)!.rotation).toBe(0);
    nb.doc.transact(() => nb.updateImage(id, { rotation: 90, width: 20, height: 40 }), "me");
    const other = clone(nb);
    expect(other.getImage(id)).toMatchObject({ rotation: 90, width: 20, height: 40 });
    undo.undo();
    expect(nb.getImage(id)).toMatchObject({ rotation: 0, width: 40, height: 20 });
  });

  it("同步：對方插入圖片 → 自動收到圖片檔", async () => {
    const { nb: a, blobs: blobsA, png, p1 } = await withImages();
    const b = clone(a);
    const blobsB = new MemoryBlobStore();
    const [ca, cb] = channelPair();
    new SyncSession(new PeerLink(ca), a, blobsA);
    const sb = new SyncSession(new PeerLink(cb), b, blobsB);
    await sb.synced;
    a.addImage(p1, { fileId: png, x: 0, y: 0, width: 10, height: 10 });
    await vi.waitFor(async () => expect(await blobsB.has(png)).toBe(true));
    expect(b.images(p1)).toHaveLength(1);
  });
});
