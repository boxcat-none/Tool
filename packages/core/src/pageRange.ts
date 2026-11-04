import { PdfToolError } from "./errors";

/** 一組頁面（0 起算的索引），代表分割後的一個輸出檔。 */
export type PageGroup = number[];

const PART_SEPARATOR = /[,，、;；\s]+/;
const RANGE_DASH = /\s*[-–—~～]\s*/;

/**
 * 解析使用者輸入的頁碼範圍（1 起算），每個以逗號分隔的部分成為一組。
 *
 * 範例（共 10 頁）：
 * - "1-3, 5, 8-"  → [[0,1,2], [4], [7,8,9]]
 * - "-2"          → [[0,1]]
 * - "5-3"         → [[4,3,2]]（倒序也可以）
 */
export function parsePageRanges(spec: string, pageCount: number): PageGroup[] {
  const parts = spec
    .replace(new RegExp(RANGE_DASH.source, "g"), "-")
    .split(PART_SEPARATOR)
    .filter(Boolean);
  if (parts.length === 0) {
    throw new PdfToolError("INVALID_RANGE", "請輸入頁碼範圍，例如：1-3, 5, 8-");
  }
  return parts.map((part) => parsePart(part, pageCount));
}

function parsePart(part: string, pageCount: number): PageGroup {
  const pieces = part.split(RANGE_DASH);
  if (pieces.length > 2 || !pieces.every((p) => p === "" || /^\d+$/.test(p))) {
    throw new PdfToolError("INVALID_RANGE", `看不懂「${part}」，請用像 1-3 或 5 這樣的格式。`);
  }

  let start: number;
  let end: number;
  if (pieces.length === 1) {
    if (pieces[0] === "") throw invalid(part);
    start = end = Number(pieces[0]);
  } else {
    if (pieces[0] === "" && pieces[1] === "") throw invalid(part);
    start = pieces[0] === "" ? 1 : Number(pieces[0]);
    end = pieces[1] === "" ? pageCount : Number(pieces[1]);
  }

  for (const n of [start, end]) {
    if (n < 1 || n > pageCount) {
      throw new PdfToolError(
        "INVALID_RANGE",
        `頁碼 ${n} 超出範圍，這份文件只有 ${pageCount} 頁。`,
      );
    }
  }

  const step = start <= end ? 1 : -1;
  const group: PageGroup = [];
  for (let n = start; n !== end + step; n += step) group.push(n - 1);
  return group;
}

function invalid(part: string): PdfToolError {
  return new PdfToolError("INVALID_RANGE", `看不懂「${part}」，請用像 1-3 或 5 這樣的格式。`);
}

/** 每頁一組。 */
export function groupsEachPage(pageCount: number): PageGroup[] {
  return Array.from({ length: pageCount }, (_, i) => [i]);
}

/** 每 n 頁一組，最後一組可能不足 n 頁。 */
export function groupsEveryN(pageCount: number, n: number): PageGroup[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new PdfToolError("INVALID_RANGE", "每份頁數必須是大於 0 的整數。");
  }
  const groups: PageGroup[] = [];
  for (let start = 0; start < pageCount; start += n) {
    groups.push(
      Array.from({ length: Math.min(n, pageCount - start) }, (_, i) => start + i),
    );
  }
  return groups;
}

/** 把一組頁面描述成給人看的文字，例如 [0,1,2] → "1-3"、[4] → "5"。 */
export function describeGroup(group: PageGroup): string {
  const runs: string[] = [];
  let i = 0;
  while (i < group.length) {
    let j = i;
    const step = group[i + 1] - group[i];
    if (step === 1 || step === -1) {
      while (j + 1 < group.length && group[j + 1] - group[j] === step) j++;
    }
    runs.push(i === j ? `${group[i] + 1}` : `${group[i] + 1}-${group[j] + 1}`);
    i = j + 1;
  }
  return runs.join(",");
}
