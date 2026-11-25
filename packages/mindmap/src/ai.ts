import { parseMarkdown, parseXml, buildMindMap, type ImportedMap, type OutlineNode, type XmlElement } from "./interchange";
import { MindMap } from "./model";

/**
 * 用語言模型把文字（文件、圖片）轉成架構圖或流程圖：和程式無關的部分（提示詞、解析模型的回答、流程圖排版、文件轉文字）。
 * 呼叫模型（網路）在網頁那邊做，這裡只有純函式，可以單元測試。
 *
 * 模型的回答不一定照規矩：先找 JSON；找不到時，架構圖接受 Markdown 大綱，流程圖接受 Mermaid（模型常常會這樣回答）。
 */

export type DiagramKind = "mind" | "flow";

export interface ChatMessage {
  role: "system" | "user";
  content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
}

const MIND_SYSTEM = `你是把內容整理成架構圖（心智圖）的助手。
讀使用者給的內容，找出主題與層級關係，只回答一個 JSON 物件，不要有其他文字：
{"title": "圖的標題", "root": {"text": "中心主題", "children": [{"text": "第一層", "children": [{"text": "第二層", "children": []}]}]}}
規則：
- 每個 text 簡短（最多約 20 個字），是名詞片語或短句，不要整段複製原文。
- 依內容決定層數，通常 2～4 層；同一層 3～8 個為宜。
- 用內容本身的語言回答（中文內容用繁體中文）。`;

const FLOW_SYSTEM = `你是把內容整理成流程圖的助手。
讀使用者給的內容，找出步驟、判斷與先後順序，只回答一個 JSON 物件，不要有其他文字：
{"title": "流程名稱", "nodes": [{"id": "n1", "text": "開始", "type": "start"}, {"id": "n2", "text": "步驟", "type": "process"}, {"id": "n3", "text": "條件？", "type": "decision"}, {"id": "n4", "text": "結束", "type": "end"}], "edges": [{"from": "n1", "to": "n2"}, {"from": "n3", "to": "n4", "label": "是"}]}
規則：
- type 只能是 start（開始）、end（結束）、process（步驟）、decision（判斷，問句）、io（輸入／輸出資料）。
- 判斷（decision）連出去的線要有 label（例如「是」「否」）。
- 每個 text 簡短（最多約 20 個字）。
- 用內容本身的語言回答（中文內容用繁體中文）。`;

