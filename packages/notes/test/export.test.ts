import type { Stroke } from "@tool/core/ink";
import { strToU8, unzipSync, zipSync } from "fflate";
import { degrees, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  exportPdf,
  importPdf,
  MemoryBlobStore,
  Notebook,
  openNotebookFile,
  paperContent,
  saveNotebookFile,
} from "../src";

/** 測試用 PDF：每頁寬度 = 300 + 標記，方便辨識頁面 */
async function sourcePdf(markers: number[], rotateFirst = 0) {
  const doc = await PDFDocument.create();
  markers.forEach((m, i) => {
    const p = doc.addPage([300 + m, 400]);
    if (i === 0 && rotateFirst) p.setRotation(degrees(rotateFirst));
  });
  return doc.save();
}

const pen = (x: number, color = "#1e3a8a"): Stroke => ({
  tool: "pen", color, size: 1.6, points: [[x, 100, 0.5], [x + 20, 120, 0.6], [x + 40, 110, 0.4]],
});

async function setup() {
  const blobs = new MemoryBlobStore();
  const nb = Notebook.create("課堂筆記");
  const ids = await importPdf(nb, blobs, await sourcePdf([1, 2, 3], 90), "講義.pdf");
  return { nb, blobs, ids };
}

describe("匯入 PDF", () => {
  it("建立頁面並保留大小與旋轉，原始檔存進檔案庫", async () => {
    const { nb, blobs, ids } = await setup();
    expect(ids).toHaveLength(3);
    expect(nb.pageList.map((p) => [p.width, p.rotation])).toEqual([[301, 90], [302, 0], [303, 0]]);
    const src = nb.getPage(ids[0])!.source;
    expect(src.kind === "pdf" && (await blobs.has(src.fileId))).toBe(true);
    expect(nb.getFile(src.kind === "pdf" ? src.fileId : "")!.name).toBe("講義.pdf");
  });

  it("加密或損毀的 PDF 回報錯誤，不會留下頁面", async () => {
    const nb = Notebook.create("x");
    await expect(importPdf(nb, new MemoryBlobStore(), new TextEncoder().encode("not pdf"), "壞.pdf")).rejects.toThrow("壞.pdf");
    expect(nb.pageIds).toEqual([]);
  });
});

describe("匯出 PDF", () => {
  it("依筆記本順序輸出原始頁與插入的紙張頁", async () => {
    const { nb, blobs, ids } = await setup();
    nb.insertPages(1, [{ source: { kind: "template", template: "lined" }, width: 595.28, height: 841.89 }]);
    nb.movePage(ids[2], 0);
    const out = await PDFDocument.load(await exportPdf(nb, blobs));
    expect(out.getPages().map((p) => Math.round(p.getWidth()))).toEqual([303, 301, 595, 302]);
    expect(out.getPage(1).getRotation().angle).toBe(90);
    expect(out.getTitle()).toBe("課堂筆記");
  });

  it("相同樣式的紙張頁共用同一份格線", async () => {
    const nb = Notebook.create("x");
    const blobs = new MemoryBlobStore();
    const A4 = { width: 595.28, height: 841.89 };
    nb.insertPages(0, Array.from({ length: 20 }, () => ({ source: { kind: "template" as const, template: "grid" as const }, ...A4 })));
    const twenty = await exportPdf(nb, blobs);
    nb.deletePages(nb.pageIds.slice(1));
    const one = await exportPdf(nb, blobs);
    // 多 19 頁只多一點點（每頁只有頁面物件與一行繪圖指令）
    expect((twenty.length - one.length) / 19).toBeLessThan(300);

    const doc = await PDFDocument.load(twenty);
    const xobjects = new Set(doc.getPages().map((p) => p.node.Resources()!.lookup(PDFName.of("XObject"))!.toString()));
    expect(xobjects.size).toBe(1);
  });

  it("筆跡：合併模式畫進頁面、註解模式存成手繪註解、none 不含筆跡", async () => {
    const { nb, blobs, ids } = await setup();
    nb.addStroke(ids[1], pen(10));
    nb.addStroke(ids[1], { ...pen(10, "#facc15"), tool: "highlighter", size: 12 });

    const flat = await PDFDocument.load(await exportPdf(nb, blobs, { ink: "flatten" }));
    expect(flat.getPage(1).node.Annots()?.size() ?? 0).toBe(0);
    const contents = flat.getPage(1).node.Contents()!;
    expect(contents.toString()).toContain("R"); // 有多個內容串流（原內容包在 q…Q + 筆跡）

    const annots = await PDFDocument.load(await exportPdf(nb, blobs, { ink: "annotations" }));
    const list = annots.getPage(1).node.Annots()!;
    expect(list.size()).toBe(2);
    const a = annots.context.lookup(list.get(0)) as unknown as import("pdf-lib").PDFDict;
    expect(a.get(PDFName.of("Subtype"))).toBe(PDFName.of("Ink"));
    expect(a.has(PDFName.of("PDFToolboxInk"))).toBe(false); // 方案 C：PDF 不含可編輯資料

    const none = await PDFDocument.load(await exportPdf(nb, blobs, { ink: "none" }));
    expect(none.getPage(1).node.Annots()?.size() ?? 0).toBe(0);
  });

  it("只匯出部分頁面", async () => {
    const { nb, blobs, ids } = await setup();
    const out = await PDFDocument.load(await exportPdf(nb, blobs, { pageIds: [ids[2], ids[0]] }));
    expect(out.getPages().map((p) => Math.round(p.getWidth()))).toEqual([303, 301]);
  });

  it("缺少原始檔案時回報錯誤", async () => {
    const { nb } = await setup();
    await expect(exportPdf(nb, new MemoryBlobStore())).rejects.toThrow("講義.pdf");
  });
});

