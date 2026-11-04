import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

/**
 * 產生測試用 PDF，每頁寬度不同（寬度 = 100 + 頁面標記），
 * 用寬度就能辨識頁面來源與順序。
 */
export async function makePdf(markers: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const m of markers) doc.addPage([100 + m, 200]);
  return doc.save();
}

/** 讀回每頁的標記。 */
export async function readMarkers(data: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(data);
  return doc.getPages().map((p) => Math.round(p.getWidth()) - 100);
}

export async function makeEncryptedLookingPdf(): Promise<Uint8Array> {
  // pdf-lib 無法真的加密，這裡在 trailer 放一個 /Encrypt 字典，讓它被判定為加密檔
  const doc = await PDFDocument.create();
  doc.addPage();
  const encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2 });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return doc.save({ useObjectStreams: false });
}

/** 讀回每頁的標記與旋轉角度。 */
export async function readPages(data: Uint8Array): Promise<{ m: number; r: number }[]> {
  const doc = await PDFDocument.load(data);
  return doc.getPages().map((p) => ({
    m: Math.round(p.getWidth()) - 100,
    r: p.getRotation().angle,
  }));
}

/** 讀回每頁尺寸（pt，四捨五入到小數 2 位）。 */
export async function readSizes(data: Uint8Array): Promise<[number, number][]> {
  const doc = await PDFDocument.load(data);
  const round = (n: number) => Math.round(n * 100) / 100;
  return doc.getPages().map((p) => [round(p.getWidth()), round(p.getHeight())]);
}

/**
 * 只有標頭的假 JPEG：pdf-lib 嵌入 JPEG 時只讀 SOF 取得尺寸，不會解碼，
 * 所以足夠用來測試版面計算。
 */
export function fakeJpeg(width: number, height: number, exifOrientation?: number): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const exif = exifOrientation ? exifSegment(exifOrientation) : [];
  return Uint8Array.from([0xff, 0xd8, ...exif, ...sof, 0xff, 0xd9]);
}

/** APP1 EXIF 區段，只含 Orientation 一個欄位（big-endian）。 */
export function exifSegment(orientation: number): number[] {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 offset = 8
    0x00, 0x01, // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation
    0x00, 0x00, 0x00, 0x00, // next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const len = body.length + 2;
  return [0xff, 0xe1, len >> 8, len & 0xff, ...body];
}

/** 產生單色 PNG（真的 PNG，用 zlib 壓縮）。 */
export function makePng(width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height); // filter 0 + RGB 全黑
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const total = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { total.set(p, o); o += p.length; }
  return total;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
