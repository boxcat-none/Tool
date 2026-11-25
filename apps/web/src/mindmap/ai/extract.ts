import { docxToMarkdown, pptxToMarkdown } from "@tool/mindmap";
import { strFromU8, unzipSync } from "fflate";
import { openPdf } from "../../lib/pdfjs";

/**
 * 把使用者給的檔案轉成要交給模型的文字（或圖片）。
 * 有結構的文件（Word 標題、PowerPoint 投影片、HTML 標題）轉成 Markdown，保留層級，模型比較容易整理。
 */

export interface Extracted {
  name: string;
  text: string;
  /** 圖片的 data URL（模型看得懂圖片時） */
  images: string[];
}

export const AI_FILE_ACCEPT = ".pdf,.docx,.pptx,.html,.htm,.txt,.md,.markdown,.csv,.guganote,.ppt,.doc,image/png,image/jpeg,image/webp,image/gif";

const MAX_PDF_PAGES = 300;

export async function extractFile(file: File, vision: boolean): Promise<Extracted> {
  const name = file.name;
  const ext = /\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? "";
  const base = { name, images: [] as string[] };
  if (file.type.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    if (!vision) throw new Error("目前設定的模型看不懂圖片。若你的模型支援圖片（多模態），請在「AI 模型設定」勾選「模型看得懂圖片」。");
    return { ...base, text: "", images: [await imageDataUrl(file)] };
  }
  if (ext === ".ppt" || ext === ".doc") throw new Error(`舊版 Office 檔（${ext}）讀不到內容，請先另存成 ${ext}x 再試`);
  if (ext === ".pdf") return { ...base, text: await pdfText(new Uint8Array(await file.arrayBuffer())) };
  if (ext === ".docx" || ext === ".pptx" || ext === ".guganote") {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw new Error(`「${name}」打不開（檔案損毀，或不是 ${ext} 檔）`);
    }
    if (ext === ".docx") {
      const doc = entries["word/document.xml"];
      if (!doc) throw new Error(`「${name}」裡找不到文件內容`);
      return { ...base, text: docxToMarkdown(strFromU8(doc)) };
    }
    if (ext === ".pptx") {
      const slides = Object.keys(entries)
        .map((k) => [k, /^ppt\/slides\/slide(\d+)\.xml$/.exec(k)?.[1]] as const)
        .filter((x): x is readonly [string, string] => !!x[1])
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map(([k]) => strFromU8(entries[k]));
      if (!slides.length) throw new Error(`「${name}」裡沒有投影片`);
      return { ...base, text: pptxToMarkdown(slides) };
    }
    // 筆記本：取裡面 PDF 的文字（手寫筆跡沒有文字）
    const pdfs = Object.entries(entries).filter(([k, v]) => k.startsWith("files/") && strFromU8(v.subarray(0, 5)) === "%PDF-");
    if (!pdfs.length) throw new Error("這本筆記本裡沒有 PDF，讀不到文字（手寫筆跡目前無法轉成文字）");
    const texts: string[] = [];
    for (const [, v] of pdfs) texts.push(await pdfText(v));
    return { ...base, text: texts.join("\n\n") };
  }
  const raw = await file.text();
  if (ext === ".html" || ext === ".htm" || /^\s*<(!doctype html|html)/i.test(raw)) return { ...base, text: htmlToMarkdown(raw) };
  return { ...base, text: raw };
}

/** PDF 每頁的文字（依閱讀順序，保留換行） */
async function pdfText(bytes: Uint8Array): Promise<string> {
  let opened: Awaited<ReturnType<typeof openPdf>>;
  try {
    opened = await openPdf(bytes);
  } catch (e) {
    throw new Error(/password/i.test(String(e)) ? "這個 PDF 有密碼，請先解除密碼再試" : "PDF 打不開（檔案損毀？）");
  }
  try {
    const pages: string[] = [];
    const n = Math.min(opened.doc.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await opened.doc.getPage(i);
      const content = await page.getTextContent();
      let t = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        t += item.str;
        if (item.hasEOL) t += "\n";
      }
      pages.push(t.replace(/[ \t]+\n/g, "\n").trim());
      page.cleanup();
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (!text.trim()) throw new Error("這個 PDF 沒有文字（可能是掃描的圖片）。若模型看得懂圖片，可以截圖後用圖片產生。");
    return text;
  } finally {
    void opened.task.destroy();
  }
}

/** HTML → Markdown：標題變 #、清單變 -（依巢狀縮排），其他段落照抄；不要選單、程式碼 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,svg,nav,footer,iframe").forEach((e) => e.remove());
  const lines: string[] = [];
  const text = (e: Element) => (e.textContent ?? "").replace(/\s+/g, " ").trim();
  const walk = (e: Element, listDepth: number) => {
    for (const c of Array.from(e.children)) {
      const tag = c.tagName.toLowerCase();
      const h = /^h([1-6])$/.exec(tag);
      if (h) {
        const t = text(c);
        if (t) lines.push(`${"#".repeat(Number(h[1]))} ${t}`);
      } else if (tag === "ul" || tag === "ol") {
        walk(c, listDepth + 1);
      } else if (tag === "li") {
        // 項目本身的文字（不含裡面的子清單）
        const clone = c.cloneNode(true) as Element;
        clone.querySelectorAll("ul,ol").forEach((x) => x.remove());
        const t = text(clone);
        if (t) lines.push(`${"  ".repeat(Math.max(0, listDepth - 1))}- ${t}`);
        for (const sub of Array.from(c.children)) if (/^(ul|ol)$/i.test(sub.tagName)) walk(sub, listDepth + 1);
      } else if (/^(p|blockquote|pre|td|th|dt|dd|figcaption)$/.test(tag)) {
        const t = text(c);
        if (t) lines.push(t);
      } else {
        walk(c, listDepth);
      }
    }
  };
  walk(doc.body, 0);
  const title = doc.title.trim();
  if (title && !lines.some((l) => l.startsWith("# "))) lines.unshift(`# ${title}`);
  return lines.join("\n");
}

/** 圖片轉 data URL；太大的縮到長邊 1600 px（送給模型比較快） */
async function imageDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.9);
}
