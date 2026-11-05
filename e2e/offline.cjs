const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const cjk = () => ({ name: "中文.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(env.FIX, "無內嵌字型.pdf")) });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(env.BASE + "/");
  // manifest 與 iOS 設定
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
  check(manifest.display === "standalone" && manifest.icons.length === 3, "manifest: standalone with icons", { display: manifest.display, icons: manifest.icons.length });
  check(await page.locator('link[rel="apple-touch-icon"]').count() === 1, "iOS home screen icon");
  check(await page.evaluate(async () => (await fetch("icons/apple-touch-icon.png")).ok), "icon file served");

  // Service Worker 安裝完成並接管頁面
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  check(true, "service worker controls the page");

  // 線上時建立筆記本（順便快取中文字型對照表）
  await page.locator(".drop input[type=file]").setInputFiles(cjk());
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("中文測試"));
  await page.getByLabel("回到書櫃").click(); await page.getByText("我的筆記本").waitFor();

  // ── 離線 ──
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText("我的筆記本").waitFor({ timeout: 15000 });
  check(true, "offline: app loads and library shows");
  await page.locator(".library__open").first().click();
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("中文測試"), null, { timeout: 15000 });
  check(true, "offline: open notebook, Chinese text renders (cMap from cache)");
  await page.keyboard.press("p");
  await page.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  const box = await page.locator('.page[data-page-number="1"]').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 340, { steps: 8 }); await page.mouse.up();
  const ink = await page.evaluate(() => { const c = document.querySelector('.page[data-page-number="1"] .ink-layer__pen'); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) k++; return k; });
  check(ink > 100, "offline: can write notes");
  await page.getByRole("button", { name: "＋ 插入頁面" }).click();
  await page.getByRole("menuitem", { name: "方格" }).click();
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 2", null, { timeout: 15000 });
  check(true, "offline: insert page (worker loaded from cache)");
  // PDF 工具離線
  await page.getByRole("button", { name: "PDF 工具" }).click();
  await page.getByRole("tab", { name: "PDF 轉 JPG/PNG" }).click();
  await page.locator(".panel .drop input[type=file]").setInputFiles(cjk());
  await page.getByText("將產生 1 張 PNG 圖片").waitFor({ timeout: 15000 });
  check(true, "offline: PDF tools work");
  await ctx.setOffline(false);
  check(errors.length === 0, "no page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
