const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const W2 = env.FIX; const shots = env.out("shots");
let failed = false;
function assertEq(a, e, label) { const ok = JSON.stringify(a) === JSON.stringify(e); console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(a)}${ok ? "" : " expected " + JSON.stringify(e)}`); if (!ok) failed = true; }
const pdf = (name) => ({ name, mimeType: "application/pdf", buffer: fs.readFileSync(path.join(W2, name)) });
const pageNo = (p) => p.locator(".reader__page").inputValue();
const waitPage = (p, n) => p.waitForFunction((n) => document.querySelector(".reader__page")?.value === String(n), n);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(env.BASE + "/#reader");
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await page.getByText("/ 12").waitFor();

  // ── 縮圖側邊欄 ──
  await page.locator(".side-thumb").first().waitFor();
  assertEq(await page.locator(".side-thumb").count(), 12, "sidebar shows 12 thumbnails");
  await page.locator(".side-thumb img").first().waitFor();
  assertEq(await page.locator(".side-thumb--active").getAttribute("data-page"), "1", "page 1 highlighted");
  await page.getByRole("button", { name: "第 6 頁", exact: true }).click();
  await waitPage(page, 6);
  assertEq(await page.locator(".side-thumb--active").getAttribute("data-page"), "6", "click thumbnail → page 6 highlighted");
  await page.screenshot({ path: path.join(shots, "reader-thumbs.png") });

  // ── 目錄 ──
  await page.getByRole("tab", { name: "目錄" }).click();
  await page.getByText("第一章 開始").waitFor();
  assertEq(await page.locator(".outline__title").allTextContents(), ["第一章 開始", "1.1 小節", "第二章 結尾"], "outline tree");
  await page.getByText("第二章 結尾").click(); await waitPage(page, 10);
  assertEq(await pageNo(page), "10", "outline → chapter 2 (page 10)");
  await page.getByText("1.1 小節").click(); await waitPage(page, 5);
  assertEq(await pageNo(page), "5", "outline → section 1.1 (page 5)");
  await page.getByRole("button", { name: "收合" }).click();
  assertEq(await page.getByText("1.1 小節").count(), 0, "collapse outline node");
  await page.screenshot({ path: path.join(shots, "reader-outline.png") });

  // ── 搜尋（pdf.js 從目前頁開始找，所以先回到第 1 頁）──
  await page.getByRole("tab", { name: "頁面" }).click();
  await page.getByRole("button", { name: "第 1 頁", exact: true }).click(); await waitPage(page, 1);
  await page.locator(".reader__scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+f");
  await page.getByPlaceholder("搜尋文件內容").waitFor();
  assertEq(await page.evaluate(() => document.activeElement?.getAttribute("placeholder")), "搜尋文件內容", "Ctrl+F focuses search");
  await page.getByPlaceholder("搜尋文件內容").fill("needle");
  await page.waitForFunction(() => /\d+ \/ 2/.test(document.querySelector(".reader__search-count")?.textContent ?? ""));
  assertEq(await page.locator(".reader__search-count").textContent(), "1 / 2", "search finds 2 matches");
  await waitPage(page, 4);
  assertEq(await pageNo(page), "4", "first match on page 4");
  await page.locator(".textLayer .highlight").first().waitFor();
  assertEq((await page.locator(".textLayer .highlight").count()) > 0, true, "match highlighted");
  await page.screenshot({ path: path.join(shots, "reader-search.png") });
  await page.getByPlaceholder("搜尋文件內容").press("Enter");
  await waitPage(page, 9);
  assertEq(await page.locator(".reader__search-count").textContent(), "2 / 2", "Enter → next match (page 9)");
  await page.getByPlaceholder("搜尋文件內容").press("Shift+Enter");
  await waitPage(page, 4);
  assertEq(await page.locator(".reader__search-count").textContent(), "1 / 2", "Shift+Enter → previous match");
  await page.getByPlaceholder("搜尋文件內容").fill("zzzz-nothing");
  await page.getByText("找不到").waitFor();
  assertEq(true, true, "not found message");
  await page.getByPlaceholder("搜尋文件內容").press("Escape");
  assertEq(await page.getByPlaceholder("搜尋文件內容").count(), 0, "Escape closes search");

  // ── 方向鍵翻頁 ──
  await page.locator(".reader__scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ArrowRight"); await waitPage(page, 5);
  assertEq(await pageNo(page), "5", "ArrowRight → next page");

  // ── 外部連結開新分頁 ──
  await page.getByRole("button", { name: "第 1 頁", exact: true }).count().then(async (n) => { if (!n) await page.getByRole("tab", { name: "頁面" }).click(); });
  await page.getByRole("button", { name: "第 1 頁", exact: true }).click(); await waitPage(page, 1);
  await page.locator(".annotationLayer a[href^='https://example.com']").waitFor();
  const href = await page.locator(".annotationLayer a[href^='https://example.com']").getAttribute("target");
  assertEq(href, "_blank", "external link opens in new tab");

  // ── 記住讀到的頁數 ──
  await page.getByRole("button", { name: "第 7 頁", exact: true }).click(); await waitPage(page, 7);
  await page.waitForTimeout(800);
  await page.getByLabel("回到書櫃").click();
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await page.getByRole("button", { name: "接續之前的筆記", exact: true }).click();
  await page.getByText("從上次讀到的第 7 頁繼續").waitFor();
  await waitPage(page, 7);
  assertEq(await pageNo(page), "7", "reopen resumes at page 7");
  await page.getByRole("button", { name: "回到第 1 頁" }).click(); await waitPage(page, 1);
  assertEq(await pageNo(page), "1", "back to page 1");

  // ── 有密碼的 PDF ──
  await page.getByLabel("回到書櫃").click();
  await page.locator(".drop input[type=file]").setInputFiles(pdf("加密.pdf"));
  await page.getByText("這個 PDF 有密碼保護").waitFor();
  await page.getByLabel("請輸入開啟密碼").fill("wrong");
  await page.getByRole("button", { name: "開啟", exact: true }).click();
  await page.getByText("密碼不正確").waitFor();
  assertEq(true, true, "wrong password message");
  await page.screenshot({ path: path.join(shots, "reader-password.png") });
  await page.getByLabel("請輸入開啟密碼").fill("secret123");
  await page.getByRole("button", { name: "開啟", exact: true }).click();
  await page.getByText("/ 12").waitFor();
  assertEq(true, true, "correct password opens document");

  // ── 中文搜尋 ──
  await page.getByLabel("回到書櫃").click();
  await page.locator(".drop input[type=file]").setInputFiles({ name: "中文.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(env.FIX, "無內嵌字型.pdf")) });
  await page.getByText("/ 1", { exact: true }).waitFor();
  await page.locator(".textLayer span").first().waitFor();
  await page.keyboard.press("Control+f");
  await page.getByPlaceholder("搜尋文件內容").fill("內嵌");
  await page.waitForFunction(() => document.querySelector(".reader__search-count")?.textContent === "1 / 1", null, { timeout: 10000 })
    .catch(async (e) => { console.log("search count:", await page.locator(".reader__search-count").textContent(), "| toolbar:", await page.locator(".reader__toolbar").textContent()); throw e; });
  assertEq(await page.locator(".reader__search-count").textContent(), "1 / 1", "Chinese search");

  // ── 工具頁的 Ctrl+F 不被閱讀器攔截 ──
  await page.getByRole("button", { name: "PDF 工具" }).click();
  await page.getByRole("tab", { name: "合併 PDF" }).waitFor();
  const prevented = await page.evaluate(() => { const ev = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true, bubbles: true }); window.dispatchEvent(ev); return ev.defaultPrevented; });
  assertEq(prevented, false, "Ctrl+F not hijacked on tools page");

  // ── 手機：側邊欄預設收起、選頁後自動收起 ──
  const mobile = await browser.newPage({ viewport: { width: 375, height: 760 }, colorScheme: "dark" });
  await mobile.goto(env.BASE + "/#reader");
  await mobile.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await mobile.getByText("/ 12").waitFor();
  assertEq(await mobile.locator(".reader__sidebar").count(), 0, "mobile: sidebar closed by default");
  await mobile.getByLabel("側邊欄").click();
  await mobile.locator(".side-thumb img").first().waitFor();
  await mobile.screenshot({ path: path.join(shots, "reader-mobile-sidebar.png") });
  await mobile.getByRole("button", { name: "第 3 頁", exact: true }).click();
  await waitPage(mobile, 3);
  assertEq(await mobile.locator(".reader__sidebar").count(), 0, "mobile: sidebar closes after navigation");
  assertEq(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "mobile: no horizontal scroll");

  assertEq(errors.filter((e) => !e.includes("Cannot load system font")), [], "no console/page errors");
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
