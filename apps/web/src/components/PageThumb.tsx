import { useEffect, useRef, useState } from "react";
import type { ThumbnailDoc } from "../lib/thumbnails";

interface Props {
  doc: ThumbnailDoc;
  /** 頁面索引（0 起算） */
  index: number;
  /** 額外旋轉角度（可累計，例如 450 = 轉一圈再 90°，用於旋轉動畫） */
  spin?: number;
  className?: string;
}

/** 頁面縮圖：捲動到附近才開始畫，大文件也不會一次畫完所有頁面。 */
export function PageThumb({ doc, index, spin = 0, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        doc.get(index).then((u) => !cancelled && setUrl(u)).catch(() => undefined);
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [doc, index]);

  return (
    <span ref={ref} className={className}>
      {url ? (
        <img src={url} alt="" draggable={false} style={spin ? { transform: `rotate(${spin}deg)` } : undefined} />
      ) : (
        <span className="spinner" aria-hidden="true" />
      )}
    </span>
  );
}
