import { PDFDocument } from "pdf-lib";
import { it } from "vitest";
import { flattenInk, normalizeStroke, simplifyPoints, strokeOutline, type Stroke } from "../src/ink";
import { handwrittenPage } from "./handwriting";

it.skipIf(!process.env.PROFILE)("profile flatten", async () => {
  const pages: Stroke[][] = Array.from({ length: 30 }, (_, i) => handwrittenPage(1000 + i, { chars: 200, highlights: 3 }));
  const all = pages.flat();
  const t = (label: string, fn: () => void) => { const t0 = performance.now(); fn(); console.log(label, (performance.now() - t0).toFixed(0), "ms"); };
  let norm: Stroke[] = [];
  t(`normalize ${all.length}`, () => { norm = all.map((s) => normalizeStroke(s)); });
  let outlines: [number, number][][] = [];
  t("perfect-freehand outline", () => { outlines = norm.map((s) => strokeOutline(s)); });
  t("simplify outline", () => { outlines.forEach((o) => simplifyPoints(o.map(([x, y]) => [x, y, 0]), 0.08)); });
  t("format numbers", () => { let c = ""; for (const o of outlines) for (const [x, y] of o) c += `${(Math.round(x * 10) / 10).toFixed(1).replace(/\.?0+$/, "")} ${(Math.round(y * 10) / 10).toFixed(1).replace(/\.?0+$/, "")} l\n`; });
  const doc = await PDFDocument.create(); pages.forEach(() => doc.addPage([595.28, 841.89]));
  t("flattenInk total", () => flattenInk(doc, new Map(pages.map((s, i) => [i, s]))));
  const t0 = performance.now(); await doc.save(); console.log("save (flate)", (performance.now() - t0).toFixed(0), "ms");
}, 300_000);
