import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { exportPdf, importPdf, MemoryBlobStore, Notebook, readOutline } from "../src";

type Entry = { title: string; page?: number; named?: string; action?: boolean; children?: Entry[] };

/** 建立有目錄的 PDF：頁寬 = 300 + 頁碼，方便辨識 */
async function pdfWithOutline(pageCount: number, entries: Entry[], named: Record<string, number> = {}) {
  const doc = await PDFDocument.create();
  const pages = Array.from({ length: pageCount }, (_, i) => doc.addPage([301 + i, 400]));
  const ctx = doc.context;
  const dest = (page: number) => ctx.obj([pages[page - 1].ref, PDFName.of("XYZ"), 0, 400, null]);
  const write = (list: Entry[], parent: ReturnType<typeof ctx.nextRef>) => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((e, i) => {
      const d: Record<string, unknown> = { Title: PDFHexString.fromText(e.title), Parent: parent };
      if (i > 0) d.Prev = refs[i - 1];
      if (i < list.length - 1) d.Next = refs[i + 1];
      if (e.named) d.Dest = PDFString.of(e.named);
      else if (e.action && e.page) d.A = { S: "GoTo", D: dest(e.page) };
      else if (e.page) d.Dest = dest(e.page);
      if (e.children?.length) {
        const [f, l] = write(e.children, refs[i]);
        d.First = f;
        d.Last = l;
        d.Count = e.children.length;
      }
      ctx.assign(refs[i], ctx.obj(d as never));
    });
    return [refs[0], refs[refs.length - 1]];
  };
  const root = ctx.nextRef();
  const [first, last] = write(entries, root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: first, Last: last, Count: entries.length }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  if (Object.keys(named).length) {
    const names = Object.entries(named).sort().flatMap(([k, p]) => [PDFString.of(k), dest(p)]);
    doc.catalog.set(PDFName.of("Names"), ctx.obj({ Dests: { Names: names } }));
  }
  return doc.save();
}

/** 輸出 PDF 的目錄：[標題, 目標頁寬（辨識是原本第幾頁）] */
async function outlineOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const widths = doc.getPages().map((p) => Math.round(p.getWidth()));
  const flat = (items: ReturnType<typeof readOutline>, depth = 0): string[] =>
    items.flatMap((it) => [
      `${"  ".repeat(depth)}${it.title.decodeText()} → ${it.target === null ? "-" : `p${widths[it.target] - 300}`}`,
      ...flat(it.children, depth + 1),
    ]);
  return flat(readOutline(doc));
}

describe("匯出時保留目錄", () => {
  const entries: Entry[] = [
    { title: "第一章", page: 1, children: [{ title: "1.1 小節", page: 2 }, { title: "1.2 小節", page: 3 }] },
    { title: "第二章", page: 4, action: true },
    { title: "附錄", named: "appendix" },
  ];

  it("原封不動匯出：目錄完全一樣（含 GoTo 動作與具名目的地）", async () => {
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("x");
    await importPdf(nb, blobs, await pdfWithOutline(5, entries, { appendix: 5 }), "a.pdf");
    expect(await outlineOf(await exportPdf(nb, blobs, { ink: "none" }))).toEqual([
      "第一章 → p1", "  1.1 小節 → p2", "  1.2 小節 → p3", "第二章 → p4", "附錄 → p5",
    ]);
  });

  it("插頁、移動後目標頁跟著頁面走；刪掉的頁面對應的項目略過", async () => {
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("x");
    const ids = await importPdf(nb, blobs, await pdfWithOutline(5, entries, { appendix: 5 }), "a.pdf");
    nb.insertPages(1, [{ source: { kind: "template", template: "lined" }, width: 595, height: 842 }]);
    nb.movePage(ids[3], 0); // 第 4 頁（第二章）移到最前面
    nb.deletePages([ids[2]]); // 刪掉第 3 頁（1.2 小節）
    const out = await exportPdf(nb, blobs, { ink: "none" });
    const doc = await PDFDocument.load(out);
    // 頁面順序：p4、p1、橫線頁、p2、p5
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([304, 301, 595, 302, 305]);
    expect(await outlineOf(out)).toEqual(["第一章 → p1", "  1.1 小節 → p2", "第二章 → p4", "附錄 → p5"]);
    // 目標頁碼也正確：第二章 → 新的第 1 頁
    expect(readOutline(doc).find((i) => i.title.decodeText() === "第二章")!.target).toBe(0);
  });

  it("目標頁被刪除但還有子項目時保留（點了不跳頁）", async () => {
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("x");
    const ids = await importPdf(nb, blobs, await pdfWithOutline(3, [{ title: "章", page: 1, children: [{ title: "節", page: 2 }] }]), "a.pdf");
    nb.deletePages([ids[0]]);
    expect(await outlineOf(await exportPdf(nb, blobs, { ink: "none" }))).toEqual(["章 → -", "  節 → p2"]);
  });

  it("多份 PDF 的目錄依出現順序接在一起；沒有目錄的檔案不影響", async () => {
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("x");
    await importPdf(nb, blobs, await pdfWithOutline(2, [{ title: "A 檔", page: 2 }]), "a.pdf");
    const plain = await PDFDocument.create();
    plain.addPage([350, 400]);
    await importPdf(nb, blobs, await plain.save(), "plain.pdf");
    await importPdf(nb, blobs, await pdfWithOutline(3, [{ title: "B 檔", page: 3 }]), "b.pdf");
    expect(await outlineOf(await exportPdf(nb, blobs, { ink: "none" }))).toEqual(["A 檔 → p2", "B 檔 → p3"]);
  });

  it("可以關閉目錄複製；沒有目錄的 PDF 不會多出目錄", async () => {
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("x");
    await importPdf(nb, blobs, await pdfWithOutline(2, [{ title: "章", page: 1 }]), "a.pdf");
    expect(await outlineOf(await exportPdf(nb, blobs, { outline: false }))).toEqual([]);
    const blank = Notebook.create("y");
    blank.insertPages(0, [{ source: { kind: "template", template: "grid" }, width: 595, height: 842 }]);
    const out = await PDFDocument.load(await exportPdf(blank, new MemoryBlobStore()));
    expect(out.catalog.has(PDFName.of("Outlines"))).toBe(false);
  });
});
