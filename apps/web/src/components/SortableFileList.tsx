import { useState } from "react";

export interface ListItem {
  id: number;
  name: string;
  /** 第二行說明，例如大小與頁數 */
  meta: string;
  error?: string;
  /** 縮圖網址（圖片轉 PDF 用） */
  thumb?: string;
}

interface Props {
  items: ListItem[];
  onMove: (from: number, to: number) => void;
  onRemove: (id: number) => void;
}

/** 可以拖拉或用按鈕調整順序的檔案清單。 */
export function SortableFileList({ items, onMove, onRemove }: Props) {
  const [dragId, setDragId] = useState<number | null>(null);

  return (
    <ol className="files">
      {items.map((it, index) => (
        <li
          key={it.id}
          className={`file${it.error ? " file--error" : ""}${dragId === it.id ? " file--dragging" : ""}`}
          draggable
          onDragStart={(e) => {
            setDragId(it.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDragId(null)}
          onDragOver={(e) => {
            if (dragId === null) return;
            e.preventDefault();
            const from = items.findIndex((x) => x.id === dragId);
            if (from !== index) onMove(from, index);
          }}
        >
          <span className="file__grip" aria-hidden="true">⋮⋮</span>
          <span className="file__index">{index + 1}</span>
          {it.thumb && <img className="file__thumb" src={it.thumb} alt="" draggable={false} />}
          <span className="file__main">
            <span className="file__name" title={it.name}>{it.name}</span>
            <span className="file__meta">{it.error ?? it.meta}</span>
          </span>
          <span className="file__actions">
            <button type="button" className="icon" aria-label={`把 ${it.name} 往上移`} disabled={index === 0} onClick={() => onMove(index, index - 1)}>↑</button>
            <button type="button" className="icon" aria-label={`把 ${it.name} 往下移`} disabled={index === items.length - 1} onClick={() => onMove(index, index + 1)}>↓</button>
            <button type="button" className="icon icon--danger" aria-label={`移除 ${it.name}`} onClick={() => onRemove(it.id)}>✕</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 搬移陣列中的一個元素，回傳新陣列。 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}
