import type { EdgeStyle } from "./layout";
import type { TreeNode } from "./model";

/**
 * 視覺樣式（主題）。同一張心智圖換主題只改外觀，不改內容與結構。
 *
 *   rainbow  彩虹曲線：每條第一層分支一種顏色，線越往外越細
 *   minimal  極簡線條：灰色細線，文字放在底線上
 *   boxed    方框直角：方框＋直角連接線，像正式報告
 *   sketch   手繪便利貼：便利貼顏色、稍微歪斜、線條有手繪感
 *   node     節點卡片：深色畫布、圓角深色卡片，左右有連接點，細的 S 形曲線從連接點拉出；中心主題是亮色標籤
 */

export type NodeShape = "pill" | "rounded" | "rect" | "underline" | "ellipse" | "sticky" | "card" | "tag";

export interface NodeStyle {
  shape: NodeShape;
  /** 底色；"none" = 透明 */
  fill: string;
  stroke: string;
  strokeWidth: number;
  text: string;
  fontSize: number;
  fontWeight: 400 | 500 | 700;
  padX: number;
  padY: number;
}

export interface Theme {
  id: string;
  label: string;
  edge: EdgeStyle;
  /** 第一層分支依序使用的顏色 */
  palette: string[];
  /** 分支顏色是否用在線上（否 = 線一律用 lineColor） */
  coloredLines: boolean;
  lineColor: string;
  /** 第一層分支的線寬；taper = 每深一層變細 */
  lineWidth: number;
  taper: boolean;
  /** 線條加一點抖動（手繪感） */
  sketchy: boolean;
  /** 畫布底色 */
  background: string;
  /** 卡片左右的連接點（顏色）；線從連接點拉出。沒有 = 線接在框的邊上 */
  port?: string;
  /** 選取框、拖曳提示的顏色（深色畫布要用亮色） */
  accent: string;
  style(depth: number, branchColor: string): NodeStyle;
}

const base = { strokeWidth: 1.5, fontWeight: 400 as const, padX: 12, padY: 7 };

