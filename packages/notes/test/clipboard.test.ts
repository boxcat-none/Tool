import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Notebook, transformImage, transformPoint, transformStroke, translation, type ContentTransform } from "../src";
import type { Stroke } from "@tool/core/ink/core";

const A4 = { width: 595.28, height: 841.89 };
const blank = { source: { kind: "template" as const, template: "blank" as const }, ...A4 };
const sync = (a: Notebook, b: Notebook) => {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
};
const line = (x: number, y: number, color = "#1f2937"): Stroke => ({
  tool: "pen",
  color,
  size: 2,
  points: [[x, y, 0.5], [x + 10, y, 0.5], [x + 20, y, 0.5]],
});
const t = (patch: Partial<ContentTransform>): ContentTransform => ({ cx: 0, cy: 0, scale: 1, angle: 0, dx: 0, dy: 0, ...patch });

function setup() {
  const nb = Notebook.create("剪貼");
  const [p1, p2] = nb.insertPages(0, [blank, blank]);
  nb.addFile({ id: "img1", name: "a.png", mime: "image/png", size: 10 });
  nb.addFile({ id: "img2", name: "b.png", mime: "image/png", size: 10 });
  return { nb, p1, p2 };
}

describe("變換數學", () => {
  it("順時針 90 度：右 → 下（y 向上的座標）", () => {
    const [x, y] = transformPoint(t({ angle: 90 }), 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-1);
    // 剛好 90 度時座標是精確的
    expect(transformPoint(t({ cx: 100, cy: 100, angle: 90 }), 110, 100)).toEqual([100, 90]);
  });

  it("縮放以中心為錨點，再平移", () => {
    expect(transformPoint(t({ cx: 10, cy: 10, scale: 2, dx: 5, dy: -5 }), 20, 10)).toEqual([35, 5]);
  });

  it("筆畫：點跟著變換、粗細跟著縮放、筆壓不變", () => {
    const s = transformStroke(line(0, 0), t({ scale: 3 }));
    expect(s.size).toBe(6);
    expect(s.points.at(-1)).toEqual([60, 0, 0.5]);
  });

  it("圖片轉 90 度：中心不動、寬高對調、rotation 累加", () => {
    const r = transformImage({ x: 0, y: 0, width: 40, height: 20, rotation: 270 }, t({ cx: 20, cy: 10, angle: 90 }));
    expect(r).toEqual({ x: 10, y: -10, width: 20, height: 40, rotation: 0 });
    expect(transformImage({ x: 0, y: 0, width: 40, height: 20, rotation: 0 }, t({ angle: -90 })).rotation).toBe(270);
  });

  it("圖片不能轉非 90 度的倍數", () => {
    expect(() => transformImage({ x: 0, y: 0, width: 1, height: 1, rotation: 0 }, t({ angle: 30 }))).toThrow();
  });
});

describe("圖片上下順序", () => {
  const order = (nb: Notebook, page: string, names: Map<string, string>) => nb.images(page).map((i) => names.get(i.id));

  function four() {
    const { nb, p1 } = setup();
    const names = new Map<string, string>();
    for (const n of ["A", "B", "C", "D"]) names.set(nb.addImage(p1, { fileId: "img1", x: 0, y: 0, width: 10, height: 10 }), n);
    const id = (n: string) => [...names].find(([, v]) => v === n)![0];
    return { nb, p1, names, id };
  }

  it("置頂、置底、上移、下移", () => {
    const { nb, p1, names, id } = four();
    nb.reorderImages([id("A")], "front");
    expect(order(nb, p1, names)).toEqual(["B", "C", "D", "A"]);
    nb.reorderImages([id("A")], "back");
    expect(order(nb, p1, names)).toEqual(["A", "B", "C", "D"]);
    nb.reorderImages([id("B")], "forward");
    expect(order(nb, p1, names)).toEqual(["A", "C", "B", "D"]);
    nb.reorderImages([id("B")], "backward");
    expect(order(nb, p1, names)).toEqual(["A", "B", "C", "D"]);
    // 已經在最上層：不變也不產生修改
    let updates = 0;
    nb.doc.on("update", () => updates++);
    nb.reorderImages([id("D")], "forward");
    expect(updates).toBe(0);
  });

  it("多張一起移動時保持相對順序", () => {
    const { nb, p1, names, id } = four();
    nb.reorderImages([id("A"), id("C")], "front");
    expect(order(nb, p1, names)).toEqual(["B", "D", "A", "C"]);
    nb.reorderImages([id("A"), id("C")], "back");
    expect(order(nb, p1, names)).toEqual(["A", "C", "B", "D"]);
    nb.reorderImages([id("A"), id("C")], "forward");
    expect(order(nb, p1, names)).toEqual(["B", "A", "C", "D"]); // 各自越過一張沒選到的圖
  });

  it("z 重複（兩台裝置同時調整）時整頁重新編號", () => {
    const { nb, p1, names, id } = four();
    const map = nb.doc.getMap<Y.Map<unknown>>("images");
    const z = map.get(id("A"))!.get("z");
    map.get(id("B"))!.set("z", z);
    map.get(id("C"))!.set("z", z);
    const before = order(nb, p1, names);
    nb.reorderImages([id("D")], "backward");
    const after = order(nb, p1, names);
    expect(after.indexOf("D")).toBe(before.indexOf("D") - 1);
    const keys = nb.images(p1).map((i) => map.get(i.id)!.get("z") as string);
    expect(new Set(keys).size).toBe(4);
  });

  it("兩台裝置的調整會同步", () => {
    const { nb, p1, names, id } = four();
    const other = new Notebook();
    sync(nb, other);
    other.reorderImages([id("A")], "front");
    sync(nb, other);
    expect(order(nb, p1, names)).toEqual(["B", "C", "D", "A"]);
  });
});

