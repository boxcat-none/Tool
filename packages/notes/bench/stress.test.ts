/**
 * 300 頁壓力測試（Node）：STRESS_PDF=教科書.pdf pnpm --filter @tool/notes exec vitest run --dir bench --config /dev/null stress
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { handwrittenPage } from "../../core/bench/handwriting";
import { exportPdf, importPdf, MemoryBlobStore, Notebook, openNotebookFile, saveNotebookFile } from "../src";

const PDF = process.env.STRESS_PDF;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

describe.skipIf(!PDF)("300 頁壓力測試", () => {
  it("匯入、重新產生、匯出、存檔", async () => {
    const source = new Uint8Array(readFileSync(PDF!));
    const rows: string[] = [];
    const blobs = new MemoryBlobStore();
    const nb = Notebook.create("教科書");

    const [ids, tImport] = await timed(() => importPdf(nb, blobs, source, "textbook.pdf"));
    rows.push(`| 匯入 ${ids.length} 頁（${mb(source.length)}） | ${tImport.toFixed(0)} ms | |`);

    // 筆跡：30 頁寫滿（每頁約 2,200 筆），其餘 270 頁零星註記（約 100 筆）
    const [, tInk] = await timed(async () => {
      ids.forEach((id, i) => {
        const strokes = handwrittenPage(1000 + i, i % 10 === 5 ? { chars: 200, highlights: 3 } : { chars: 10, highlights: 1 });
        nb.doc.transact(() => strokes.forEach((s) => nb.addStroke(id, s)));
      });
    });
    const strokeTotal = ids.reduce((s, id) => s + nb.strokeCount(id), 0);
    rows.push(`| 加入 ${strokeTotal.toLocaleString()} 筆筆跡 | ${tInk.toFixed(0)} ms | Yjs 文件 ${mb(Y.encodeStateAsUpdate(nb.doc).length)} |`);

    // 顯示用 PDF（插入 3 頁紙張後重新產生；閱讀器每次插頁、刪頁都做這件事）
    nb.insertPages(1, [{ source: { kind: "template", template: "lined" }, width: 595.28, height: 841.89 }]);
    nb.insertPages(150, [{ source: { kind: "template", template: "grid" }, width: 595.28, height: 841.89 }]);
    nb.insertPages(303, [{ source: { kind: "template", template: "dot" }, width: 595.28, height: 841.89 }]);
    const [display, tDisplay] = await timed(() => exportPdf(nb, blobs, { ink: "none" }));
    rows.push(`| 重新產生顯示用 PDF（303 頁，不含筆跡） | ${tDisplay.toFixed(0)} ms | ${mb(display.length)} |`);

    const [flat, tFlat] = await timed(() => exportPdf(nb, blobs, { ink: "flatten" }));
    rows.push(`| 匯出 PDF（筆跡合併） | ${tFlat.toFixed(0)} ms | ${mb(flat.length)} |`);
    const [annots, tAnnots] = await timed(() => exportPdf(nb, blobs, { ink: "annotations" }));
    rows.push(`| 匯出 PDF（筆跡註解） | ${tAnnots.toFixed(0)} ms | ${mb(annots.length)} |`);

    const [file, tSave] = await timed(() => saveNotebookFile(nb, blobs));
    rows.push(`| 存成 .guganote | ${tSave.toFixed(0)} ms | ${mb(file.length)} |`);
    const [opened, tOpen] = await timed(() => openNotebookFile(file));
    rows.push(`| 開啟 .guganote | ${tOpen.toFixed(0)} ms | |`);
    expect(opened.notebook.pageIds).toHaveLength(303);

    const [, tRead] = await timed(async () => opened.notebook.pageIds.forEach((id) => opened.notebook.strokes(id)));
    rows.push(`| 讀出全部筆跡（解碼） | ${tRead.toFixed(0)} ms | |`);

    const table = ["| 動作 | 時間 | 大小 |", "|---|---|---|", ...rows].join("\n");
    console.log("\n" + table);
    if (process.env.STRESS_OUT) writeFileSync(process.env.STRESS_OUT, table + "\n");
  }, 600_000);
});
