const env = require("./lib/env.cjs");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument, rgb } = require(env.PDF_LIB);
const { unzipSync } = require(env.FFLATE);

const shots = env.out("shots");
let failed = false;
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : " expected " + JSON.stringify(expected)}`);
  if (!ok) failed = true;
}
const buf = (name, buffer, mimeType) => ({ name, buffer, mimeType });
function pngSize(b) {
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
function jpgSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o < b.length) {
    const m = b.readUInt16BE(o);
    if (m >= 0xffc0 && m <= 0xffc3) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)];
    o += 2 + b.readUInt16BE(o + 2);
  }
  return null;
}

(async () => {
  // 3 頁：寬 144pt（2 吋）× 高 72/108/144pt，填滿紅、綠、藍
  const doc = await PDFDocument.create();
  const colors = [rgb(1, 0, 0), rgb(0, 1, 0), rgb(0, 0, 1)];
  [72, 108, 144].forEach((h, i) => doc.addPage([144, h]).drawRectangle({ x: 0, y: 0, width: 144, height: h, color: colors[i] }));
  const three = Buffer.from(await doc.save());

  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 900, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(env.BASE + "/#to-images");
  assertEq(await page.getByRole("tab", { selected: true }).textContent(), "PDF 轉 JPG/PNG", "tab selected from hash");
  await page.locator(".drop input[type=file]").setInputFiles(buf("色塊.pdf", three, "application/pdf"));
  await page.getByText("將產生 3 張 PNG 圖片").waitFor();
  assertEq(await page.getByText("第 1 頁約 300×150 像素").count(), 1, "size estimate at 150 DPI");
  await page.screenshot({ path: path.join(shots, "to-images.png") });

  // 全部頁面 PNG @ 72 DPI → ZIP
  await page.getByRole("radio", { name: "72 DPI" }).click();
  let [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "轉換並下載 ZIP" }).click()]);
  assertEq(dl.suggestedFilename(), "色塊_PNG.zip", "zip name");
  const zip = unzipSync(new Uint8Array(fs.readFileSync(await dl.path())));
  assertEq(Object.keys(zip), ["色塊_p1.png", "色塊_p2.png", "色塊_p3.png"], "zip entries");
  assertEq(Object.values(zip).map((d) => pngSize(Buffer.from(d))), [[144, 72], [144, 108], [144, 144]], "png sizes @72dpi");
  await page.locator(".status--done").waitFor();

  // 驗證顏色：第 3 頁中心應該是藍色
  const color = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(img.width / 2, img.height / 2, 1, 1).data);
  }, Buffer.from(zip["色塊_p3.png"]).toString("base64"));
  assertEq(color, [0, 0, 255, 255], "page 3 rendered blue");

  // 指定頁面 2，JPG @ 300 DPI → 單一檔案
  await page.getByRole("radio", { name: "JPG", exact: true }).click();
  await page.getByRole("radio", { name: "300 DPI" }).click();
  await page.getByRole("radio", { name: "指定頁面" }).click();
  await page.getByPlaceholder("例如：1, 3, 5-8").fill("9");
  await page.getByText("頁碼 9 超出範圍").waitFor();
  assertEq(await page.getByRole("button", { name: /轉換並下載/ }).isDisabled(), true, "disabled on bad range");
  await page.getByPlaceholder("例如：1, 3, 5-8").fill("2, 2");
  await page.getByText("將產生 1 張 JPG 圖片").waitFor();
  [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "轉換並下載" }).click()]);
  assertEq(dl.suggestedFilename(), "色塊_p2.jpg", "single jpg name");
  assertEq(jpgSize(fs.readFileSync(await dl.path())), [600, 450], "jpg size @300dpi");

  // 加密 / 非 PDF
  await page.getByRole("button", { name: "換一個檔案" }).click();
  await page.locator(".drop input[type=file]").setInputFiles(buf("x.pdf", Buffer.from("%PDF-1.4 garbage"), "application/pdf"));
  await page.getByText("不是有效的 PDF").waitFor();
  assertEq(true, true, "invalid pdf reported");

  // 手機 + 深色
  const mobile = await browser.newPage({ viewport: { width: 375, height: 900 }, colorScheme: "dark" });
  await mobile.goto(env.BASE + "/#to-images");
  await mobile.locator(".drop input[type=file]").setInputFiles(buf("色塊.pdf", three, "application/pdf"));
  await mobile.getByText("將產生 3 張 PNG 圖片").waitFor();
  await mobile.getByRole("radio", { name: "JPG", exact: true }).click();
  await mobile.screenshot({ path: path.join(shots, "to-images-mobile-dark.png"), fullPage: true });
  assertEq(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal scroll at 375px");

  assertEq(errors, [], "no console/page errors");
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