describe("複製貼上", () => {
  it("複製依疊放順序，帶圖片檔資訊；貼到另一本筆記本", () => {
    const { nb, p1 } = setup();
    const s1 = nb.addStroke(p1, line(10, 10, "#dc2626"));
    nb.addStroke(p1, line(10, 50));
    const s3 = nb.addStroke(p1, line(10, 90, "#1e40af"));
    const i1 = nb.addImage(p1, { fileId: "img1", x: 100, y: 100, width: 40, height: 20 });
    const i2 = nb.addImage(p1, { fileId: "img2", x: 200, y: 100, width: 40, height: 20, rotation: 90 });
    const clip = nb.copyContent(p1, [s3, s1], [i2, i1]);
    expect(clip.strokes.map((s) => s.color)).toEqual(["#dc2626", "#1e40af"]);
    expect(clip.images.map((i) => i.fileId)).toEqual(["img1", "img2"]);
    expect(clip.images[1].rotation).toBe(90);
    expect(clip.files.map((f) => f.id).sort()).toEqual(["img1", "img2"]);

    const target = Notebook.create("另一本");
    const [page] = target.insertPages(0, [blank]);
    const pasted = target.pasteContent(page, clip, translation(12, -12));
    expect(pasted.strokes).toHaveLength(2);
    expect(target.strokes(page).map((s) => s.stroke.points[0].slice(0, 2))).toEqual([[22, -2], [22, 78]]);
    expect(target.images(page).map((i) => [i.fileId, i.x, i.y, i.rotation])).toEqual([
      ["img1", 112, 88, 0],
      ["img2", 212, 88, 90],
    ]);
    expect(target.getFile("img2")?.name).toBe("b.png");
    expect(target.usedFileIds.sort()).toEqual(["img1", "img2"]);
  });

  it("貼上的內容在最上層，代號是新的，一次復原", () => {
    const { nb, p1 } = setup();
    const s1 = nb.addStroke(p1, line(0, 0));
    const i1 = nb.addImage(p1, { fileId: "img1", x: 0, y: 0, width: 10, height: 10 });
    const below = nb.addImage(p1, { fileId: "img2", x: 0, y: 0, width: 10, height: 10 });
    const undo = nb.createUndoManager("me");
    const clip = nb.copyContent(p1, [s1], [i1]);
    let out!: { strokes: string[]; images: string[] };
    nb.doc.transact(() => (out = nb.pasteContent(p1, clip)), "me");
    expect(out.strokes[0]).not.toBe(s1);
    expect(nb.images(p1).map((i) => i.id)).toEqual([i1, below, out.images[0]]);
    expect(nb.strokeCount(p1)).toBe(2);
    undo.undo();
    expect(nb.strokeCount(p1)).toBe(1);
    expect(nb.images(p1)).toHaveLength(2);
  });

  it("貼到不存在的頁面會拋錯", () => {
    const { nb, p1 } = setup();
    expect(() => nb.pasteContent("nope", nb.copyContent(p1, [], []))).toThrow();
  });
});

describe("套索變換", () => {
  it("縮放、旋轉筆畫與圖片，保留筆畫代號與順序，一次復原", () => {
    const { nb, p1, p2 } = setup();
    const a = nb.addStroke(p1, line(0, 0));
    const b = nb.addStroke(p1, line(0, 40));
    const img = nb.addImage(p1, { fileId: "img1", x: 0, y: 0, width: 40, height: 20 });
    const elsewhere = nb.addImage(p2, { fileId: "img1", x: 0, y: 0, width: 40, height: 20 });
    const undo = nb.createUndoManager("me");
    nb.doc.transact(() => nb.transformContent(p1, [a], [img, elsewhere], t({ cx: 20, cy: 10, scale: 2, angle: 90 })), "me");
    const strokes = nb.strokes(p1);
    expect(strokes.map((s) => s.id)).toEqual([a, b]);
    expect(strokes[0].stroke.size).toBe(4);
    // (0,0) → 繞 (20,10) 順時針 90 度再放大兩倍
    expect(strokes[0].stroke.points[0].slice(0, 2)).toEqual([0, 50]);
    expect(strokes[1].stroke.points[0].slice(0, 2)).toEqual([0, 40]); // 沒選到的不變
    expect(nb.getImage(img)).toMatchObject({ x: 0, y: -30, width: 40, height: 80, rotation: 90 });
    expect(nb.getImage(elsewhere)).toMatchObject({ x: 0, rotation: 0 }); // 別頁的圖片不受影響
    undo.undo();
    expect(nb.strokes(p1)[0].stroke.points[0].slice(0, 2)).toEqual([0, 0]);
    expect(nb.getImage(img)).toMatchObject({ x: 0, y: 0, width: 40, height: 20, rotation: 0 });
  });

  it("自由角度只轉筆畫；同步到另一台裝置", () => {
    const { nb, p1 } = setup();
    const a = nb.addStroke(p1, line(0, 0));
    const other = new Notebook();
    sync(nb, other);
    other.transformContent(p1, [a], [], t({ angle: 45 }));
    sync(nb, other);
    const [x, y] = nb.strokes(p1)[0].stroke.points.at(-1)!;
    expect(x).toBeCloseTo(14.14, 1);
    expect(y).toBeCloseTo(-14.14, 1);
  });
});
