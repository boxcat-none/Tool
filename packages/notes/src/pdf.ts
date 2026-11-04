import { loadPdf } from "@tool/core";
import { flattenInk, writeInk, type Stroke } from "@tool/core/ink";
import { normalizeRotation } from "@tool/core/rotation";
import { degrees, PDFDocument, type PDFPage } from "pdf-lib";
import type { BlobStore } from "./blobs";
import type { Notebook } from "./notebook";
import { readOutline, writeOutline, type OutlineItem } from "./outline";
import { PaperPainter } from "./paper";


/**
 * 匯入 PDF：原始檔存進檔案庫，在第 `at` 個位置插入它的所有頁面。
 * 回傳新頁面的代號。
 */
export async function importPdf(
  nb: Notebook,
  blobs: BlobStore,
  bytes: Uint8Array,
  name: string,
  at = nb.pageIds.length,
): Promise<string[]> {
  const doc = await loadPdf(bytes, name); // 加密、損毀會在這裡回報清楚的錯誤
  const fileId = await blobs.put(bytes);
  nb.addFile({ id: fileId, name, mime: "application/pdf", size: bytes.length, pageCount: doc.getPageCount() });
  const pages = doc.getPages().map((p, index) => {
    const { width, height } = p.getSize();
    return {
      source: { kind: "pdf" as const, fileId, index },
      width,
      height,
      rotation: normalizeRotation(p.getRotation().angle),
    };
  });
  return nb.insertPages(at, pages);
}

export interface ExportOptions {
  /**
   * 筆跡怎麼匯出：
   * - flatten：畫進頁面內容（預設）。任何軟體都一樣，檔案最小，但別人無法單獨刪除筆跡
   * - annotations：存成標準手繪註解。Acrobat 等軟體可以選取、隱藏或刪除筆跡
   * - none：不含筆跡（例如只要整理過的頁面）
   */
  ink?: "flatten" | "annotations" | "none";
  /** 只匯出這些頁面（預設全部，依筆記本順序） */
  pageIds?: string[];
  /** 是否保留原始 PDF 的目錄（書籤），目標頁對應到新頁碼。預設 true */
  outline?: boolean;
}

/** 把筆記本匯出成 PDF */
export async function exportPdf(nb: Notebook, blobs: BlobStore, options: ExportOptions = {}): Promise<Uint8Array> {
  const { ink = "flatten", outline = true } = options;
  const ids = options.pageIds ?? nb.pageIds;
  const out = await PDFDocument.create();
  const painter = new PaperPainter(out);

  // 同一個原始檔的頁面一次複製：字型等共用資源只會複製一份
  const copies = new Map<string, Map<number, PDFPage[]>>();
  const wanted = new Map<string, number[]>();
  for (const id of ids) {
    const page = nb.getPage(id);
    if (page?.source.kind === "pdf") {
      const list = wanted.get(page.source.fileId) ?? [];
      list.push(page.source.index);
      wanted.set(page.source.fileId, list);
    }
  }
  // 各原始檔的目錄，目標頁先換成「全域編號」：該檔的起始編號 + 頁面索引
  const outlines: OutlineItem[] = [];
  const targetRef = new Map<number, PDFPage>();
  let base = 0;
  for (const [fileId, indices] of wanted) {
    const bytes = await blobs.get(fileId);
    if (!bytes) throw new Error(`找不到原始檔案「${nb.getFile(fileId)?.name ?? fileId}」。`);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = await out.copyPages(src, indices);
    const byIndex = new Map<number, PDFPage[]>();
    indices.forEach((index, i) => {
      byIndex.set(index, [...(byIndex.get(index) ?? []), pages[i]]);
      // 同一頁出現多次時，目錄指向第一次出現的位置
      if (!targetRef.has(base + index)) targetRef.set(base + index, pages[i]);
    });
    copies.set(fileId, byIndex);
    if (outline) {
      try {
        outlines.push(...offsetTargets(readOutline(src), base));
      } catch {
        // 目錄壞掉不影響匯出
      }
    }
    base += src.getPageCount();
  }

  const inkByPage = new Map<number, Stroke[]>();
  ids.forEach((id, i) => {
    const info = nb.getPage(id);
    if (!info) return;
    let page: PDFPage;
    if (info.source.kind === "pdf") {
      // 同一頁出現多次時，每次用不同的複本
      page = copies.get(info.source.fileId)!.get(info.source.index)!.shift()!;
      out.addPage(page);
    } else {
      page = out.addPage([info.width, info.height]);
      painter.paint(page, info.source.template, info.width, info.height);
    }
    page.setRotation(degrees(info.rotation));
    if (ink !== "none") {
      const strokes = nb.strokes(id).map((s) => s.stroke);
      if (strokes.length) inkByPage.set(i, strokes);
    }
  });

  // 目錄：只保留目標頁還在的項目（頁面要先加入文件，參照才有效）
  const added = new Set(out.getPages());
  if (outlines.length) {
    writeOutline(out, outlines, (t) => {
      const p = targetRef.get(t);
      return p && added.has(p) ? p.ref : undefined;
    });
  }

  if (ink === "flatten") flattenInk(out, inkByPage);
  else if (ink === "annotations") writeInk(out, inkByPage);

  out.setTitle(nb.title);
  out.setProducer("PDF 工具箱");
  out.setCreator("PDF 工具箱");
  return out.save();
}

function offsetTargets(items: OutlineItem[], base: number): OutlineItem[] {
  return items.map((it) => ({
    ...it,
    target: it.target === null ? null : it.target + base,
    children: offsetTargets(it.children, base),
  }));
}
