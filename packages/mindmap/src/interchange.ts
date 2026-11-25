import { MindMap, parseOutline, type Offset } from "./model";

/**
 * 和其他心智圖、大綱軟體交換資料（業界通用的格式）：
 *
 *   OPML（.opml）       大綱軟體與心智圖軟體（XMind、MindNode…）都支援的大綱格式：文字與層級
 *   FreeMind（.mm）     心智圖軟體之間最通用的格式（FreeMind、Freeplane、XMind、MindNode…）：
 *                       文字、層級、收合、分支顏色、任兩個元件之間的線（arrowlink）、獨立元件（Freeplane 的 FreeNode）
 *   Markdown（.md）     標題與清單：# 中心元件、## 第一層…，清單縮排再往下
 *   純文字（.txt）       每行一個元件，縮排表示層級
 *
 * 匯入時先轉成 ImportedMap（和程式無關的樹），再建立 MindMap，所以每種格式只要寫「讀」與「寫」。
 */

export interface OutlineNode {
  text: string;
  color?: string;
  collapsed?: boolean;
  /** 檔案裡的代號（FreeMind 的 ID），用來接手拉的線 */
  key?: string;
  children: OutlineNode[];
}

export interface ImportedMap {
  title: string;
  root: OutlineNode;
  /** 獨立元件（沒有連到中心元件） */
  floating: OutlineNode[];
  /** 手拉的線：[起點 key, 終點 key] */
  links: [string, string][];
}

// ── 從 MindMap 轉出 ─────────────────────────────────

interface ExportNode {
  id: string;
  text: string;
  color?: string;
  collapsed: boolean;
  children: ExportNode[];
}

function exportTree(map: MindMap, id: string): ExportNode {
  const n = map.node(id)!;
  return { id, text: n.text, color: n.color, collapsed: n.collapsed, children: map.children(id).map((c) => exportTree(map, c)) };
}

