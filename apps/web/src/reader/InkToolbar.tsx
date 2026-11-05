import type { InkSettings, Tool } from "./ink";

export const PEN_COLORS = ["#1f2937", "#1e40af", "#dc2626", "#15803d", "#7c3aed"];
export const HIGHLIGHTER_COLORS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa"];
/** 粗細（pt，中等筆壓時） */
export const PEN_SIZES = [1, 1.8, 3];
export const HIGHLIGHTER_SIZES = [8, 14, 20];

const COLOR_NAMES: Record<string, string> = {
  "#1f2937": "黑色",
  "#1e40af": "藍色",
  "#dc2626": "紅色",
  "#15803d": "綠色",
  "#7c3aed": "紫色",
  "#facc15": "黃色",
  "#4ade80": "綠色",
  "#f472b6": "粉紅色",
  "#60a5fa": "藍色",
};

const TOOLS: { tool: Tool; label: string; key: string; icon: JSX.Element }[] = [
  {
    tool: "read",
    label: "閱讀（選取文字）",
    key: "V",
    icon: <path d="M6 3.5 18 13l-5.2.8 3 6-2.4 1.1-3-6L6 18.5Z" />,
  },
  {
    tool: "pen",
    label: "鋼筆",
    key: "P",
    icon: <path d="m15.5 4.5 4 4L8.8 19.2 4 20l.8-4.8Zm-2 2 4 4" />,
  },
  {
    tool: "highlighter",
    label: "螢光筆",
    key: "H",
    icon: <path d="m14 5 5 5-7.5 7.5-5-5Zm-7.5 7.5L4 15l1 3 3 1 2.5-2.5M3 21h8" />,
  },
  {
    tool: "eraser",
    label: "橡皮擦（整筆擦除）",
    key: "E",
    icon: <path d="m9 19.5 11-11-4.5-4.5-11 11 4.5 4.5h11M6.8 12.7l4.5 4.5" />,
  },
  {
    tool: "select",
    label: "選取（圈選筆跡與圖片、移動、縮放、刪除）",
    key: "S",
    icon: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9Z" />,
  },
];

interface Props {
  settings: InkSettings;
  onChange: (patch: Partial<InkSettings>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onInsertImage: () => void;
  /** 存成 .guganote 檔 */
  onSave: () => void;
  /** 不能匯出時的原因（例如有密碼的 PDF） */
  exportBlocked?: string;
  exporting: boolean;
}

export function InkToolbar({ settings, onChange, canUndo, canRedo, onUndo, onRedo, onExport, onInsertImage, onSave, exportBlocked, exporting }: Props) {
  const { tool } = settings;
  const isHl = tool === "highlighter";
  const colors = isHl ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const sizes = isHl ? HIGHLIGHTER_SIZES : PEN_SIZES;
  const color = isHl ? settings.highlighterColor : settings.penColor;
  const size = isHl ? settings.highlighterSize : settings.penSize;
  const setColor = (c: string) => onChange(isHl ? { highlighterColor: c } : { penColor: c });
  const setSize = (s: number) => onChange(isHl ? { highlighterSize: s } : { penSize: s });

  return (
    <div className="ink-toolbar" role="toolbar" aria-label="筆記工具">
      <span className="ink-toolbar__group" role="radiogroup" aria-label="工具">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            role="radio"
            aria-checked={tool === t.tool}
            className={`icon ink-tool${tool === t.tool ? " icon--on" : ""}`}
            aria-label={`${t.label}（${t.key}）`}
            title={`${t.label}（${t.key}）`}
            onClick={() => onChange({ tool: t.tool })}
          >
            <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true">{t.icon}</svg>
          </button>
        ))}
      </span>

      <span className="ink-toolbar__sep" />
      <button type="button" className="icon" aria-label="插入圖片" title="插入圖片（也可以直接貼上：Ctrl+V）" onClick={onInsertImage}>
        <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-5 4 4 2.5-2.5L20 17" /></svg>
      </button>

      {(tool === "pen" || tool === "highlighter") && (
        <>
          <span className="ink-toolbar__sep" />
          <span className="ink-toolbar__group" role="radiogroup" aria-label="顏色">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={COLOR_NAMES[c] ?? c}
                className={`swatch${color === c ? " swatch--on" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
            <label className={`swatch swatch--custom${colors.includes(color) ? "" : " swatch--on"}`} title="自訂顏色" style={colors.includes(color) ? undefined : { background: color }}>
              <input type="color" aria-label="自訂顏色" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </span>
          <span className="ink-toolbar__sep" />
          <span className="ink-toolbar__group" role="radiogroup" aria-label="粗細">
            {sizes.map((s, i) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={size === s}
                aria-label={["細", "中", "粗"][i]}
                className={`icon size-dot${size === s ? " icon--on" : ""}`}
                onClick={() => setSize(s)}
              >
                <span style={{ width: 4 + i * 4, height: 4 + i * 4, background: color }} />
              </button>
            ))}
          </span>
        </>
      )}

      <span className="ink-toolbar__sep" />
      <span className="ink-toolbar__group">
        <button type="button" className="icon" aria-label="復原（Ctrl+Z）" title="復原（Ctrl+Z）" disabled={!canUndo} onClick={onUndo}>
          <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4.5 11.5 9 16M5 11.5h9a5 5 0 0 1 0 10h-3" /></svg>
        </button>
        <button type="button" className="icon" aria-label="重做（Ctrl+Shift+Z）" title="重做（Ctrl+Shift+Z）" disabled={!canRedo} onClick={onRedo}>
          <svg className="icon__svg" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 7 4.5 4.5L15 16m4-4.5h-9a5 5 0 0 0 0 10h3" /></svg>
        </button>
      </span>

      <label className="ink-toolbar__check" title="開啟後只有觸控筆會畫線，手指與手掌不會">
        <input type="checkbox" checked={settings.penOnly} onChange={(e) => onChange({ penOnly: e.target.checked })} />
        只用觸控筆
      </label>

      <span className="reader__spacer" />
      <button type="button" className="btn ink-toolbar__export" title="把整本筆記本（含原始 PDF 與筆跡）存成一個檔案，可以備份或帶到其他裝置（Ctrl+S）" onClick={onSave}>
        存成 .guganote
      </button>
      <button
        type="button"
        className="btn ink-toolbar__export"
        disabled={!!exportBlocked || exporting}
        title={exportBlocked ?? "把筆跡合併進頁面，匯出成 PDF"}
        onClick={onExport}
      >
        {exporting ? "匯出中…" : "匯出 PDF"}
      </button>
    </div>
  );
}
