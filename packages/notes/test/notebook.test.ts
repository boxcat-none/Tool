import type { Stroke } from "@tool/core/ink";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MemoryBlobStore, Notebook } from "../src";

const A4 = { width: 595.28, height: 841.89 };
const pdfPage = (index: number) => ({ source: { kind: "pdf" as const, fileId: "f1", index }, ...A4 });
const lined = { source: { kind: "template" as const, template: "lined" as const }, ...A4 };

function stroke(x: number, color = "#1e3a8a"): Stroke {
  return { tool: "pen", color, size: 1.6, points: [[x, 100, 0.5], [x + 10, 110, 0.6], [x + 20, 105, 0.4]] };
}

/** 模擬兩台裝置互相同步（交換彼此缺少的更新） */
function sync(a: Notebook, b: Notebook) {
  const ua = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const ub = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  Y.applyUpdate(b.doc, ua);
  Y.applyUpdate(a.doc, ub);
}

/** 從同一份筆記本複製出第二台裝置 */
function clone(nb: Notebook): Notebook {
  const other = new Notebook();
  Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(nb.doc));
  return other;
}

const sources = (nb: Notebook) =>
  nb.pageList.map((p) => (p.source.kind === "pdf" ? `pdf${p.source.index}` : p.source.template));

describe("頁面", () => {
  it("插入、移動、刪除頁面", () => {
    const nb = Notebook.create("課本筆記");
    nb.insertPages(0, [pdfPage(0), pdfPage(1), pdfPage(2)]);
    nb.insertPages(1, [lined]); // 插在第 1 頁後面
    expect(sources(nb)).toEqual(["pdf0", "lined", "pdf1", "pdf2"]);

    const [, linedId, , last] = nb.pageIds;
    nb.movePage(last, 0);
    expect(sources(nb)).toEqual(["pdf2", "pdf0", "lined", "pdf1"]);

    nb.addStroke(linedId, stroke(10));
    nb.deletePages([linedId]);
    expect(sources(nb)).toEqual(["pdf2", "pdf0", "pdf1"]);
    expect(nb.strokes(linedId)).toEqual([]);
  });

  it("在同一個位置連續插入多頁，順序正確", () => {
    const nb = Notebook.create("x");
    nb.insertPages(0, [pdfPage(0), pdfPage(1)]);
    nb.insertPages(1, [{ ...lined }, { source: { kind: "template", template: "grid" }, ...A4 }]);
    expect(sources(nb)).toEqual(["pdf0", "lined", "grid", "pdf1"]);
  });
});

describe("筆跡", () => {
  it("新增、取代、刪除筆畫，並保留疊放順序", () => {
    const nb = Notebook.create("x");
    const [page] = nb.insertPages(0, [pdfPage(0)]);
    const a = nb.addStroke(page, stroke(0));
    const b = nb.addStroke(page, stroke(50, "#b91c1c"));
    const c = nb.addStroke(page, stroke(100));

    nb.replaceStroke(page, b, stroke(60, "#15803d"));
    expect(nb.strokes(page).map((s) => [s.id, s.stroke.color])).toEqual([
      [a, "#1e3a8a"], [b, "#15803d"], [c, "#1e3a8a"],
    ]);
    expect(nb.strokes(page)[1].stroke.points[0][0]).toBe(60);

    nb.removeStrokes(page, [a, c]);
    expect(nb.strokes(page).map((s) => s.id)).toEqual([b]);
  });

  it("在不存在的頁面畫線會報錯", () => {
    const nb = Notebook.create("x");
    expect(() => nb.addStroke("nope", stroke(0))).toThrow("頁面不存在");
  });
});