describe("紙張樣式", () => {
  it("空白沒有內容；其他樣式都畫在頁面範圍內", () => {
    expect(paperContent("blank", 595, 842)).toBe("");
    for (const t of ["lined", "grid", "dot"] as const) {
      // 去掉第一行（顏色、線寬設定），其餘都是座標
      const nums = paperContent(t, 595, 842).split("\n").slice(1).join(" ").match(/-?\d+(\.\d+)?/g)!.map(Number);
      expect(nums.length).toBeGreaterThan(10);
      expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...nums)).toBeLessThanOrEqual(842);
    }
  });
});

describe("筆記本檔案（.guganote）", () => {
  it("儲存後重新開啟：頁面、筆跡、原始檔案都在，還能再匯出", async () => {
    const { nb, blobs, ids } = await setup();
    nb.insertPages(3, [{ source: { kind: "template", template: "dot" }, width: 595.28, height: 841.89 }]);
    nb.addStroke(ids[0], pen(10));
    const file = await saveNotebookFile(nb, blobs);

    const { notebook, blobs: restored } = await openNotebookFile(file);
    expect(notebook.title).toBe("課堂筆記");
    expect(notebook.pageList).toEqual(nb.pageList);
    expect(notebook.strokes(ids[0])).toEqual(nb.strokes(ids[0]));
    const pdf = await PDFDocument.load(await exportPdf(notebook, restored));
    expect(pdf.getPageCount()).toBe(4);
  });

  it("開啟後仍可以和其他裝置的修改合併（保留 Yjs 合併資訊）", async () => {
    const { nb, blobs, ids } = await setup();
    const file = await saveNotebookFile(nb, blobs);
    const { notebook } = await openNotebookFile(file);
    nb.addStroke(ids[0], pen(10)); // 存檔後在原裝置繼續寫
    notebook.addStroke(ids[0], pen(50, "#b91c1c")); // 另一台裝置打開檔案後也寫
    Y.applyUpdate(notebook.doc, Y.encodeStateAsUpdate(nb.doc, Y.encodeStateVector(notebook.doc)));
    expect(notebook.strokeCount(ids[0])).toBe(2);
  });

  it("只打包仍被使用的原始檔", async () => {
    const { nb, blobs, ids } = await setup();
    await importPdf(nb, blobs, await sourcePdf([9]), "另一份.pdf");
    nb.deletePages(nb.pageIds.filter((id) => !ids.includes(id)));
    const names = Object.keys(unzipSync(await saveNotebookFile(nb, blobs)));
    expect(names.filter((n) => n.startsWith("files/"))).toHaveLength(1);
  });

  it("錯誤處理：不是 ZIP、格式不對、版本太新、檔案被竄改", async () => {
    await expect(openNotebookFile(new TextEncoder().encode("hello"))).rejects.toThrow("不是筆記本檔案");
    await expect(openNotebookFile(zipSync({ "manifest.json": strToU8('{"format":"other"}') }))).rejects.toThrow("不是筆記本檔案");

    const { nb, blobs } = await setup();
    const entries = unzipSync(await saveNotebookFile(nb, blobs));
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    await expect(
      openNotebookFile(zipSync({ ...entries, "manifest.json": strToU8(JSON.stringify({ ...manifest, version: 99 })) })),
    ).rejects.toThrow("較新版本");

    const fileKey = Object.keys(entries).find((k) => k.startsWith("files/"))!;
    const tampered = entries[fileKey].slice();
    tampered[tampered.length - 5] ^= 0xff;
    await expect(openNotebookFile(zipSync({ ...entries, [fileKey]: tampered }))).rejects.toThrow("已損毀");

    const { [fileKey]: _removed, ...missing } = entries;
    await expect(openNotebookFile(zipSync(missing))).rejects.toThrow("缺少原始檔案");
  });
});

