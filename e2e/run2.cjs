const env = require("./lib/env.cjs");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument } = require(env.PDF_LIB);

const dir = env.out("run2"), shots = env.out("shots");
let failed = false;
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : " expected " + JSON.stringify(expected)}`);
  if (!ok) failed = true;
}
const buf = (name, buffer, mimeType) => ({ name, buffer, mimeType });
async function pagesOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ({ m: Math.round(p.getWidth()) - 100, r: p.getRotation().angle }));
}
async function sizesOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => [Math.round(p.getWidth() * 100) / 100, Math.round(p.getHeight() * 100) / 100]);
}
/** 在 JPEG 的 SOI 後插入 EXIF Orientation */
function withExif(jpeg, orientation) {
  const tiff = [0x4d,0x4d,0,0x2a,0,0,0,8, 0,1, 0x01,0x12,0,3,0,0,0,1,0,orientation,0,0, 0,0,0,0];
  const body = [0x45,0x78,0x69,0x66,0,0, ...tiff];
  const seg = Buffer.from([0xff,0xe1,(body.length+2)>>8,(body.length+2)&0xff, ...body]);
  return Buffer.concat([jpeg.subarray(0,2), seg, jpeg.subarray(2)]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 900, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // ── 產生測試圖片：200×100，左紅右藍 ──
  await page.setContent(`<div style="display:flex;width:200px;height:100px"><div style="flex:1;background:red"></div><div style="flex:1;background:blue"></div></div>`);
  const clip = { x: 8, y: 8, width: 200, height: 100 };
  const png = await page.screenshot({ clip, type: "png" });
  const jpeg = await page.screenshot({ clip, type: "jpeg", quality: 90 });
  const webp = Buffer.from(
    (await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 60; c.height = 40;
      c.getContext("2d").fillRect(0, 0, 60, 40); return c.toDataURL("image/webp"); })).split(",")[1], "base64");

  // ── 圖片轉 PDF ──
  await page.goto(env.BASE + "/#images");
  await page.locator(".drop input[type=file]").setInputFiles([
    buf("橫的.png", png, "image/png"),
    buf("手機照片.jpg", withExif(jpeg, 6), "image/jpeg"),
    buf("小圖.webp", webp, "image/webp"),
  ]);
  await page.getByText("60×40").waitFor();
  assertEq(await page.locator(".file__meta").allTextContents().then((t) => t.map((x) => x.split(" · ")[1])), ["200×100", "100×200", "60×40"], "image dims (EXIF applied in preview)");
  await page.getByRole("radio", { name: "與圖片相同" }).click();
  assertEq(await page.getByRole("radio", { name: "橫式" }).isDisabled(), true, "orientation disabled in fit mode");
  await page.getByRole("radio", { name: "無" }).click();
  await page.screenshot({ path: path.join(shots, "images.png") });
  let [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "轉換並下載" }).click()]);
  assertEq(dl.suggestedFilename(), "圖片.pdf", "images output name");
  // 96 DPI：200px → 150pt；EXIF 6 的照片應該被轉正成直的
  assertEq(await sizesOf(fs.readFileSync(await dl.path())), [[150, 75], [75, 150], [45, 30]], "fit page sizes (EXIF rotated)");

  // A4 自動方向
  await page.getByRole("radio", { name: "A4" }).click();
  [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "轉換並下載" }).click()]);
  assertEq(await sizesOf(fs.readFileSync(await dl.path())), [[841.89, 595.28], [595.28, 841.89], [841.89, 595.28]], "A4 auto orientation");

  // 不支援的格式
  await page.locator(".drop input[type=file]").setInputFiles([buf("iphone.heic", Buffer.from("not really heic"), "image/heic"), buf("說明.txt", Buffer.from("hi"), "text/plain")]);
  await page.getByText("不支援的格式").waitFor();
  assertEq(await page.getByText("不是圖片檔").count(), 1, "non-image flagged");
  assertEq(await page.getByRole("button", { name: "轉換並下載" }).isDisabled(), true, "convert disabled with errors");

  // ── 整理頁面 ──
  const doc = await PDFDocument.create();
  for (const m of [1, 2, 3, 4]) {
    const p = doc.addPage([100 + m, 200]);
    p.drawText(String(m), { x: 30, y: 80, size: 60 });
  }
  const four = Buffer.from(await doc.save());
  await page.getByRole("tab", { name: "整理頁面" }).click();
  await page.locator(".drop input[type=file]").setInputFiles(buf("四頁.pdf", four, "application/pdf"));
  await page.locator(".page__frame img").nth(3).waitFor();
  assertEq(await page.locator(".page__frame img").count(), 4, "thumbnails rendered");
  assertEq(await page.getByRole("button", { name: "套用並下載" }).isDisabled(), true, "apply disabled without changes");

  await page.getByLabel("第 1 頁向右轉").click();
  await page.getByLabel("刪除第 2 頁").click();
  await page.getByRole("button", { name: "第 3 頁", exact: true }).click();
  await page.getByRole("button", { name: "第 4 頁", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByText("已選取 2 頁").waitFor();
  await page.locator(".toolbar").getByRole("button", { name: "↺ 向左轉" }).click();
  await page.getByRole("button", { name: "取消選取" }).click();
  // 把第 4 頁拖到最前面
  await page.locator(".page").nth(3).dragTo(page.locator(".page").nth(0));
  const order = await page.locator(".page__num").allTextContents();
  assertEq(order, ["4", "1", "2", "3"], "order after drag");
  assertEq(await page.locator(".actions--between .note").first().textContent().then((t) => t.split(" · ")[0]), "輸出 3 頁，刪除 1 頁，旋轉 3 頁，已調整順序", "summary");
  await page.screenshot({ path: path.join(shots, "organize.png") });
  [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "套用並下載" }).click()]);
  assertEq(dl.suggestedFilename(), "四頁_已整理.pdf", "organize output name");
  assertEq(await pagesOf(fs.readFileSync(await dl.path())), [{ m: 4, r: 270 }, { m: 1, r: 90 }, { m: 3, r: 270 }], "organized pages");

  // 全部還原
  await page.getByRole("button", { name: "全部還原" }).click();
  assertEq(await page.locator(".page__num").allTextContents(), ["1", "2", "3", "4"], "reset order");
  assertEq(await page.getByRole("button", { name: "套用並下載" }).isDisabled(), true, "apply disabled after reset");

  // 手機 + 深色
  const mobile = await browser.newPage({ viewport: { width: 375, height: 800 }, colorScheme: "dark" });
  await mobile.goto(env.BASE + "/#organize");
  await mobile.locator(".drop input[type=file]").setInputFiles(buf("四頁.pdf", four, "application/pdf"));
  await mobile.locator(".page__frame img").nth(1).waitFor();
  await mobile.getByLabel("刪除第 2 頁").click();
  await mobile.screenshot({ path: path.join(shots, "organize-mobile-dark.png") });
  assertEq(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal scroll (organize, 375px)");
  await mobile.goto(env.BASE + "/#images");
  await mobile.locator(".drop input[type=file]").setInputFiles([buf("橫的.png", png, "image/png")]);
  await mobile.getByText("200×100").waitFor();
  await mobile.screenshot({ path: path.join(shots, "images-mobile-dark.png"), fullPage: true });
  assertEq(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal scroll (images, 375px)");

  assertEq(errors, [], "no console/page errors");
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
