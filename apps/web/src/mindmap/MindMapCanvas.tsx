import {
  branchColors,
  edgePath,
  layoutForest,
  lineWidthAt,
  linkPath,
  PORT_INSET,
  sketchJitter,
  stickyTilt,
  type Layout,
  type MindLink,
  type MindMap,
  type NodeStyle,
  type Placed,
  type Structure,
  type Theme,
  type TreeNode,
} from "@tool/mindmap";

/**
 * 心智圖的 SVG 內容（連接線＋節點）。編輯畫面和匯出圖片都用這個，畫出來一樣。
 * 座標是排版的座標（px），外層負責平移、縮放。
 */

export const FONT = `system-ui, -apple-system, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
export const LINE_HEIGHT = 1.35;
/** 一行文字最寬多少（以 14px 字為準，字越大越寬）；超過就自動換行，元件改成往下長高 */
const MAX_LINE = 220;

let measureCtx: CanvasRenderingContext2D | null = null;

function ctxFor(style: NodeStyle) {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `${style.fontWeight} ${style.fontSize}px ${FONT}`;
  return measureCtx;
}

export const maxLineWidth = (style: NodeStyle) => Math.round((MAX_LINE * style.fontSize) / 14);

/** 中日韓文字（每個字都可以斷行） */
const CJK = "⺀-鿿豈-﫿＀-￯　-〿";
const TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+\\s*|\\s+`, "g");

/**
 * 自動換行：中日韓文字每個字都可以斷，英文以單字為單位（單字本身太長才拆開）。
 * 量測與繪製都用這個，元件大小和畫出來的行數才會一致。
 */
export function wrapLines(text: string, style: NodeStyle): { lines: string[]; width: number } {
  const ctx = ctxFor(style);
  const max = maxLineWidth(style);
  const w = (t: string) => ctx.measureText(t).width;
  const lines: string[] = [];
  for (const para of (text || " ").split("\n")) {
    const tokens = para.match(TOKEN) ?? [""];
    let line = "";
    for (const tok of tokens) {
      if (!line || w(line + tok.trimEnd()) <= max) {
        line += tok;
      } else {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      }
      // 單一個字太長（例如很長的網址）：一個字元一個字元拆
      while (line.length > 1 && w(line.trimEnd()) > max) {
        let i = line.length - 1;
        while (i > 1 && w(line.slice(0, i)) > max) i--;
        lines.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    lines.push(line.trimEnd());
  }
  return { lines, width: Math.ceil(Math.max(...lines.map((l) => w(l || " ")))) };
}

/** 元件的最小大小（有框的形狀；底線只有最小寬度）：字很少時元件也不會太小、比較好點 */
export const MIN_WIDTH = 120;
export const MIN_HEIGHT = 44;

/** 節點大小：依文字（自動換行）與樣式的內距，不小於最小大小 */
export function measureNode(text: string, style: NodeStyle, depth: number): { width: number; height: number } {
  const { lines, width: w } = wrapLines(text, style);
  const boxed = style.shape !== "underline";
  let width = Math.max(depth === 0 ? MIN_WIDTH + 20 : boxed ? MIN_WIDTH : 80, w + style.padX * 2);
  let height = Math.max(boxed ? MIN_HEIGHT : 0, Math.ceil(lines.length * style.fontSize * LINE_HEIGHT) + style.padY * 2);
  if (style.shape === "ellipse") {
    width = Math.ceil(width * 1.12);
    height = Math.ceil(height * 1.2);
  }
  return { width, height };
}

/** 自訂顏色（節點或祖先設定的），沒有設定的節點不在裡面 */
export function customColors(trees: TreeNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode, inherited?: string) => {
    const c = n.color ?? inherited;
    if (c) out.set(n.id, c);
    n.children.forEach((k) => walk(k, c));
  };
  trees.forEach((t) => walk(t));
  return out;
}

export interface CanvasData {
  layout: Layout;
  theme: Theme;
  tree: TreeNode;
  /** 中心元件的樹＋所有獨立元件的樹 */
  forest: TreeNode[];
  /** 手拉的連接線 */
  links: MindLink[];
  /** 節點代號 → 節點（文字等） */
  nodes: Map<string, TreeNode>;
  styles: Map<string, NodeStyle>;
}

/** `editing` = 正在編輯的元件與目前打的字：元件跟著文字即時變大 */
export function prepare(map: MindMap, structure: Structure, theme: Theme, editing?: { id: string; text: string }): CanvasData {
  const swap = <T extends TreeNode>(n: T): T => (n.id === editing!.id ? { ...n, text: editing!.text } : { ...n, children: n.children.map(swap) });
  let tree = map.tree(structure);
  let floating = map.floating(structure);
  if (editing) {
    tree = swap(tree);
    floating = floating.map(swap);
  }
  const nodes = new Map<string, TreeNode>();
  const depthOf = new Map<string, number>();
  const walk = (n: TreeNode, d: number) => {
    nodes.set(n.id, n);
    depthOf.set(n.id, d);
    n.children.forEach((c) => walk(c, d + 1));
  };
  walk(tree, 0);
  // 獨立元件的外觀和一般元件一樣（深度從 1 算）
  floating.forEach((f) => walk(f, 1));
  const colors = branchColors(tree, theme, floating);
  const styles = new Map<string, NodeStyle>();
  for (const [id, d] of depthOf) styles.set(id, withOverride(theme, theme.style(d, colors.get(id)!), nodes.get(id)!.style?.shape, colors.get(id)!));
  const layout = layoutForest(tree, floating, (n) => measureNode(n.text, styles.get(n.id)!, depthOf.get(n.id)!), structure);
  return { layout, theme, tree, forest: [tree, ...floating], links: map.links(), nodes, styles };
}

const isDark = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return ((v >> 16) & 255) * 0.299 + ((v >> 8) & 255) * 0.587 + (v & 255) * 0.114 < 128;
};