/** 給模型的訊息。images = 圖片的 data URL（模型看得懂圖片時才會有） */
export function buildPrompt(kind: DiagramKind, text: string, images: string[] = []): ChatMessage[] {
  const ask = kind === "flow" ? "把下面的內容整理成流程圖：" : "把下面的內容整理成架構圖：";
  const body = text.trim() ? `${ask}\n\n${text.trim()}` : images.length ? `${ask}（內容在圖片裡）` : ask;
  const content: ChatMessage["content"] = images.length ? [{ type: "text", text: body }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : body;
  return [
    { role: "system", content: kind === "flow" ? FLOW_SYSTEM : MIND_SYSTEM },
    { role: "user", content },
  ];
}

// ── 解析模型的回答 ─────────────────────────────────

/** 回答裡的 JSON（去掉 ```json 框、前後的說明文字）；找不到回傳 undefined */
export function extractJson(answer: string): unknown {
  const cleaned = answer.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  const candidates = [fenced?.[1], cleaned];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    if (start < 0) continue;
    // 從第一個 { 找到對應的 }（略過字串裡的括號）
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** 架構圖：JSON（{title, root} 或直接是 {text, children}）或 Markdown 大綱 */
export function parseMindAnswer(answer: string, fallbackTitle: string): ImportedMap {
  const json = extractJson(answer) as Record<string, unknown> | undefined;
  if (json && typeof json === "object") {
    const rootRaw = (json.root ?? json.tree ?? (json.text || json.children ? json : undefined)) as unknown;
    const conv = (v: unknown, depth: number): OutlineNode | null => {
      if (typeof v === "string") return { text: v.trim(), children: [] };
      if (!v || typeof v !== "object" || depth > 12) return null;
      const o = v as Record<string, unknown>;
      const text = str(o.text ?? o.title ?? o.name ?? o.label);
      const kids = Array.isArray(o.children) ? o.children : Array.isArray(o.items) ? o.items : [];
      const children = kids.map((k) => conv(k, depth + 1)).filter((k): k is OutlineNode => !!k && !!k.text);
      return text || children.length ? { text: text || fallbackTitle, children } : null;
    };
    const root = conv(rootRaw, 0);
    if (root) {
      const title = str(json.title) || root.text || fallbackTitle;
      return { title, root, floating: [], links: [] };
    }
  }
  try {
    const md = parseMarkdown(answer.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```\w*\n?/g, ""), fallbackTitle);
    return md;
  } catch {
    throw new Error("看不懂模型的回答（不是 JSON，也不是大綱）。可以換個模型，或把內容改短一點再試。");
  }
}

export type FlowNodeType = "start" | "end" | "process" | "decision" | "io";

export interface FlowData {
  title: string;
  nodes: { id: string; text: string; type: FlowNodeType }[];
  edges: { from: string; to: string; label?: string }[];
}

const TYPES: Record<string, FlowNodeType> = {
  start: "start", begin: "start", 開始: "start",
  end: "end", stop: "end", finish: "end", 結束: "end",
  process: "process", step: "process", action: "process", task: "process",
  decision: "decision", condition: "decision", if: "decision", 判斷: "decision",
  io: "io", input: "io", output: "io", data: "io",
};

/** 流程圖：JSON（nodes、edges）或 Mermaid flowchart */
export function parseFlowAnswer(answer: string, fallbackTitle: string): FlowData {
  const json = extractJson(answer) as Record<string, unknown> | undefined;
  let flow: FlowData | null = null;
  if (json && typeof json === "object" && Array.isArray(json.nodes)) {
    const nodes: FlowData["nodes"] = [];
    const seen = new Set<string>();
    json.nodes.forEach((v, i) => {
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      const id = str(o.id) || `n${i + 1}`;
      if (seen.has(id)) return;
      seen.add(id);
      nodes.push({ id, text: str(o.text ?? o.label ?? o.name) || id, type: TYPES[str(o.type ?? o.kind).toLowerCase()] ?? "process" });
    });
    const edges: FlowData["edges"] = [];
    for (const v of Array.isArray(json.edges) ? json.edges : Array.isArray(json.links) ? json.links : []) {
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      const from = str(o.from ?? o.source), to = str(o.to ?? o.target);
      if (!seen.has(from) || !seen.has(to) || from === to) continue;
      const label = str(o.label ?? o.text);
      edges.push({ from, to, ...(label ? { label } : {}) });
    }
    if (nodes.length) flow = { title: str(json.title) || fallbackTitle, nodes, edges };
  }
  flow ??= parseMermaid(answer, fallbackTitle);
  if (!flow) throw new Error("看不懂模型的回答（不是流程圖的 JSON，也不是 Mermaid）。可以換個模型，或把內容改短一點再試。");
  return flow;
}

/** Mermaid flowchart（graph TD / flowchart LR）：A[文字] --> B{判斷} -->|是| C((結束)) */
export function parseMermaid(answer: string, fallbackTitle: string): FlowData | null {
  const block = /```(?:mermaid)?\s*([\s\S]*?)```/i.exec(answer)?.[1] ?? answer;
  if (!/^\s*(graph|flowchart)\b/m.test(block)) return null;
  const nodes = new Map<string, FlowData["nodes"][number]>();
  const edges: FlowData["edges"] = [];
  const NODE = /([A-Za-z_][\w-]*)\s*(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\/([^\]]*)\/\]|\[\\([^\]]*)\\\]|\{([^}]*)\}|\(([^)]*)\)|\[([^\]]*)\])?/y;
  const node = (src: string, pos: number): { id: string; end: number } | null => {
    NODE.lastIndex = pos;
    const m = NODE.exec(src);
    if (!m) return null;
    const id = m[1];
    const clean = (t: string) => t.replace(/^["']|["']$/g, "").trim();
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, text: id, type: "process" }));
    if (m[2]) {
      if (m[3] !== undefined || m[4] !== undefined) n.type = /結束|end|stop/i.test(m[3] ?? m[4] ?? "") ? "end" : "start";
      else if (m[5] !== undefined || m[6] !== undefined) n.type = "io";
      else if (m[7] !== undefined) n.type = "decision";
      else n.type = n.type === "process" && m[8] !== undefined ? (/結束|end/i.test(m[8]) ? "end" : /開始|start/i.test(m[8]) ? "start" : "process") : n.type;
      n.text = clean(m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9] ?? id) || id;
    }
    return { id, end: NODE.lastIndex };
  };
  for (const rawLine of block.split(/\n|;/)) {
    const line = rawLine.trim();
    if (!line || /^(graph|flowchart|classDef|class|style|linkStyle|subgraph|end$|%%)/.test(line)) continue;
    let pos = 0;
    let prev = node(line, pos);
    if (!prev) continue;
    pos = prev.end;
    for (;;) {
      const arrow = /\s*(?:--\s*([^->|]+?)\s*-->|-->|---|-\.->|==>)\s*(?:\|([^|]*)\|)?\s*/y;
      arrow.lastIndex = pos;
      const a = arrow.exec(line);
      if (!a) break;
      const next = node(line, arrow.lastIndex);
      if (!next) break;
      const label = (a[1] ?? a[2] ?? "").trim();
      edges.push({ from: prev.id, to: next.id, ...(label ? { label } : {}) });
      prev = next;
      pos = next.end;
    }
  }
  if (!nodes.size) return null;
  return { title: fallbackTitle, nodes: [...nodes.values()], edges };
}

// ── 流程圖排版（由上往下分層） ───────────────────────

export interface FlowBox {
  id: string;
  width: number;
  height: number;
}

/**
 * 分層排版（簡化的 Sugiyama）：
 *   1. 從起點做深度優先，往回指的線（迴圈）不算
 *   2. 每個元件的層 = 所有上一步的層 + 1 的最大值
 *   3. 同一層的順序：依上一層連過來的元件位置平均（來回幾次），減少交叉
 *   4. 每個元件盡量放在上一步的正下方，同層不重疊
 * 回傳每個元件左上角的座標（第一層的中心在 x = 0）。
 */
export function layoutFlow(boxes: FlowBox[], edges: { from: string; to: string }[], gap = { x: 48, y: 64 }): Map<string, [number, number]> {
  const ids = boxes.map((b) => b.id);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const out = new Map<string, string[]>(), inc = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inc.set(id, []);
  }
  const valid = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  for (const e of valid) out.get(e.from)!.push(e.to);
  // 1. 找出往回的線
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const w of out.get(v)!) {
      const s = state.get(w) ?? 0;
      if (s === 1) back.add(`${v}>${w}`);
      else if (s === 0) dfs(w);
    }
    state.set(v, 2);
  };
  const roots = ids.filter((id) => !valid.some((e) => e.to === id));
  for (const r of [...roots, ...ids]) if (!state.get(r)) dfs(r);
  const forward = valid.filter((e) => !back.has(`${e.from}>${e.to}`));
  for (const id of ids) out.set(id, []);
  for (const e of forward) {
    out.get(e.from)!.push(e.to);
    inc.get(e.to)!.push(e.from);
  }
  // 2. 分層（拓撲順序）
  const layer = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, inc.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of out.get(v)!) {
      layer.set(w, Math.max(layer.get(w) ?? 0, layer.get(v)! + 1));
      indeg.set(w, indeg.get(w)! - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }
  const layers: string[][] = [];
  for (const id of ids) (layers[layer.get(id) ?? 0] ??= []).push(id);
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];
  // 3. 同層順序：上下來回依鄰居的平均位置排
  const order = () => new Map(layers.flatMap((l) => l.map((id, i) => [id, i] as const)));
  for (let pass = 0; pass < 4; pass++) {
    const pos = order();
    const down = pass % 2 === 0;
    const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of seq) {
      const key = (id: string) => {
        const nb = down ? inc.get(id)! : out.get(id)!;
        return nb.length ? nb.reduce((s, n) => s + pos.get(n)!, 0) / nb.length : pos.get(id)!;
      };
      l.sort((a, b) => key(a) - key(b));
      l.forEach((id, i) => pos.set(id, i));
    }
  }
  // 4. 座標
  const result = new Map<string, [number, number]>();
  const cx = new Map<string, number>();
  let y = 0;
  for (const l of layers) {
    if (!l.length) continue;
    const h = Math.max(...l.map((id) => byId.get(id)!.height));
    // 想要的中心：上一步的中心平均；第一層排成一排置中
    const want = l.map((id) => {
      const ps = inc.get(id)!.filter((p) => cx.has(p));
      return ps.length ? ps.reduce((s, p) => s + cx.get(p)!, 0) / ps.length : NaN;
    });
    const widths = l.map((id) => byId.get(id)!.width);
    const total = widths.reduce((a, b) => a + b, 0) + gap.x * (l.length - 1);
    let x = -total / 2;
    const centers = l.map((_, i) => {
      const c = x + widths[i] / 2;
      x += widths[i] + gap.x;
      return c;
    });
    // 有想要的位置：照想要的放，再往右推開重疊的
    if (want.some((w) => !Number.isNaN(w))) {
      for (let i = 0; i < l.length; i++) if (!Number.isNaN(want[i])) centers[i] = want[i];
      for (let i = 1; i < l.length; i++) {
        const min = centers[i - 1] + widths[i - 1] / 2 + gap.x + widths[i] / 2;
        if (centers[i] < min) centers[i] = min;
      }
      // 整排往左移，讓偏移平均起來是 0
      const diffs = l.map((_, i) => (Number.isNaN(want[i]) ? 0 : centers[i] - want[i]));
      const shift = diffs.reduce((a, b) => a + b, 0) / Math.max(1, want.filter((w) => !Number.isNaN(w)).length);
      for (let i = 0; i < l.length; i++) centers[i] -= shift;
    }
    l.forEach((id, i) => {
      const b = byId.get(id)!;
      cx.set(id, centers[i]);
      result.set(id, [centers[i] - b.width / 2, y + (h - b.height) / 2]);
    });
    y += h + gap.y;
  }
  return result;
}

const SHAPE: Record<FlowNodeType, "pill" | "rect" | "diamond" | "parallelogram"> = {
  start: "pill",
  end: "pill",
  process: "rect",
  decision: "diamond",
  io: "parallelogram",
};

/**
 * 建立流程圖：第一個開始（沒有就第一個）是中心元件，其他都是獨立元件，用有箭頭的線連起來。
 * 位置要等畫面量過元件大小才排（layoutPending），打開時自動排版。
 */
export function buildFlowMap(flow: FlowData): MindMap {
  const first = flow.nodes.find((n) => n.type === "start") ?? flow.nodes[0];
  const map = MindMap.create(flow.title || first.text, first.text);
  map.doc.transact(() => {
    map.kind = "flow";
    map.structure = "org";
    map.layoutPending = true;
    const ids = new Map<string, string>([[first.id, map.rootId]]);
    flow.nodes.forEach((n, i) => {
      if (n !== first) ids.set(n.id, map.addFloating(n.text, [0, i * 80]));
    });
    for (const n of flow.nodes) map.setNodeStyle([ids.get(n.id)!], { shape: SHAPE[n.type] });
    for (const e of flow.edges) {
      const a = ids.get(e.from), b = ids.get(e.to);
      if (a && b) map.addLink(a, b, { arrow: true, ...(e.label ? { label: e.label } : {}) });
    }
  });
  return map;
}

/** 依回答建立圖 */
export function buildDiagram(kind: DiagramKind, answer: string, fallbackTitle: string): MindMap {
  return kind === "flow" ? buildFlowMap(parseFlowAnswer(answer, fallbackTitle)) : buildMindMap(parseMindAnswer(answer, fallbackTitle));
}

// ── 文件轉文字（Office 檔解壓縮在網頁那邊做，這裡處理 XML） ─────

const W = (e: XmlElement, local: string) => e.name === local || e.name.endsWith(`:${local}`);

function walk(e: XmlElement, fn: (x: XmlElement) => boolean | void) {
  if (fn(e) === false) return;
  for (const c of e.children) walk(c, fn);
}

/** Word（word/document.xml）→ Markdown：標題樣式（Heading1／標題 1…）變 #，清單變 -，其他段落照抄 */
export function docxToMarkdown(documentXml: string): string {
  const doc = parseXml(documentXml);
  const lines: string[] = [];
  walk(doc, (p) => {
    if (!W(p, "p")) return;
    let text = "";
    let heading = 0;
    let list = -1;
    walk(p, (x) => {
      if (W(x, "pStyle")) {
        const v = x.attrs["w:val"] ?? x.attrs.val ?? "";
        const m = /(?:heading|標題|title)\s*(\d)?/i.exec(v);
        if (m) heading = /title/i.test(v) && !m[1] ? 1 : Number(m[1] ?? 1);
      } else if (W(x, "ilvl")) list = Number(x.attrs["w:val"] ?? x.attrs.val ?? 0);
      else if (W(x, "numPr") && list < 0) list = 0;
      else if (W(x, "t")) text += x.text;
      else if (W(x, "tab")) text += " ";
      else if (W(x, "br")) text += " ";
    });
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return false;
    if (heading) lines.push(`${"#".repeat(Math.min(6, heading))} ${text}`);
    else if (list >= 0) lines.push(`${"  ".repeat(list)}- ${text}`);
    else lines.push(text);
    return false;
  });
  return lines.join("\n");
}

/** PowerPoint（ppt/slides/slideN.xml，依順序）→ Markdown：每張投影片的標題是 ##，其他文字依層級變清單 */
export function pptxToMarkdown(slideXmls: string[]): string {
  const out: string[] = [];
  slideXmls.forEach((xml, i) => {
    const doc = parseXml(xml);
    let title = "";
    const body: string[] = [];
    walk(doc, (sp) => {
      if (!W(sp, "sp")) return;
      let isTitle = false;
      walk(sp, (x) => {
        if (W(x, "ph") && /title/i.test(x.attrs.type ?? "")) isTitle = true;
      });
      walk(sp, (p) => {
        if (!W(p, "p")) return;
        let t = "";
        let lvl = 0;
        walk(p, (x) => {
          if (W(x, "pPr")) lvl = Number(x.attrs.lvl ?? 0);
          if (W(x, "t")) t += x.text;
        });
        t = t.replace(/\s+/g, " ").trim();
        if (t) {
          if (isTitle && !title) title = t;
          else body.push(`${"  ".repeat(lvl)}- ${t}`);
        }
        return false;
      });
      return false;
    });
    if (!title && !body.length) return;
    out.push(`## ${title || `第 ${i + 1} 張投影片`}`, ...body, "");
  });
  return out.join("\n").trim();
}