export const THEMES: Theme[] = [
  {
    id: "rainbow",
    label: "A 彩虹曲線",
    edge: "curve",
    palette: ["#e8590c", "#0c8599", "#7048e8", "#e67700", "#c2255c", "#2b8a3e", "#1971c2"],
    coloredLines: true,
    lineColor: "#495057",
    lineWidth: 4,
    taper: true,
    sketchy: false,
    background: "#ffffff",
    accent: "#228be6",
    style(depth, color) {
      if (depth === 0) return { ...base, shape: "pill", fill: "#212529", stroke: "none", text: "#ffffff", fontSize: 20, fontWeight: 700, padX: 22, padY: 12 };
      if (depth === 1) return { ...base, shape: "rounded", fill: color, stroke: "none", text: "#ffffff", fontSize: 16, fontWeight: 500, padX: 14, padY: 8 };
      return { ...base, shape: "underline", fill: "none", stroke: color, strokeWidth: 2, text: "#212529", fontSize: 14, padX: 4, padY: 5 };
    },
  },
  {
    id: "minimal",
    label: "B 極簡線條",
    edge: "curve",
    palette: ["#868e96"],
    coloredLines: false,
    lineColor: "#868e96",
    lineWidth: 1.2,
    taper: false,
    sketchy: false,
    background: "#ffffff",
    accent: "#228be6",
    style(depth) {
      if (depth === 0) return { ...base, shape: "rounded", fill: "none", stroke: "#495057", strokeWidth: 1.2, text: "#212529", fontSize: 18, fontWeight: 500, padX: 16, padY: 9 };
      return { ...base, shape: "underline", fill: "none", stroke: "#868e96", strokeWidth: 1.2, text: "#343a40", fontSize: depth === 1 ? 15 : 14, padX: 4, padY: 5 };
    },
  },
  {
    id: "boxed",
    label: "C 方框直角",
    edge: "elbow",
    palette: ["#1c4f9c"],
    coloredLines: false,
    lineColor: "#1c4f9c",
    lineWidth: 1.5,
    taper: false,
    sketchy: false,
    background: "#ffffff",
    accent: "#228be6",
    style(depth) {
      if (depth === 0) return { ...base, shape: "rect", fill: "#1c4f9c", stroke: "none", text: "#ffffff", fontSize: 18, fontWeight: 700, padX: 18, padY: 10 };
      if (depth === 1) return { ...base, shape: "rect", fill: "#dbe7fb", stroke: "#1c4f9c", text: "#12346a", fontSize: 15, fontWeight: 500 };
      return { ...base, shape: "rect", fill: "#ffffff", stroke: "#8fb0e3", strokeWidth: 1, text: "#1f2937", fontSize: 14, padX: 10, padY: 6 };
    },
  },
  {
    id: "sketch",
    label: "D 手繪便利貼",
    edge: "curve",
    palette: ["#ffe08a", "#ffc9de", "#bcdcff", "#c3f0c8", "#e0d4ff"],
    coloredLines: false,
    lineColor: "#57534e",
    lineWidth: 1.6,
    taper: false,
    sketchy: true,
    background: "#fffdf7",
    accent: "#228be6",
    style(depth, color) {
      if (depth === 0) return { ...base, shape: "ellipse", fill: "#ffd43b", stroke: "#44403c", strokeWidth: 1.6, text: "#292524", fontSize: 19, fontWeight: 700, padX: 26, padY: 14 };
      if (depth === 1) return { ...base, shape: "sticky", fill: color, stroke: "none", text: "#292524", fontSize: 15, fontWeight: 500, padX: 14, padY: 10 };
      return { ...base, shape: "underline", fill: "none", stroke: "#78716c", strokeWidth: 1.4, text: "#292524", fontSize: 14, padX: 4, padY: 5 };
    },
  },
  {
    id: "node",
    label: "E 節點卡片",
    edge: "curve",
    palette: ["#e9f55b"],
    coloredLines: false,
    lineColor: "#c9d44a",
    lineWidth: 1.4,
    taper: false,
    sketchy: false,
    background: "#1e1b24",
    port: "#e9f55b",
    accent: "#e9f55b",
    style(depth) {
      if (depth === 0) return { ...base, shape: "tag", fill: "#e9f55b", stroke: "none", text: "#1e1b24", fontSize: 22, fontWeight: 700, padX: 26, padY: 12 };
      // 卡片左右留空間給連接點
      if (depth === 1) return { ...base, shape: "card", fill: "#2a2730", stroke: "#3d3945", strokeWidth: 1, text: "#f1f0f4", fontSize: 15, fontWeight: 500, padX: 30, padY: 14 };
      return { ...base, shape: "card", fill: "#25222b", stroke: "#38343f", strokeWidth: 1, text: "#d6d3dd", fontSize: 14, padX: 28, padY: 10 };
    },
  },
];

/** 連接點離卡片左右邊緣的距離（px） */
export const PORT_INSET = 13;

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** 每個節點的分支顏色：第一層（和獨立元件）依序用主題的顏色；節點有自訂顏色時，它和它底下都用那個顏色 */
export function branchColors(tree: TreeNode, theme: Theme, floating: TreeNode[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode, color: string) => {
    const c = n.color ?? color;
    out.set(n.id, c);
    for (const k of n.children) walk(k, c);
  };
  out.set(tree.id, tree.color ?? theme.palette[0]);
  tree.children.forEach((c, i) => walk(c, theme.palette[i % theme.palette.length]));
  // 獨立元件接在第一層分支後面輪流用顏色
  floating.forEach((f, i) => walk(f, theme.palette[(tree.children.length + i) % theme.palette.length]));
  return out;
}

/** 線寬：taper 時第一層最粗，每深一層變細，最細 1.2 */
export function lineWidthAt(theme: Theme, depth: number): number {
  if (!theme.taper) return theme.lineWidth;
  return Math.max(1.2, theme.lineWidth * Math.pow(0.65, depth - 1));
}

/** 手繪感：把路徑上的點稍微抖動（用節點代號當種子，每次重畫都一樣，不會閃動） */
export function sketchJitter(seed: string): (v: number) => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (v: number) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return v + (((h >>> 0) % 1000) / 1000 - 0.5) * 3;
  };
}

/** 便利貼的歪斜角度（-3～3 度，依代號固定） */
export function stickyTilt(id: string): number {
  const j = sketchJitter(id);
  return Math.round(j(0) * 2 * 10) / 10;
}
