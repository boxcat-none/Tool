/**
 * 方案 C 容量量測：筆記本檔（.guganote）與匯出 PDF 的大小。
 *
 *   EXPORT_BENCH_OUT=/path pnpm --filter @tool/notes exec vitest run --dir bench --config /dev/null
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { describe, it } from "vitest";
import { handwrittenPage } from "../../core/bench/handwriting";
import { exportPdf, importPdf, MemoryBlobStore, Notebook, saveNotebookFile } from "../src";

const OUT = process.env.EXPORT_BENCH_OUT;
const A4 = { width: 595.28, height: 841.89 };
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** 模擬講義：有文字的 A4 頁 */
async function handout(pages: number) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([A4.width, A4.height]);
    p.drawText(`Lecture handout - page ${i + 1}`, { x: 50, y: 800, size: 18, font, color: rgb(0.2, 0.2, 0.2) });
  }
  return doc.save();
}

describe.skipIf(!OUT)("方案 C 容量", () => {
  it("筆記本檔與匯出 PDF", async () => {
    mkdirSync(OUT!, { recursive: true });
    const rows: string[] = [];
    const cases: [string, { chars: number; highlights: number }][] = [
      ["零星註記", { chars: 10, highlights: 2 }],
      ["整頁筆記", { chars: 200, highlights: 4 }],
    ];
    for (const [name, spec] of cases) {
      const blobs = new MemoryBlobStore();
      const nb = Notebook.create(name);
      const source = await handout(1);
      const [page] = await importPdf(nb, blobs, source, "講義.pdf");
      for (const s of handwrittenPage(name.length * 7919 + spec.chars, spec)) nb.addStroke(page, s);

      const base = (await saveNotebookFile(Notebook.create("x"), blobs)).length; // 空筆記本
      const file = await saveNotebookFile(nb, blobs);
      const plain = await exportPdf(nb, blobs, { ink: "none" });
      const flat = await exportPdf(nb, blobs, { ink: "flatten" });
      const annots = await exportPdf(nb, blobs, { ink: "annotations" });
      rows.push(`| ${name} | ${nb.strokeCount(page)} | ${kb(file.length - base - source.length)} | ${kb(flat.length - plain.length)} | ${kb(annots.length - plain.length)} |`);
      writeFileSync(join(OUT!, `${name}.guganote`), file);
      writeFileSync(join(OUT!, `${name}-合併.pdf`), flat);
      writeFileSync(join(OUT!, `${name}-註解.pdf`), annots);
    }

    // 範例：講義 2 頁 + 四種紙張 + 筆跡（顯示檢查用）
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("範例筆記本");
    const [p1] = await importPdf(nb, blobs, await handout(2), "講義.pdf");
    const added = nb.insertPages(1, (["blank", "lined", "grid", "dot"] as const).map((template) => ({ source: { kind: "template" as const, template }, ...A4 })));
    for (const s of handwrittenPage(7, { chars: 40, highlights: 1 })) nb.addStroke(p1, s);
    for (const s of handwrittenPage(8, { chars: 60, highlights: 0 })) nb.addStroke(added[1], s);
    writeFileSync(join(OUT!, "範例筆記本.guganote"), await saveNotebookFile(nb, blobs));
    writeFileSync(join(OUT!, "範例-合併.pdf"), await exportPdf(nb, blobs, { ink: "flatten" }));
    writeFileSync(join(OUT!, "範例-註解.pdf"), await exportPdf(nb, blobs, { ink: "annotations" }));

    const table = [
      "| 一頁的筆跡 | 筆畫 | 筆記本檔增加 | 匯出（合併）增加 | 匯出（註解）增加 |",
      "|---|---|---|---|---|",
      ...rows,
    ].join("\n");
    writeFileSync(join(OUT!, "results.md"), table + "\n");
    console.log("\n" + table);
  }, 120_000);
});
