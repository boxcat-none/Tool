import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from "pdf-lib";

/**
 * PDF 目錄（書籤）的讀寫。筆記本插頁、刪頁、調整順序後重新產生 PDF 時，
 * 把原始 PDF 的目錄搬過去，目標頁對應到新的頁碼。
 */

export interface OutlineItem {
  title: PDFString | PDFHexString;
  /** 目標頁在原始 PDF 的索引；沒有目標或解析不到時為 null */
  target: number | null;
  /** 目標頁之後的參數（例如 /XYZ 左 上 縮放），原樣保留 */
  view: PDFObject[];
  open: boolean;
  children: OutlineItem[];
}

const N = (s: string) => PDFName.of(s);

/** 讀出目錄樹（以頁面索引表示目標） */
export function readOutline(doc: PDFDocument): OutlineItem[] {
  const ctx = doc.context;
  const root = doc.catalog.lookupMaybe(N("Outlines"), PDFDict);
  if (!root) return [];
  const pageIndex = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));
  const named = namedDestinations(doc);
  const seen = new Set<PDFDict>();

  const resolveDest = (raw: PDFObject | undefined): { target: number | null; view: PDFObject[] } => {
    let dest = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
    // 具名目的地：字串或名稱
    if (dest instanceof PDFString || dest instanceof PDFHexString) dest = named.get(dest.decodeText());
    else if (dest instanceof PDFName) dest = named.get(dest.decodeText());
    if (dest instanceof PDFRef) dest = ctx.lookup(dest);
    if (dest instanceof PDFDict) dest = dest.lookup(N("D"));
    if (!(dest instanceof PDFArray) || dest.size() === 0) return { target: null, view: [] };
    const page = dest.get(0);
    const target = page instanceof PDFRef ? pageIndex.get(page.toString()) ?? null : page instanceof PDFNumber ? page.asNumber() : null;
    return { target, view: dest.asArray().slice(1) };
  };

  const walk = (first: PDFDict | undefined): OutlineItem[] => {
    const items: OutlineItem[] = [];
    let node = first;
    while (node && !seen.has(node)) {
      seen.add(node);
      const title = node.lookup(N("Title"));
      let destRaw = node.get(N("Dest"));
      if (!destRaw) {
        const action = node.lookupMaybe(N("A"), PDFDict);
        if (action?.lookup(N("S")) === N("GoTo")) destRaw = action.get(N("D"));
      }
      const { target, view } = resolveDest(destRaw);
      const count = node.lookup(N("Count"));
      items.push({
        title: title instanceof PDFString || title instanceof PDFHexString ? title : PDFHexString.fromText(""),
        target,
        view,
        open: count instanceof PDFNumber ? count.asNumber() > 0 : false,
        children: walk(node.lookupMaybe(N("First"), PDFDict)),
      });
      node = node.lookupMaybe(N("Next"), PDFDict);
    }
    return items;
  };

  return walk(root.lookupMaybe(N("First"), PDFDict));
}

/** 具名目的地：舊式 /Dests 字典與新式 /Names /Dests 名稱樹 */
function namedDestinations(doc: PDFDocument): Map<string, PDFObject> {
  const map = new Map<string, PDFObject>();
  const dests = doc.catalog.lookupMaybe(N("Dests"), PDFDict);
  dests?.entries().forEach(([k, v]) => map.set(k.decodeText(), v));

  const visit = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32) return;
    const names = node.lookupMaybe(N("Names"), PDFArray);
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = names.lookup(i);
        if (key instanceof PDFString || key instanceof PDFHexString) map.set(key.decodeText(), names.get(i + 1));
      }
    }
    const kids = node.lookupMaybe(N("Kids"), PDFArray);
    kids?.asArray().forEach((_, i) => visit(kids.lookupMaybe(i, PDFDict), depth + 1));
  };
  visit(doc.catalog.lookupMaybe(N("Names"), PDFDict)?.lookupMaybe(N("Dests"), PDFDict), 0);
  return map;
}

/**
 * 寫入目錄。`pageFor(i)` 回傳原始 PDF 第 i 頁在新文件中的頁面參照；該頁被刪除則回傳 undefined。
 * 目標頁不在的項目：有子項目就保留（但點了不跳頁），沒有就略過。
 */
export function writeOutline(out: PDFDocument, items: OutlineItem[], pageFor: (index: number) => PDFRef | undefined): number {
  const ctx = out.context;

  const keep = (item: OutlineItem): OutlineItem | null => {
    const children = item.children.map(keep).filter((c): c is OutlineItem => c !== null);
    const hasTarget = item.target !== null && pageFor(item.target) !== undefined;
    if (!hasTarget && children.length === 0) return null;
    return { ...item, target: hasTarget ? item.target : null, children };
  };
  const kept = items.map(keep).filter((c): c is OutlineItem => c !== null);
  if (kept.length === 0) return 0;

  const rootRef = ctx.nextRef();
  let total = 0;

  /** 寫入一層，回傳 [第一項, 最後一項, 這層可見項目數] */
  const writeLevel = (level: OutlineItem[], parent: PDFRef): [PDFRef, PDFRef, number] => {
    const refs = level.map(() => ctx.nextRef());
    let visible = 0;
    level.forEach((item, i) => {
      total++;
      const dict: Record<string, PDFObject> = { Title: item.title, Parent: parent };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < level.length - 1) dict.Next = refs[i + 1];
      if (item.target !== null) {
        dict.Dest = ctx.obj([pageFor(item.target)!, ...item.view.map(copyDirect)]);
      }
      visible++;
      if (item.children.length) {
        const [first, last, childVisible] = writeLevel(item.children, refs[i]);
        dict.First = first;
        dict.Last = last;
        // Count 為正：預設展開；為負：預設收合
        dict.Count = PDFNumber.of(item.open ? childVisible : -childVisible);
        if (item.open) visible += childVisible;
      }
      ctx.assign(refs[i], ctx.obj(dict as never));
    });
    return [refs[0], refs[refs.length - 1], visible];
  };

  const [first, last, visible] = writeLevel(kept, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: first, Last: last, Count: visible }));
  out.catalog.set(N("Outlines"), rootRef);
  return total;
}

/** 目的地參數（名稱、數字、null）是直接物件，換到新文件時重建一份 */
function copyDirect(obj: PDFObject): PDFObject {
  if (obj instanceof PDFNumber) return PDFNumber.of(obj.asNumber());
  if (obj instanceof PDFName) return PDFName.of(obj.decodeText());
  return PDFNull;
}