describe("多裝置同時編輯", () => {
  it("兩台裝置離線各自修改，連線後兩邊的內容都保留且一致", () => {
    const ipad = Notebook.create("協作");
    const [p1] = ipad.insertPages(0, [pdfPage(0), pdfPage(1)]);
    const pc = clone(ipad);

    ipad.addStroke(p1, stroke(10));                  // iPad 在第 1 頁畫線
    const [inserted] = pc.insertPages(1, [lined]);   // 電腦插入格線頁
    pc.addStroke(inserted, stroke(20, "#b91c1c"));   // 並在上面寫字
    pc.addStroke(p1, stroke(30, "#15803d"));         // 也在第 1 頁畫線

    sync(ipad, pc);
    for (const nb of [ipad, pc]) {
      expect(sources(nb)).toEqual(["pdf0", "lined", "pdf1"]);
      expect(nb.strokeCount(p1)).toBe(2);
      expect(nb.strokes(inserted)[0].stroke.color).toBe("#b91c1c");
    }
    expect(ipad.strokes(p1).map((s) => s.id)).toEqual(pc.strokes(p1).map((s) => s.id));
  });

  it("兩台裝置同時移動同一頁：不會出現兩份，結果一致", () => {
    const a = Notebook.create("x");
    a.insertPages(0, [pdfPage(0), pdfPage(1), pdfPage(2), pdfPage(3)]);
    const b = clone(a);
    const target = a.pageIds[3];
    a.movePage(target, 0);
    b.movePage(target, 2);
    sync(a, b);
    expect(a.pageIds).toHaveLength(4);
    expect(new Set(a.pageIds).size).toBe(4);
    expect(a.pageIds).toEqual(b.pageIds);
  });

  it("兩台裝置同時在同一個位置插頁：兩頁都保留，順序一致", () => {
    const a = Notebook.create("x");
    a.insertPages(0, [pdfPage(0), pdfPage(1)]);
    const b = clone(a);
    a.insertPages(1, [lined]);
    b.insertPages(1, [{ source: { kind: "template", template: "dot" }, ...A4 }]);
    sync(a, b);
    expect(sources(a)).toHaveLength(4);
    expect(sources(a).slice(1, 3).sort()).toEqual(["dot", "lined"]);
    expect(a.pageIds).toEqual(b.pageIds);
  });

  it("一台刪除頁面、另一台同時在該頁畫線：頁面刪除，不會出錯", () => {
    const a = Notebook.create("x");
    const [p] = a.insertPages(0, [pdfPage(0)]);
    const b = clone(a);
    a.deletePages([p]);
    b.addStroke(p, stroke(0));
    sync(a, b);
    expect(a.pageIds).toEqual([]);
    expect(b.pageIds).toEqual([]);
  });

  it("復原只會復原自己的動作", () => {
    const pc = Notebook.create("x");
    const [p] = pc.insertPages(0, [pdfPage(0)]);
    const ipad = clone(pc);
    const LOCAL = "pc-local";
    const undo = pc.createUndoManager(LOCAL);

    pc.doc.transact(() => pc.addStroke(p, stroke(10)), LOCAL);
    ipad.addStroke(p, stroke(50, "#b91c1c"));
    sync(pc, ipad);
    expect(pc.strokeCount(p)).toBe(2);

    undo.undo();
    expect(pc.strokes(p).map((s) => s.stroke.color)).toEqual(["#b91c1c"]);
    undo.redo();
    expect(pc.strokeCount(p)).toBe(2);
  });

  it("變動通知會區分本機與同步來的修改", () => {
    const a = Notebook.create("x");
    const [p] = a.insertPages(0, [pdfPage(0)]);
    const b = clone(a);
    const events: boolean[] = [];
    const off = a.onChange((e) => events.push(e.local));
    a.addStroke(p, stroke(0));
    b.addStroke(p, stroke(10));
    sync(a, b);
    off();
    expect(events).toEqual([true, false]);
  });
});

describe("檔案庫", () => {
  it("同樣內容只存一份，代號是 SHA-256", async () => {
    const store = new MemoryBlobStore();
    const bytes = new TextEncoder().encode("%PDF-1.7 test");
    const id1 = await store.put(bytes);
    const id2 = await store.put(bytes.slice());
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(id1)).toEqual(bytes);
  });
});

describe("代號與變動通知", () => {
  it("每本筆記本有固定代號，複製到其他裝置後相同", () => {
    const a = Notebook.create("x");
    expect(a.id).toMatch(/^[0-9a-z]{16}$/);
    expect(clone(a).id).toBe(a.id);
    expect(Notebook.create("y").id).not.toBe(a.id);
  });

  it("頁面結構與筆跡的變動分開通知，並指出是哪一頁", () => {
    const nb = Notebook.create("x");
    const [p1, p2] = nb.insertPages(0, [pdfPage(0), pdfPage(1)]);
    const pageEvents: number[] = [];
    const strokeEvents: string[][] = [];
    const off1 = nb.onPagesChange(() => pageEvents.push(1));
    const off2 = nb.onStrokesChange((ids) => strokeEvents.push([...ids]));

    nb.addStroke(p2, stroke(0));
    expect(strokeEvents).toEqual([[p2]]);
    expect(pageEvents).toEqual([]);

    nb.movePage(p2, 0);
    nb.insertPages(1, [lined]);
    expect(pageEvents.length).toBeGreaterThanOrEqual(2);

    nb.removeStrokes(p2, nb.strokes(p2).map((s) => s.id));
    expect(strokeEvents.at(-1)).toEqual([p2]);
    const count = strokeEvents.length;
    off1();
    off2();
    nb.addStroke(p1, stroke(0));
    expect(strokeEvents).toHaveLength(count); // 取消訂閱後不再通知
  });
});

describe("一次修改多筆（套索）", () => {
  it("移動、改顏色：保留疊放順序與代號，一次復原", () => {
    const nb = Notebook.create("套索");
    const [page] = nb.insertPages(0, [lined]);
    const undo = nb.createUndoManager("me");
    let ids: string[] = [];
    nb.doc.transact(() => (ids = [1, 2, 3].map((i) => nb.addStroke(page, stroke(i * 10)))), "me");
    nb.doc.transact(
      () => nb.updateStrokes(page, [ids[0], ids[2]], (s) => ({ ...s, color: "#dc2626", points: s.points.map(([x, y, p]) => [x + 100, y, p]) })),
      "me",
    );
    const after = nb.strokes(page);
    expect(after.map((s) => s.id)).toEqual(ids);
    expect(after.map((s) => s.stroke.color)).toEqual(["#dc2626", "#1e3a8a", "#dc2626"]);
    expect(after.map((s) => s.stroke.points[0][0])).toEqual([110, 20, 130]);
    undo.undo();
    expect(nb.strokes(page).map((s) => [s.id, s.stroke.points[0][0], s.stroke.color])).toEqual([
      [ids[0], 10, "#1e3a8a"],
      [ids[1], 20, "#1e3a8a"],
      [ids[2], 30, "#1e3a8a"],
    ]);
  });
});
