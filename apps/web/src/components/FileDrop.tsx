import { useRef, useState, type DragEvent } from "react";

interface Props {
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  title: string;
  hint?: string;
  compact?: boolean;
}

/** 拖放或點擊選擇 PDF 檔案。 */
export function FileDrop({ multiple = false, onFiles, title, hint, compact = false }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      className={`drop${over ? " drop--over" : ""}${compact ? " drop--compact" : ""}`}
      onDragOver={(e) => {
        // 只回應從外部拖進來的檔案，不干擾清單內的排序拖拉
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
    >
      <svg className="drop__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <div className="drop__title">{title}</div>
      {hint && <div className="drop__hint">{hint}</div>}
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}