/** OPML 2.0。獨立元件是最上層的另一個 outline，標上 gugaFloating="true"（其他軟體會忽略這個屬性） */
export function toOPML(map: MindMap): string {
  const walk = (n: ExportNode, depth: number, floating = false): string => {
    const pad = "  ".repeat(depth);
    const attrs = `text="${xmlAttr(n.text)}"${floating ? ' gugaFloating="true"' : ""}`;
    if (!n.children.length) return `${pad}<outline ${attrs}/>`;
    return `${pad}<outline ${attrs}>\n${n.children.map((c) => walk(c, depth + 1)).join("\n")}\n${pad}</outline>`;
  };
  const tops = [walk(exportTree(map, map.rootId), 2), ...map.floatingIds().map((f) => walk(exportTree(map, f), 2, true))];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${xmlText(map.title)}</title></head>`,
    "  <body>",
    ...tops,
    "  </body>",
    "</opml>",
    "",
  ].join("\n");
}

/**
 * FreeMind（.mm，FreeMind 1.0 格式；Freeplane、XMind、MindNode 都能開）。
 * 分支顏色 = edge COLOR；收合 = FOLDED；手拉的線 = arrowlink；獨立元件 = 中心元件底下帶 FreeNode 標記的節點（Freeplane 的做法）。
 */
export function toFreeMind(map: MindMap): string {
  const ids = new Map<string, string>();
  const fid = (id: string) => {
    let v = ids.get(id);
    if (!v) ids.set(id, (v = `ID_${ids.size + 1}`));
    return v;
  };
  const linksFrom = new Map<string, string[]>();
  for (const l of map.links()) {
    const list = linksFrom.get(l.from) ?? [];
    list.push(l.to);
    linksFrom.set(l.from, list);
  }
  const walk = (n: ExportNode, depth: number, extra = "", after: string[] = []): string => {
    const pad = "  ".repeat(depth);
    const attrs = [`ID="${fid(n.id)}"`, `TEXT="${xmlAttr(n.text)}"`];
    if (n.collapsed && n.children.length) attrs.push('FOLDED="true"');
    const inner: string[] = [];
    if (extra) inner.push(`${pad}  ${extra}`);
    if (n.color) inner.push(`${pad}  <edge COLOR="${n.color}"/>`);
    for (const to of linksFrom.get(n.id) ?? []) inner.push(`${pad}  <arrowlink DESTINATION="${fid(to)}" ENDARROW="None" STARTARROW="None"/>`);
    for (const c of n.children) inner.push(walk(c, depth + 1));
    inner.push(...after);
    if (!inner.length) return `${pad}<node ${attrs.join(" ")}/>`;
    return `${pad}<node ${attrs.join(" ")}>\n${inner.join("\n")}\n${pad}</node>`;
  };
  // 先給所有元件代號，手拉的線才能指到後面的元件
  const all = [map.rootId, ...map.floatingIds()];
  const assign = (id: string) => {
    fid(id);
    map.children(id).forEach(assign);
  };
  all.forEach(assign);
  // 獨立元件放在中心元件底下的最後面，帶 FreeNode 標記
  const floats = map.floatingIds().map((f) => walk(exportTree(map, f), 2, '<hook NAME="FreeNode"/>'));
  return `<map version="1.0.1">\n${walk(exportTree(map, map.rootId), 1, "", floats)}\n</map>\n`;
}

// ── 讀入 ───────────────────────────────────────────

export function parseOPML(text: string, fallbackTitle: string): ImportedMap {
  let doc: XmlElement;
  try {
    doc = parseXml(text);
  } catch {
    throw new Error("讀不懂這個 OPML 檔");
  }
  if (doc.name.toLowerCase() !== "opml") throw new Error("這不是 OPML 檔");
  const head = child(doc, "head");
  const title = (head && child(head, "title")?.text.trim()) || fallbackTitle;
  const body = child(doc, "body");
  const conv = (e: XmlElement): OutlineNode => ({
    text: e.attrs.text ?? e.attrs.title ?? "",
    children: e.children.filter((c) => c.name === "outline").map(conv),
  });
  const tops = (body?.children ?? []).filter((c) => c.name === "outline");
  if (!tops.length) throw new Error("這個 OPML 檔是空的");
  const floating = tops.filter((t) => t.attrs.gugaFloating === "true");
  const main = tops.filter((t) => t.attrs.gugaFloating !== "true");
  // 只有一個最上層 = 中心元件；很多個（一般大綱軟體）= 以標題當中心元件，全部放在底下
  const root: OutlineNode = main.length === 1 ? conv(main[0]) : { text: title, children: main.map(conv) };
  return { title, root, floating: floating.map(conv), links: [] };
}

export function parseFreeMind(text: string, fallbackTitle: string): ImportedMap {
  let doc: XmlElement;
  try {
    doc = parseXml(text);
  } catch {
    throw new Error("讀不懂這個 FreeMind 檔");
  }
  if (doc.name !== "map") throw new Error("這不是 FreeMind 檔（.mm）");
  const top = child(doc, "node");
  if (!top) throw new Error("這個 FreeMind 檔是空的");
  const links: [string, string][] = [];
  const conv = (e: XmlElement): OutlineNode => {
    const rich = e.children.find((c) => c.name === "richcontent" && (c.attrs.TYPE ?? "NODE") === "NODE");
    const textOf = e.attrs.TEXT ?? (rich ? htmlText(rich) : "");
    const edge = child(e, "edge");
    const key = e.attrs.ID;
    for (const a of e.children) if (a.name === "arrowlink" && key && a.attrs.DESTINATION) links.push([key, a.attrs.DESTINATION]);
    const color = normalizeColor(edge?.attrs.COLOR);
    return {
      text: textOf,
      ...(key ? { key } : {}),
      ...(color ? { color } : {}),
      ...(e.attrs.FOLDED === "true" ? { collapsed: true } : {}),
      children: e.children.filter((c) => c.name === "node").map(conv),
    };
  };
  const isFree = (e: XmlElement) => e.children.some((c) => c.name === "hook" && c.attrs.NAME === "FreeNode");
  const rootEl = top;
  const root = conv({ ...rootEl, children: rootEl.children.filter((c) => !(c.name === "node" && isFree(c))) });
  const floating = rootEl.children.filter((c) => c.name === "node" && isFree(c)).map(conv);
  return { title: root.text.split("\n")[0] || fallbackTitle, root, floating, links };
}

/**
 * Markdown：第一個 # 標題 = 中心元件；## = 第一層、### = 第二層…；
 * 清單項目放在最近的標題底下，縮排再往下一層。之後再出現的 # 標題 = 獨立元件（和匯出的格式一樣）。
 * 沒有 # 標題時，以檔名當中心元件。
 */
export function parseMarkdown(text: string, fallbackTitle: string): ImportedMap {
  const lines = text.replace(/\r/g, "").split("\n");
  const tops: OutlineNode[] = [];
  // stack[i] = 第 i 層最後一個節點（第 0 層 = 目前的 # 標題）
  let stack: OutlineNode[] = [];
  let headingDepth = 0;
  let inFence = false;
  const listBuf: string[] = [];
  const flushList = () => {
    if (!listBuf.length) return;
    const items = parseOutline(listBuf.join("\n"));
    listBuf.length = 0;
    if (!stack.length) {
      const holder: OutlineNode = { text: fallbackTitle, children: [] };
      tops.push(holder);
      stack = [holder];
      headingDepth = 0;
    }
    const base = headingDepth + 1;
    for (const it of items) {
      const node: OutlineNode = { text: it.text, children: [] };
      const d = Math.min(base + it.level, stack.length);
      stack[d - 1].children.push(node);
      stack = [...stack.slice(0, d), node];
    }
  };
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      flushList();
      const level = h[1].length - 1;
      const node: OutlineNode = { text: stripInline(h[2]), children: [] };
      if (level === 0 || !stack.length) {
        tops.push(node);
        stack = [node];
        headingDepth = 0;
      } else {
        const d = Math.min(level, stack.length);
        stack[d - 1].children.push(node);
        stack = [...stack.slice(0, d), node];
        headingDepth = d;
      }
      continue;
    }
    if (/^\s*([-*+•]|\d+[.)])\s+/.test(raw)) listBuf.push(raw.replace(/^(\s*)([-*+•]|\d+[.)])\s+/, (_m, sp) => `${sp}- `).replace(/- (.*)$/, (_m, t) => `- ${stripInline(t)}`));
    else if (raw.trim() && listBuf.length && /^\s+/.test(raw)) continue; // 清單項目的續行：略過
    else flushList();
  }
  flushList();
  if (!tops.length) throw new Error("這個 Markdown 檔沒有標題或清單，讀不到內容");
  return { title: tops[0].text || fallbackTitle, root: tops[0], floating: tops.slice(1), links: [] };
}

/** 純文字：每行一個元件，縮排表示層級；只有一個最上層時它是中心元件，否則以檔名當中心元件 */
export function parsePlainText(text: string, fallbackTitle: string): ImportedMap {
  const items = parseOutline(text);
  if (!items.length) throw new Error("這個檔案是空的");
  const holder: OutlineNode = { text: fallbackTitle, children: [] };
  let stack: OutlineNode[] = [holder];
  for (const it of items) {
    const node: OutlineNode = { text: it.text, children: [] };
    const d = Math.min(it.level + 1, stack.length);
    stack[d - 1].children.push(node);
    stack = [...stack.slice(0, d), node];
  }
  const root = holder.children.length === 1 ? holder.children[0] : holder;
  return { title: root.text || fallbackTitle, root, floating: [], links: [] };
}

/** 從匯入的內容建立心智圖。獨立元件先排在右邊一列（打開後可以按「自動排列」整理） */
export function buildMindMap(data: ImportedMap): MindMap {
  const map = MindMap.create(data.title || data.root.text || "心智圖", data.root.text);
  const keys = new Map<string, string>();
  map.doc.transact(() => {
    const apply = (n: OutlineNode, id: string) => {
      if (n.key) keys.set(n.key, id);
      if (n.color) map.setColor(id, n.color);
      for (const c of n.children) apply(c, map.addChild(id, c.text));
      if (n.collapsed && n.children.length) map.setCollapsed(id, true);
    };
    apply(data.root, map.rootId);
    data.floating.forEach((f, i) => {
      const at: Offset = [600, -200 + i * 140];
      apply(f, map.addFloating(f.text, at));
    });
    for (const [a, b] of data.links) {
      const from = keys.get(a), to = keys.get(b);
      if (from && to) map.addLink(from, to);
    }
  });
  return map;
}

// ── 小工具 ─────────────────────────────────────────

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (s: string) => xmlText(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "");

function normalizeColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim()) ?? /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c.trim());
  if (!m) return undefined;
  return m.length === 2 ? `#${m[1].toLowerCase()}` : `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
}

