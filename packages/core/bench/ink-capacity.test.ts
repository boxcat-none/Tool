/**
 * 筆跡容量測試：模擬中文手寫，量測寫入 PDF 後的檔案大小與速度。
 *
 *   INK_BENCH_OUT=/path/to/output npx vitest run bench/ink-capacity.test.ts
 *
 * 沒有設定 INK_BENCH_OUT 時跳過（不屬於一般單元測試）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { encodeStrokes, readInk, writeInk, type Stroke, type WriteInkOptions } from "../src/ink";
import { handwrittenPage, type PageSpec } from "./handwriting";

const OUT = process.env.INK_BENCH_OUT;

const PAGES: Record<string, PageSpec> = {
  零星註記: { chars: 10, highlights: 2 },
  半頁筆記: { chars: 100, highlights: 3 },
  整頁筆記: { chars: 200, highlights: 4 },
  極密小字: { chars: 500, highlights: 5 },
};

const NAIVE: WriteInkOptions & { objectStreams: boolean } = {
  simplifyTolerance: 0,
  group: false,
  compress: false,
  dataFormat: "json",
  objectStreams: false,
};
const OPTIMIZED: WriteInkOptions & { objectStreams: boolean } = { objectStreams: true };

async function build(pages: Stroke[][], opts: WriteInkOptions & { objectStreams: boolean }) {
  const doc = await PDFDocument.create();
  pages.forEach(() => doc.addPage([595.28, 841.89]));
  const t0 = performance.now();
  writeInk(doc, new Map(pages.map((s, i) => [i, s])), opts);
  const bytes = await doc.save({ useObjectStreams: opts.objectStreams });
  return { bytes, ms: performance.now() - t0 };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

describe.skipIf(!OUT)("筆跡容量測試", () => {
  it("量測各種筆記密度", async () => {
    mkdirSync(OUT!, { recursive: true });
    const blank = (await build([[]], OPTIMIZED)).bytes.length;
    const rows: string[] = [];
    const json: Record<string, unknown> = { blankPdfBytes: blank, pages: {} };

    for (const [name, spec] of Object.entries(PAGES)) {
      const strokes = handwrittenPage(name.length * 7919 + spec.chars, spec);
      const points = strokes.reduce((s, x) => s + x.points.length, 0);
      const naive = await build([strokes], NAIVE);
      const opt = await build([strokes], OPTIMIZED);
      const noData = await build([strokes], { ...OPTIMIZED, includeData: false });

      // 讀回驗證 + 量測讀取時間
      const t0 = performance.now();
      const doc = await PDFDocument.load(opt.bytes);
      const back = readInk(doc).get(0)!;
      const readMs = performance.now() - t0;
      expect(back).toHaveLength(strokes.length);
      const keptPoints = back.reduce((s, x) => s + x.points.length, 0);

      const inkBytes = opt.bytes.length - blank;
      const apBytes = noData.bytes.length - blank;
      rows.push(
        `| ${name} | ${strokes.length} | ${points} | ${keptPoints} (${Math.round((keptPoints / points) * 100)}%) | ${kb(naive.bytes.length - blank)} | **${kb(inkBytes)}** | ${kb(apBytes)} | ${kb(inkBytes - apBytes)} | ${Math.round((1 - inkBytes / (naive.bytes.length - blank)) * 100)}% | ${opt.ms.toFixed(0)} ms | ${readMs.toFixed(0)} ms |`,
      );
      (json.pages as Record<string, unknown>)[name] = {
        strokes: strokes.length, points, keptPoints,
        naiveBytes: naive.bytes.length - blank, optimizedBytes: inkBytes, appearanceBytes: apBytes,
        rawEncodedBytes: encodeStrokes(back).length, writeMs: opt.ms, readMs,
      };
      writeFileSync(join(OUT!, `${name}.pdf`), opt.bytes);
    }

    // 30 頁筆記本：零星、半頁、整頁各 10 頁
    const book: Stroke[][] = [];
    for (let i = 0; i < 30; i++) {
      const spec = [PAGES.零星註記, PAGES.半頁筆記, PAGES.整頁筆記][i % 3];
      book.push(handwrittenPage(1000 + i, spec));
    }
    const bookOpt = await build(book, OPTIMIZED);
    const t0 = performance.now();
    const bookBack = readInk(await PDFDocument.load(bookOpt.bytes));
    const bookRead = performance.now() - t0;
    expect(bookBack.size).toBe(30);
    writeFileSync(join(OUT!, "30頁筆記本.pdf"), bookOpt.bytes);
    json.notebook30 = { bytes: bookOpt.bytes.length, writeMs: bookOpt.ms, readMs: bookRead };

    const table = [
      "| 頁面 | 筆畫 | 取樣點 | 精簡後的點 | 一般寫法 | 優化寫法 | 外觀＋InkList | 可編輯原始資料 | 縮小 | 寫入 | 讀回 |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...rows,
    ].join("\n");
    const summary = `${table}\n\n30 頁筆記本（零星、半頁、整頁各 10 頁）：${mb(bookOpt.bytes.length)}，寫入 ${bookOpt.ms.toFixed(0)} ms，讀回 ${bookRead.toFixed(0)} ms`;
    writeFileSync(join(OUT!, "results.md"), summary + "\n");
    writeFileSync(join(OUT!, "results.json"), JSON.stringify(json, null, 2));
    console.log("\n" + summary);
  }, 120_000);
});
