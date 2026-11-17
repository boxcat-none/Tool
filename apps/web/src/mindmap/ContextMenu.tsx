import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 右鍵選單（觸控時長按）。項目：
 *   action   一般按鈕（按了關閉選單）
 *   choices  一列選項（按了選單不關，可以接著調整其他項目）（例如線型：預設／曲線／直角／直線），目前的值會標示
 *   colors   一列顏色
 *   label    小標題
 */
export type MenuItem =
  | { kind: "action"; label: string; onSelect: () => void; danger?: boolean; hint?: string; disabled?: boolean }
  | { kind: "choices"; label: string; options: { label: string; value: string }[]; value: string; onSelect: (value: string) => void }
  | { kind: "colors"; label: string; options: { label: string; value: string | null }[]; value: string | null; onSelect: (value: string | null) => void }
  | { kind: "separator" };

export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 不要超出畫布：放不下就往左／往上
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement?.getBoundingClientRect();
    if (!el || !host) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({
      left: Math.max(4, Math.min(x, host.width - w - 4)),
      top: Math.max(4, y + h > host.height - 4 ? Math.max(4, y - h) : y),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // 下一個 tick 才開始監聽，開啟選單的那次點擊不算
    const t = setTimeout(() => {
      window.addEventListener("pointerdown", close, true);
      window.addEventListener("wheel", close, true);
    }, 0);
    window.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div
      ref={ref}
      className="mm-menu"
      role="menu"
      aria-label={title ?? "操作選單"}
      style={pos}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && <div className="mm-menu__title">{title}</div>}
      {items.map((it, i) => {
        if (it.kind === "separator") return <div key={i} className="mm-menu__sep" role="separator" />;
        if (it.kind === "action") {
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`mm-menu__item${it.danger ? " mm-menu__item--danger" : ""}`}
              disabled={it.disabled}
              onClick={() => run(it.onSelect)}
            >
              <span>{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          );
        }
        if (it.kind === "choices") {
          return (
            <div key={i} className="mm-menu__row" role="group" aria-label={it.label}>
              <span className="mm-menu__label">{it.label}</span>
              <span className="mm-menu__choices">
                {it.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={o.value === it.value}
                    className={`mm-menu__choice${o.value === it.value ? " mm-menu__choice--on" : ""}`}
                    onClick={() => it.onSelect(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </span>
            </div>
          );
        }
        return (
          <div key={i} className="mm-menu__row" role="group" aria-label={it.label}>
            <span className="mm-menu__label">{it.label}</span>
            <span className="mm-menu__choices">
              {it.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={o.value === it.value}
                  aria-label={o.label}
                  title={o.label}
                  className={`mm-menu__swatch${o.value === it.value ? " mm-menu__swatch--on" : ""}${o.value ? "" : " mm-menu__swatch--none"}`}
                  style={o.value ? { background: o.value } : undefined}
                  onClick={() => it.onSelect(o.value)}
                />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
