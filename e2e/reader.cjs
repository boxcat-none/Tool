const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument, StandardFonts, rgb } = require(env.PDF_LIB);
const shots = env.out("shots");
let failed = false;
function assertEq(a, e, label) { const ok = JSON.stringify(a) === JSON.stringify(e); console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(a)}${ok ? "" : " expected " + JSON.stringify(e)}`); if (!ok) failed = true; }
(async () => {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 12; i++) { const p = doc.addPage([595, 842]); p.drawText(`Page ${i} hello reader`, { x: 60, y: 760, size: 28, font, color: rgb(0.1, 0.2, 0.5) }); p.drawRectangle({ x: 60, y: 100, width: 475, height: 600, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 1 }); }
  const twelve = Buffer.from(await doc.save());
  const cjk = fs.readFileSync(path.join(env.FIX, "無內嵌字型.pdf"));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(env.BASE + "/#reader");
  await page.getByText("拖放 PDF 或 .guganote").waitFor();
  await page.locator(".drop input[type=file]").setInputFiles({ name: "十二頁.pdf", mimeType: "application/pdf", buffer: twelve });
  await page.getByText("/ 12").waitFor();
  await page.locator(".textLayer").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".page[data-page-number='1'] .textLayer")?.textContent.includes("Page 1"));
  assertEq(true, true, "text layer has Page 1 text");
  await page.screenshot({ path: path.join(shots, "reader.png") });

  await page.getByLabel("下一頁").click();
  await page.waitForFunction(() => document.querySelector(".reader__page").value === "2");
  assertEq(await page.locator(".reader__page").inputValue(), "2", "next page");
  await page.locator(".reader__page").fill("10"); await page.locator(".reader__page").press("Enter");
  await page.waitForFunction(() => document.querySelector(".reader__page").value === "10");
  assertEq(await page.locator(".reader__page").inputValue(), "10", "go to page 10");
  await page.locator(".reader__scroll").evaluate((el) => (el.scrollTop = 0));
  await page.waitForFunction(() => document.querySelector(".reader__page").value === "1");
  assertEq(await page.locator(".reader__page").inputValue(), "1", "scroll updates page number");

  const before = parseInt(await page.locator(".reader__percent").textContent());
  await page.getByLabel("放大").click();
  await page.waitForFunction((b) => parseInt(document.querySelector(".reader__percent").textContent) > b, before);
  assertEq(parseInt(await page.locator(".reader__percent").textContent()) > before, true, "zoom in");
  await page.locator(".reader__zoom").selectOption("page-fit");
  await page.waitForTimeout(300);
  const fit = await page.evaluate(() => { const pg = document.querySelector(".page"); const sc = document.querySelector(".reader__scroll"); return pg.getBoundingClientRect().height <= sc.clientHeight; });
  assertEq(fit, true, "page-fit shows whole page");
  await page.keyboard.press("Control+0");
  await page.waitForTimeout(300);
  const width = await page.evaluate(() => { const pg = document.querySelector(".page"); const sc = document.querySelector(".reader__scroll"); return Math.abs(pg.getBoundingClientRect().width - (sc.clientWidth - 0)) < 60; });
  assertEq(width, true, "Ctrl+0 fits width");

  // 切到工具再切回來，文件仍然開著
  await page.getByRole("button", { name: "PDF 工具" }).click();
  await page.getByRole("tab", { name: "合併 PDF" }).waitFor();
  await page.getByRole("button", { name: "閱讀與筆記" }).click();
  assertEq(await page.getByText("/ 12").isVisible(), true, "document kept after switching modes");

  // 中文無內嵌字型
  await page.getByLabel("回到書櫃").click();
  await page.locator(".drop input[type=file]").setInputFiles({ name: "中文.pdf", mimeType: "application/pdf", buffer: cjk });
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("中文測試"));
  assertEq(true, true, "CJK text without embedded font is readable");
  await page.screenshot({ path: path.join(shots, "reader-cjk.png") });

  // 損毀檔案
  await page.getByLabel("回到書櫃").click();
  await page.locator(".drop input[type=file]").setInputFiles({ name: "壞.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 garbage") });
  await page.getByText("不是有效的 PDF").waitFor();
  assertEq(true, true, "broken pdf message");

  const mobile = await browser.newPage({ viewport: { width: 375, height: 740 }, colorScheme: "dark" });
  await mobile.goto(env.BASE + "/#reader");
  await mobile.locator(".drop input[type=file]").setInputFiles({ name: "十二頁.pdf", mimeType: "application/pdf", buffer: twelve });
  await mobile.getByText("/ 12").waitFor();
  await mobile.locator(".page canvas").first().waitFor();
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: path.join(shots, "reader-mobile-dark.png") });
  assertEq(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal page scroll at 375px");

  assertEq(errors.filter((e) => !e.includes("Cannot load system font")), [], "no console/page errors");
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