/** 去掉行內 Markdown 標記（粗體、斜體、行內程式碼、連結） */
function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim();
}

function htmlText(e: XmlElement): string {
  const parts: string[] = [];
  const walk = (x: XmlElement) => {
    if (x.name === "p" || x.name === "br" || x.name === "div" || x.name === "li") if (parts.length) parts.push("\n");
    parts.push(x.ownText);
    x.children.forEach(walk);
  };
  walk(e);
  return parts.join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}

// ── 很小的 XML 解析器（OPML、FreeMind 用；不支援 DTD 實體，夠用就好）─────

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** 自己與所有子孫的文字 */
  text: string;
  /** 只有自己（不含子元素）的文字 */
  ownText: string;
}

const child = (e: XmlElement, name: string) => e.children.find((c) => c.name === name);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos|nbsp);/gi, (m, v: string) => {
    const k = v.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[k] ?? m;
  });
}

export function parseXml(src: string): XmlElement {
  const text = src.replace(/^﻿/, "");
  const rootHolder: XmlElement = { name: "#root", attrs: {}, children: [], text: "", ownText: "" };
  const stack: XmlElement[] = [rootHolder];
  let i = 0;
  const addText = (t: string) => {
    if (!t) return;
    for (const e of stack) e.text += t;
    stack[stack.length - 1].ownText += t;
  };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    addText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt);
      if (end < 0) throw new Error("XML 註解沒有結尾");
      i = end + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      if (end < 0) throw new Error("CDATA 沒有結尾");
      addText(text.slice(lt + 9, end));
      i = end + 3;
    } else if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt);
      if (end < 0) throw new Error("XML 宣告沒有結尾");
      i = end + 2;
    } else if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt);
      if (end < 0) throw new Error("XML 宣告沒有結尾");
      i = end + 1;
    } else if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt);
      if (end < 0) throw new Error("XML 標籤沒有結尾");
      const name = text.slice(lt + 2, end).trim();
      // 容錯：HTML（richcontent）裡沒有關閉的標籤
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k === 0) throw new Error(`多出來的結束標籤 </${name}>`);
      stack.length = k;
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(lt));
      if (!m) throw new Error("XML 標籤格式錯誤");
      const attrs: Record<string, string> = {};
      for (const a of m[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
      const el: XmlElement = { name: m[1], attrs, children: [], text: "", ownText: "" };
      stack[stack.length - 1].children.push(el);
      const selfClose = m[3] === "/" || /^(br|hr|img|meta|link|input)$/i.test(m[1]);
      if (!selfClose) stack.push(el);
      i = lt + m[0].length;
    }
  }
  const top = rootHolder.children[0];
  if (!top) throw new Error("沒有內容");
  return top;
}

// ── 依副檔名（或內容）選格式 ─────────────────────────

export const IMPORT_EXTENSIONS = [".gugamap", ".opml", ".mm", ".md", ".markdown", ".txt"];

/** 讀入任何支援的檔案（.gugamap 另外處理，見 file.ts）；回傳 null = 不是這些格式 */
export function importOutlineFile(name: string, text: string): MindMap | null {
  const base = name.replace(/\.[^.]+$/, "") || "心智圖";
  const ext = /\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? "";
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 200).toLowerCase();
  if (ext === ".opml" || head.includes("<opml")) return buildMindMap(parseOPML(text, base));
  if (ext === ".mm" || /^(<\?xml[^>]*>\s*)?<map[\s>]/.test(head)) return buildMindMap(parseFreeMind(text, base));
  if (ext === ".md" || ext === ".markdown") return buildMindMap(parseMarkdown(text, base));
  if (ext === ".txt") return buildMindMap(parsePlainText(text, base));
  return null;
}
