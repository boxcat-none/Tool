import type { ChatMessage } from "@tool/mindmap";

/**
 * 連到使用者自己的語言模型：OpenAI 相容的 API（Ollama、LM Studio、vLLM、llama.cpp server…）。
 *   POST {網址}/chat/completions   產生
 *   GET  {網址}/models             列出模型（測試連線）
 * 設定存在這台裝置（localStorage），不會傳到其他地方。
 */

export interface AiSettings {
  /** 例如 http://localhost:11434/v1（Ollama）、http://localhost:1234/v1（LM Studio） */
  baseUrl: string;
  model: string;
  /** 自己架的伺服器有設金鑰才需要 */
  apiKey: string;
  /** 模型看得懂圖片（多模態）：圖片直接傳給模型 */
  vision: boolean;
  /** 最多送出幾個字（太長的文件會截斷，模型的上下文有限） */
  maxChars: number;
}

export const DEFAULT_AI: AiSettings = { baseUrl: "http://localhost:11434/v1", model: "", apiKey: "", vision: false, maxChars: 16000 };

const KEY = "guganote-ai-settings";

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_AI, ...(JSON.parse(raw) as Partial<AiSettings>) };
  } catch {
    // 私密瀏覽等：用預設
  }
  return { ...DEFAULT_AI };
}

export function saveAiSettings(s: AiSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 存不了就算了（下次要重新輸入）
  }
}

/** 網址補成 …/v1（只填 http://localhost:11434 也可以） */
export function apiBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.pathname === "/" || parsed.pathname === "") u = `${u}/v1`;
  } catch {
    throw new Error("模型網址格式不對，例如 http://localhost:11434/v1");
  }
  return u.replace(/\/chat\/completions$/, "");
}

function headers(s: AiSettings): HeadersInit {
  return { "Content-Type": "application/json", ...(s.apiKey.trim() ? { Authorization: `Bearer ${s.apiKey.trim()}` } : {}) };
}

function connectError(s: AiSettings): Error {
  const origin = typeof location !== "undefined" ? location.origin : "";
  return new Error(
    `連不到模型伺服器（${apiBase(s.baseUrl)}）。請確認：① 伺服器已啟動；② 允許這個網頁連線（Ollama 要設定環境變數 OLLAMA_ORIGINS=${origin}，LM Studio 要開啟 CORS）；③ 網址與連接埠正確。`,
  );
}

async function errorText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string } | string };
      const m = typeof j.error === "string" ? j.error : j.error?.message;
      if (m) return m.slice(0, 300);
    } catch {
      // 不是 JSON
    }
    return t.slice(0, 300);
  } catch {
    return "";
  }
}

/** 列出伺服器上的模型（測試連線） */
export async function listModels(s: AiSettings, signal?: AbortSignal): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(s.baseUrl)}/models`, { headers: headers(s), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw connectError(s);
  }
  if (!res.ok) throw new Error(`模型伺服器回應錯誤（${res.status}）：${await errorText(res)}`);
  const j = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string; model?: string }[] };
  return [...(j.data ?? []).map((m) => m.id ?? ""), ...(j.models ?? []).map((m) => m.name ?? m.model ?? "")].filter(Boolean);
}

/** 送出對話，回傳模型的回答文字。先要求 JSON 格式；伺服器不支援時改用一般模式再試一次 */
export async function chat(s: AiSettings, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  if (!s.model.trim()) throw new Error("請先在「AI 模型設定」填模型名稱（可以按「測試連線」列出伺服器上的模型）");
  const url = `${apiBase(s.baseUrl)}/chat/completions`;
  const send = async (json: boolean) => {
    try {
      return await fetch(url, {
        method: "POST",
        headers: headers(s),
        signal,
        body: JSON.stringify({
          model: s.model.trim(),
          messages,
          temperature: 0.2,
          stream: false,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw connectError(s);
    }
  };
  let res = await send(true);
  if (!res.ok && [400, 404, 415, 422, 500].includes(res.status)) res = await send(false);
  if (!res.ok) throw new Error(`模型伺服器回應錯誤（${res.status}）：${await errorText(res)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string | { text?: string }[] } }[] };
  const content = j.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";
  if (!text.trim()) throw new Error("模型沒有回答任何內容");
  return text;
}