/** 套用單一主題的形狀設定：從「底線」改成有框的形狀時用框線；從有底色改成底線時文字改用看得到的顏色 */
function withOverride(theme: Theme, st: NodeStyle, shape: NodeShapeName | undefined, branch: string): NodeStyle {
  if (!shape || shape === st.shape) return st;
  if (shape === "underline") {
    const line = st.fill !== "none" ? st.fill : st.stroke !== "none" ? st.stroke : branch;
    return { ...st, shape, fill: "none", stroke: line, strokeWidth: 2, text: isDark(theme.background) ? "#f1f0f4" : "#212529", padX: 4, padY: 5 };
  }
  if (st.shape === "underline") {
    return { ...st, shape, fill: "none", stroke: st.stroke !== "none" ? st.stroke : branch, strokeWidth: 1.5, padX: Math.max(st.padX, shape === "card" ? 28 : 12), padY: Math.max(st.padY, 7) };
  }
  return { ...st, shape, padX: shape === "card" ? Math.max(st.padX, 28) : st.padX };
}

type NodeShapeName = NonNullable<NonNullable<TreeNode["style"]>["shape"]>;

/** 手拉連接線在畫面上的代號（和「上層 → 子元件」的線分開：那種線用子元件代號） */
export const LINK_PREFIX = "link:";

/** 一條連接線：上層 → 子元件（代號 = 子元件代號），或手拉的線（代號 = link:線的代號） */
export interface EdgeInfo {
  id: string;
  /** 起點元件（上層、或手拉線的起點） */
  parent: string;
  /** 終點元件 */
  child: string;
  link: boolean;
  d: string;
  color: string;
  width: number;
  dash: boolean;
  /** 兩端點（框選、連接點用） */
  from: [number, number];
  to: [number, number];
}

