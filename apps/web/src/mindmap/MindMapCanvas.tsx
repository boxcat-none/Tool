import {
  branchColors,
  edgePath,
  lineWidthAt,
  PORT_INSET,
  sketchJitter,
  stickyTilt,
  type Layout,
  type MindMap,
  type NodeStyle,
  type Placed,
  type Theme,
  type TreeNode,
} from "@tool/mindmap";

/**
 * 心智圖的 SVG 內容（連接線＋節點）。編輯畫面和匯出圖片都用這個，畫出來一樣。
 * 座標是排版的座標（px），外層負責平移、縮放。
 */

export const FONT = `system-ui, -apple-system, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
const LINE_HEIGHT = 1.35;

let measureCtx: CanvasRenderingContext2D | null = null;

/** 節點大小：依文字（可多行）與樣式的內距 */
export function measureNode(text: string, style: NodeStyle, depth: number): { width: number; height: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `${style.fontWeight} ${style.fontSize}px ${FONT}`;
  const lines = (text || " ").split("\n");
  const w = Math.max(...lines.map((l) => measureCtx!.measureText(l || " ").width));
  let width = Math.max(depth === 0 ? 80 : 36, Math.ceil(w) + style.padX * 2);
  let height = Math.ceil(lines.length * style.fontSize * LINE_HEIGHT) + style.padY * 2;
  if (style.shape === "ellipse") {
    width = Math.ceil(width * 1.12);
    height = Math.ceil(height * 1.2);
  }
  return { width, height };
}

/** 自訂顏色（節點或祖先設定的），沒有設定的節點不在裡面 */
export function customColors(tree: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode, inherited?: string) => {
    const c = n.color ?? inherited;
    if (c) out.set(n.id, c);
    n.children.forEach((k) => walk(k, c));
  };
  walk(tree);
  return out;
}

export interface CanvasData {
  layout: Layout;
  theme: Theme;
  tree: TreeNode;
  /** 節點代號 → 節點（文字等） */
  nodes: Map<string, TreeNode>;
  styles: Map<string, NodeStyle>;
}

export function prepare(map: MindMap, layoutFn: (tree: TreeNode, styles: Map<string, NodeStyle>) => Layout, theme: Theme): CanvasData {
  const tree = map.tree();
  const nodes = new Map<string, TreeNode>();
  const depthOf = new Map<string, number>();
  const walk = (n: TreeNode, d: number) => {
    nodes.set(n.id, n);
    depthOf.set(n.id, d);
    n.children.forEach((c) => walk(c, d + 1));
  };
  walk(tree, 0);
  const colors = branchColors(tree, theme);
  const styles = new Map<string, NodeStyle>();
  for (const [id, d] of depthOf) styles.set(id, theme.style(d, colors.get(id)!));
  return { layout: layoutFn(tree, styles), theme, tree, nodes, styles };
}

/** dim = 拖曳中的節點（和它底下的節點），畫淡一點 */
export function MindMapContent({ data, dim }: { data: CanvasData; dim?: Set<string> }) {
  const { layout, theme, nodes, styles, tree } = data;
  const custom = customColors(tree);
  const horizontal = layout.structure === "mindmap" || layout.structure === "logic";
  const inset = theme.port && horizontal ? PORT_INSET : 0;
  const edges: JSX.Element[] = [];
  const ports: JSX.Element[] = [];
  for (const child of layout.nodes) {
    if (!child.parent) continue;
    const parent = layout.byId.get(child.parent)!;
    const underline = styles.get(child.id)!.shape === "underline";
    let d = edgePath(layout, parent, child, theme.edge, { underline, portInset: inset });
    if (theme.sketchy) {
      const j = sketchJitter(child.id);
      d = d.replace(/-?\d+(\.\d+)?/g, (m) => String(Math.round(j(Number(m)) * 10) / 10));
    }
    const color = theme.coloredLines ? styles.get(child.id)!.stroke : custom.get(child.id) ?? theme.lineColor;
    edges.push(
      <path key={child.id} d={d} fill="none" stroke={color} strokeWidth={lineWidthAt(theme, child.depth)} strokeLinecap="round" opacity={dim?.has(child.id) ? 0.3 : 1} />,
    );
    if (theme.port) {
      // 連接點：畫在線的兩端
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      const portColor = custom.get(child.id) ?? theme.port;
      // 中心主題（標籤）沒有連接點，線直接從邊上出來
      if (parent.depth) ports.push(<circle key={`s${child.id}`} cx={nums[0]} cy={nums[1]} r={3.6} fill={custom.get(parent.id) ?? theme.port} />);
      ports.push(<circle key={`e${child.id}`} cx={nums[nums.length - 2]} cy={nums[nums.length - 1]} r={3.6} fill={portColor} />);
    }
  }
  return (
    <>
      <g className="mm-edges">{edges}</g>
      <g className="mm-nodes">
        {layout.nodes.map((n) => (
          <NodeShape key={n.id} placed={n} node={nodes.get(n.id)!} style={styles.get(n.id)!} theme={theme} inset={inset} portColor={custom.get(n.id) ?? theme.port} dim={dim?.has(n.id)} structure={layout.structure} />
        ))}
      </g>
      <g className="mm-ports">{ports}</g>
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
}) {
  const { width: w, height: h } = n;
  const lines = (node.text || " ").split("\n");
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
    <g data-node={n.id} transform={`translate(${n.x} ${n.y})`} opacity={dim ? 0.35 : ghost ? 0.75 : 1} style={{ cursor: ghost ? "grabbing" : "pointer" }}>
      {shape}
      {horizontalPorts && (
        <>
          <circle cx={inset} cy={h / 2} r={3.6} fill={portColor} />
          <circle cx={w - inset} cy={h / 2} r={3.6} fill={portColor} />
        </>
      )}
      <text fill={st.text} fontSize={st.fontSize} fontWeight={st.fontWeight} fontFamily={FONT} textAnchor="middle">
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
      <g data-toggle={p.id} style={{ cursor: "pointer" }} aria-label={`展開 ${p.hidden} 個節點`}>
        <circle cx={cx} cy={cy} r={r + (label.length > 3 ? 3 : 0)} fill={t.background} stroke={t.accent} strokeWidth={1.5} />
        <text x={cx} y={cy} fontSize={10} fontWeight={700} fontFamily={FONT} fill={t.port ?? t.lineColor} textAnchor="middle" dominantBaseline="central">
          {label}
        </text>
      </g>
    );
  }
}
