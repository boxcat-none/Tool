import { encodeStroke, normalizeStroke } from "@tool/core/ink";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { handwrittenPage } from "../../core/bench/handwriting";
import { Notebook } from "../src";

describe("同步資料大小", () => {
  it("整頁中文筆記：Yjs 額外負擔小，每畫一筆只需傳幾十到幾百 bytes", () => {
    const strokes = handwrittenPage(42, { chars: 200, highlights: 4 });
    const nb = Notebook.create("容量");
    const [page] = nb.insertPages(0, [{ source: { kind: "pdf", fileId: "f", index: 0 }, width: 595.28, height: 841.89 }]);

    const updates: number[] = [];
    nb.doc.on("update", (u: Uint8Array) => updates.push(u.length));
    const t0 = performance.now();
    for (const s of strokes) nb.addStroke(page, s);
    const addMs = performance.now() - t0;

    const unsimplified = strokes.reduce((sum, s) => sum + encodeStroke(s).length, 0);
    const raw = strokes.reduce((sum, s) => sum + encodeStroke(normalizeStroke(s)).length, 0);
    const full = Y.encodeStateAsUpdate(nb.doc).length;
    const t1 = performance.now();
    const decoded = nb.strokes(page);
    const readMs = performance.now() - t1;

    const sorted = [...updates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `筆畫 ${strokes.length}｜未精簡 ${(unsimplified / 1024).toFixed(1)} KB｜精簡後 ${(raw / 1024).toFixed(1)} KB｜Yjs 文件 ${(full / 1024).toFixed(1)} KB` +
        `（額外 ${(((full - raw) / raw) * 100).toFixed(1)}%）｜每筆同步訊息中位數 ${median} bytes、最大 ${sorted.at(-1)} bytes` +
        `｜新增 ${addMs.toFixed(0)} ms｜讀取解碼 ${readMs.toFixed(0)} ms`,
    );

    expect(decoded).toHaveLength(strokes.length);
    // 整頁筆記的同步文件 < 120 KB；每畫一筆的同步訊息中位數 < 100 bytes
    expect(full).toBeLessThan(120 * 1024);
    expect(median).toBeLessThan(100);
  });
});