/** 所有連接線（畫線、點選線條、框選共用） */
export function edgeList(data: CanvasData, layout: Layout = data.layout): EdgeInfo[] {
  const { theme, styles, nodes, forest } = data;
  const custom = customColors(forest);
  const horizontal = layout.structure === "mindmap" || layout.structure === "logic";
  const inset = theme.port && horizontal ? PORT_INSET : 0;
  const out: EdgeInfo[] = [];
  for (const child of layout.nodes) {
    if (!child.parent) continue;
    const parent = layout.byId.get(child.parent);
    if (!parent) continue;
    const own = nodes.get(child.id)?.style;
    const underline = styles.get(child.id)!.shape === "underline";
    let d = edgePath(layout, parent, child, own?.line ?? theme.edge, { underline, portInset: inset });
    if (theme.sketchy) {
      const j = sketchJitter(child.id);
      d = d.replace(/-?\d+(\.\d+)?/g, (m) => String(Math.round(j(Number(m)) * 10) / 10));
    }
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    out.push({
      id: child.id,
      parent: parent.id,
      child: child.id,
      link: false,
      d,
      color: theme.coloredLines ? styles.get(child.id)!.stroke : custom.get(child.id) ?? theme.lineColor,
      width: own?.width ?? lineWidthAt(theme, child.depth),
      dash: !!own?.dash,
      from: [nums[0], nums[1]],
      to: [nums[nums.length - 2], nums[nums.length - 1]],
    });
  }
  // 手拉的線（兩端都看得到才畫；收合藏起來的不畫）
  for (const l of data.links) {
    const a = layout.byId.get(l.from), b = layout.byId.get(l.to);
    if (!a || !b) continue;
    let d = linkPath(layout, a, b, l.line ?? theme.edge, { portInset: inset });
    if (theme.sketchy) {
      const j = sketchJitter(l.id);
      d = d.replace(/-?\d+(\.\d+)?/g, (m) => String(Math.round(j(Number(m)) * 10) / 10));
    }
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    out.push({
      id: LINK_PREFIX + l.id,
      parent: l.from,
      child: l.to,
      link: true,
      d,
      color: l.color ?? custom.get(l.from) ?? theme.lineColor,
      width: l.width ?? lineWidthAt(theme, 2),
      dash: !!l.dash,
      from: [nums[0], nums[1]],
      to: [nums[nums.length - 2], nums[nums.length - 1]],
    });
  }
  return out;
}

/**
 * 心智圖內容。`layout` 可以傳拖曳中的暫時排版（連接線跟著動）；`lifted` = 拖曳中的節點（畫在最上面、稍微透明）。
 */
export function MindMapContent({ data, layout = data.layout, lifted, editing }: { data: CanvasData; layout?: Layout; lifted?: Set<string>; editing?: string }) {
  const { theme, nodes, styles, forest } = data;
  const custom = customColors(forest);
  const horizontal = layout.structure === "mindmap" || layout.structure === "logic";
  const inset = theme.port && horizontal ? PORT_INSET : 0;
  const edges = edgeList(data, layout);
  // 拖曳中的節點畫在最後（在其他節點上面）
  const order = lifted ? [...layout.nodes.filter((n) => !lifted.has(n.id)), ...layout.nodes.filter((n) => lifted.has(n.id))] : layout.nodes;
  return (
    <>
      <g className="mm-edges">
        {edges.map((e) => (
          <path key={e.id} d={e.d} fill="none" stroke={e.color} strokeWidth={e.width} strokeLinecap="round" strokeDasharray={e.dash ? `${e.width * 3} ${e.width * 2.5}` : undefined} />
        ))}
      </g>
      <g className="mm-nodes">
        {order.map((n) => (
          <NodeShape key={n.id} placed={n} node={nodes.get(n.id)!} style={styles.get(n.id)!} theme={theme} inset={inset} portColor={custom.get(n.id) ?? theme.port} ghost={lifted?.has(n.id)} hideText={n.id === editing} structure={layout.structure} />
        ))}
      </g>
      {theme.port && (
        <g className="mm-ports">
          {edges.map((e) => (
            <g key={e.id}>
              {/* 中心主題（標籤）沒有連接點，線直接從邊上出來 */}
              {layout.byId.get(e.parent)!.depth > 0 && <circle cx={e.from[0]} cy={e.from[1]} r={3.6} fill={custom.get(e.parent) ?? theme.port} />}
              {layout.byId.get(e.child)!.depth > 0 && <circle cx={e.to[0]} cy={e.to[1]} r={3.6} fill={custom.get(e.child) ?? theme.port} />}
            </g>
          ))}
        </g>
      )}
    </>
  );
}

