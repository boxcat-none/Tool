import * as Y from "yjs";
import { MindMap } from "./model";

/**
 * 心智圖檔（.gugamap）：JSON，裡面是 Yjs 文件的完整內容（base64），另附一份大綱方便直接看。
 * 用 Yjs 內容而不是自訂格式：開回來之後還是同一份文件，之後可以和其他裝置合併。
 */

export const MINDMAP_EXTENSION = ".gugamap";
const FORMAT = "gugamap";
const VERSION = 1;

export function saveMindMapFile(map: MindMap): string {
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    title: map.title,
    outline: map.toMarkdown(),
    doc: toBase64(Y.encodeStateAsUpdate(map.doc)),
  });
}

export function openMindMapFile(text: string): MindMap {
  let data: { format?: string; version?: number; doc?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("這不是心智圖檔（.gugamap）");
  }
  if (data.format !== FORMAT || typeof data.doc !== "string") throw new Error("這不是心智圖檔（.gugamap）");
  if ((data.version ?? 0) > VERSION) throw new Error("這個心智圖檔是新版程式存的，請更新後再開啟");
  const map = new MindMap();
  Y.applyUpdate(map.doc, fromBase64(data.doc));
  if (!map.rootId || !map.has(map.rootId)) throw new Error("心智圖檔已損毀（找不到中心主題）");
  return map;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
