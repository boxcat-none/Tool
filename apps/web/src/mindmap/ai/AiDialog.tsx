import { buildDiagram, buildMindMap, buildPrompt, parseMarkdown, type DiagramKind, type MindMap } from "@tool/mindmap";
import { useEffect, useRef, useState } from "react";
import { apiBase, chat, listModels, loadAiSettings, saveAiSettings, type AiSettings } from "./client";
import { AI_FILE_ACCEPT, extractFile, type Extracted } from "./extract";

/**
 * 用自己的語言模型把文字、文件、圖片轉成架構圖或流程圖。
 * 也可以不用模型：直接照文件的標題與清單轉成架構圖。
 */

interface Props {
  onCreate: (map: MindMap) => Promise<void>;
  onClose: () => void;
}

export function AiDialog({ onCreate, onClose }: Props) {
  const [kind, setKind] = useState<DiagramKind>("mind");
  const [useModel, setUseModel] = useState(true);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Extracted[]>([]);
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => !loadAiSettings().model);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => saveAiSettings(settings), [settings]);
  useEffect(() => () => busy?.abort(), [busy]);

  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const addFiles = async (list: FileList) => {
    setError(null);
    for (const f of Array.from(list)) {
      setStatus(`正在讀取「${f.name}」…`);
      try {
        const x = await extractFile(f, settings.vision);
        setFiles((cur) => [...cur, x]);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    setStatus(null);
  };

  const test = async () => {
    setError(null);
    setStatus("正在連線…");
    const ac = new AbortController();
    try {
      const list = await listModels(settings, ac.signal);
      setModels(list);
      if (!settings.model && list[0]) set("model", list[0]);
      setStatus(list.length ? `連線成功：伺服器上有 ${list.length} 個模型` : "連線成功，但伺服器沒有列出模型（請自己填模型名稱）");
    } catch (e) {
      setStatus(null);
      setError((e as Error).message);
    }
  };

  const content = [text.trim(), ...files.map((f) => (files.length > 1 || text.trim() ? `【${f.name}】\n${f.text}` : f.text))].filter(Boolean).join("\n\n");
  const images = files.flatMap((f) => f.images);
  const title = files[0]?.name.replace(/\.[^.]+$/, "") || (kind === "flow" ? "流程圖" : "架構圖");
  const tooLong = content.length > settings.maxChars;

  const generate = async () => {
    setError(null);
    if (!content && !images.length) {
      setError("請先貼上文字或加入檔案");
      return;
    }
    if (!useModel) {
      try {
        await onCreate(buildMindMap(parseMarkdown(content, title, { paragraphs: true })));
      } catch (e) {
        setError((e as Error).message.includes("讀不到內容") ? "這份內容沒有標題或清單結構，請改用 AI 模型產生" : (e as Error).message);
      }
      return;
    }
    const ac = new AbortController();
    setBusy(ac);
    setStatus("模型正在整理內容…（依模型大小可能要幾十秒）");
    try {
      const body = tooLong ? content.slice(0, settings.maxChars) : content;
      const answer = await chat(settings, buildPrompt(kind, body, images), ac.signal);
      setStatus("正在建立圖…");
      await onCreate(buildDiagram(kind, answer, title));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(null);
    }
  };

  let endpoint = "";
  try {
    endpoint = apiBase(settings.baseUrl);
  } catch {
    endpoint = "（網址格式不對）";
  }

  return (
    <div className="mm-dialog__backdrop mm-dialog__backdrop--fixed">
      <div
        className="mm-dialog mm-ai"
        role="dialog"
        aria-label="AI 產生架構圖或流程圖"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <h2>AI 產生架構圖／流程圖</h2>

        <fieldset className="mm-ai__row">
          <legend>要產生</legend>
          <label>
            <input type="radio" name="mm-ai-kind" checked={kind === "mind"} onChange={() => setKind("mind")} />
            架構圖（心智圖）
          </label>
          <label>
            <input type="radio" name="mm-ai-kind" checked={kind === "flow"} onChange={() => { setKind("flow"); setUseModel(true); }} />
            流程圖
          </label>
        </fieldset>

        <label className="mm-ai__block">
          <span className="mm-ai__label">內容</span>
          <textarea aria-label="要轉換的文字" rows={6} placeholder="貼上文字，或在下面加入檔案…" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="mm-ai__files">
          <button type="button" className="mm-btn" onClick={() => fileInput.current?.click()} disabled={!!busy}>
            加入檔案…
          </button>
          <span className="mm-ai__hint">PDF、Word（.docx）、PowerPoint（.pptx）、HTML、文字／Markdown、筆記本（.guganote）{settings.vision ? "、圖片" : ""}</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={AI_FILE_ACCEPT}
            aria-label="選擇要轉換的檔案"
            onChange={(e) => {
              const l = e.target.files;
              if (l?.length) void addFiles(l);
              e.target.value = "";
            }}
          />
          {files.length > 0 && (
            <ul aria-label="已加入的檔案">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  {f.name}（{f.images.length ? "圖片" : `${f.text.length.toLocaleString()} 字`}）
                  <button type="button" className="mm-ai__remove" aria-label={`移除「${f.name}」`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <fieldset className="mm-ai__row">
          <legend>方式</legend>
          <label>
            <input type="radio" name="mm-ai-mode" checked={useModel} onChange={() => setUseModel(true)} />
            用 AI 模型整理
          </label>
          <label className={kind === "flow" ? "is-disabled" : undefined}>
            <input type="radio" name="mm-ai-mode" checked={!useModel} disabled={kind === "flow"} onChange={() => setUseModel(false)} />
            不用 AI：照標題、清單與段落轉換
          </label>
        </fieldset>

        {useModel && (
          <details className="mm-ai__settings" open={settingsOpen} onToggle={(e) => setSettingsOpen((e.target as HTMLDetailsElement).open)}>
            <summary>AI 模型設定{settings.model ? `（${settings.model}）` : "（尚未設定）"}</summary>
            <label>
              <span>伺服器網址</span>
              <input aria-label="模型伺服器網址" value={settings.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://localhost:11434/v1" />
            </label>
            <label>
              <span>模型名稱</span>
              <input aria-label="模型名稱" list="mm-ai-models" value={settings.model} onChange={(e) => set("model", e.target.value)} placeholder="例如 my-model:latest" />
              <datalist id="mm-ai-models">
                {models.map((m) => <option key={m} value={m} />)}
              </datalist>
            </label>
            <label>
              <span>API 金鑰</span>
              <input aria-label="API 金鑰" type="password" autoComplete="off" value={settings.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="沒有設定就留空" />
            </label>
            <label className="mm-ai__check">
              <input type="checkbox" checked={settings.vision} onChange={(e) => set("vision", e.target.checked)} />
              模型看得懂圖片（多模態）
            </label>
            <label>
              <span>最多送出字數</span>
              <input aria-label="最多送出字數" type="number" min={1000} step={1000} value={settings.maxChars} onChange={(e) => set("maxChars", Math.max(1000, Number(e.target.value) || 16000))} />
            </label>
            <div className="mm-ai__test">
              <button type="button" className="mm-btn" onClick={() => void test()} disabled={!!busy}>測試連線</button>
              <span className="mm-ai__hint">送到 {endpoint}；設定只存在這台裝置</span>
            </div>
          </details>
        )}

        {tooLong && useModel && <p className="mm-ai__hint">內容有 {content.length.toLocaleString()} 字，只會送出前 {settings.maxChars.toLocaleString()} 字（可以在設定裡調整）</p>}
        {status && <p className="mm-ai__status" role="status">{status}</p>}
        {error && <p className="mm-ai__error" role="alert">{error}</p>}

        <div className="mm-dialog__actions">
          {busy ? (
            <button type="button" className="mm-btn" onClick={() => busy.abort()}>停止</button>
          ) : (
            <button type="button" className="mm-btn" onClick={onClose}>取消</button>
          )}
          <button type="button" className="mm-btn mm-btn--primary" disabled={!!busy} onClick={() => void generate()}>
            {busy ? "產生中…" : "產生"}
          </button>
        </div>
      </div>
    </div>
  );
}