export function NodeShape({
  placed: n,
  node,
  style: st,
  theme,
  inset,
  portColor,
  dim,
  structure,
  ghost,
  hideText,
}: {
  placed: Placed;
  node: TreeNode;
  style: NodeStyle;
  theme: Theme;
  inset: number;
  portColor?: string;
  dim?: boolean;
  structure: Layout["structure"];
  ghost?: boolean;
  /** 正在編輯：文字由編輯框顯示，這裡不畫 */
  hideText?: boolean;
}) {
  const { width: w, height: h } = n;
  const { lines } = wrapLines(node.text, st);
  const lh = st.fontSize * LINE_HEIGHT;
  const textTop = (h - lines.length * lh) / 2;
  const fill = st.fill === "none" ? "transparent" : st.fill;
  const stroke = st.stroke === "none" ? undefined : st.stroke;
  let shape: JSX.Element;
  switch (st.shape) {
    case "pill":
      shape = <rect width={w} height={h} rx={h / 2} fill={fill} stroke={stroke} strokeWidth={st.strokeWidth} />;
      break;
    case "rounded":
      shape = <rect width={w} height={h} rx={8} fill={fill} stroke={stroke} strokeWidth={st.strokeWidth} />;
      break;
    case "card":
      shape = <rect width={w} height={h} rx={14} fill={fill} stroke={stroke} strokeWidth={st.strokeWidth} />;
      break;
    case "rect":
      shape = <rect width={w} height={h} rx={2} fill={fill} stroke={stroke} strokeWidth={st.strokeWidth} />;
      break;
    case "ellipse":
      shape = <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={st.strokeWidth} />;
      break;
    case "sticky":
      shape = <rect width={w} height={h} rx={3} fill={fill} transform={`rotate(${stickyTilt(n.id)} ${w / 2} ${h / 2})`} />;
      break;
    case "tag": {
      // 斜的標籤（平行四邊形，圓角用同色粗邊模擬）
      const k = Math.min(10, h * 0.2);
      shape = <path d={`M${k} 0H${w}L${w - k} ${h}H0Z`} fill={fill} stroke={fill} strokeWidth={8} strokeLinejoin="round" />;
      break;
    }
    case "underline":
    default:
      // 透明底：點得到整個節點範圍
      shape = (
        <>
          <rect width={w} height={h} fill="transparent" />
          <line x1={0} y1={h - 1} x2={w} y2={h - 1} stroke={stroke} strokeWidth={st.strokeWidth} strokeLinecap="round" />
        </>
      );
  }
  // 節點卡片：沒有連出去的那一側也畫連接點（和截圖一樣，卡片左右各一個）
  const horizontalPorts = st.shape === "card" && inset > 0 && portColor;
  const badge = node.hidden > 0 ? collapsedBadge(n, structure, theme) : null;
  return (
    <g data-node={n.id} transform={`translate(${n.x} ${n.y})`} opacity={dim ? 0.35 : ghost ? 0.85 : 1} style={{ cursor: ghost ? "grabbing" : "pointer" }}>
      {shape}
      {horizontalPorts && (
        <>
          <circle cx={inset} cy={h / 2} r={3.6} fill={portColor} />
          <circle cx={w - inset} cy={h / 2} r={3.6} fill={portColor} />
        </>
      )}
      <text visibility={hideText ? "hidden" : undefined} fill={st.text} fontSize={st.fontSize} fontWeight={st.fontWeight} fontFamily={FONT} textAnchor="middle">
        {lines.map((line, i) => (
          <tspan key={i} x={w / 2} y={textTop + lh * (i + 0.5)} dominantBaseline="central">
            {line || " "}
          </tspan>
        ))}
      </text>
      {badge}
    </g>
  );

  function collapsedBadge(p: Placed, s: Layout["structure"], t: Theme) {
    const r = 10;
    const [cx, cy] = s === "org" ? [w / 2, h + r + 4] : s === "tree" ? [-r - 4, h / 2] : p.side === -1 ? [-r - 4, h / 2] : [w + r + 4, h / 2];
    const label = p.hidden > 99 ? "99+" : `+${p.hidden}`;
    return (
      <g data-toggle={p.id} style={{ cursor: "pointer" }} aria-label={`展開 ${p.hidden} 個元件`}>
        <circle cx={cx} cy={cy} r={r + (label.length > 3 ? 3 : 0)} fill={t.background} stroke={t.accent} strokeWidth={1.5} />
        <text x={cx} y={cy} fontSize={10} fontWeight={700} fontFamily={FONT} fill={t.port ?? t.lineColor} textAnchor="middle" dominantBaseline="central">
          {label}
        </text>
      </g>
    );
  }
}
