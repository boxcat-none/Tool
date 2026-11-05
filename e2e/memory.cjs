const env = require("./lib/env.cjs");
const path = require("path");
const { chromium } = require("playwright");
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const goTo = async (p, n) => { await p.locator(".reader__page").fill(String(n)); await p.locator(".reader__page").press("Enter"); await p.waitForFunction((n) => document.querySelector(".reader__page").value === String(n), n); };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(env.BASE + "/#reader");
  await page.locator(".drop input[type=file]").setInputFiles(env.STRESS_PDF);
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 300", null, { timeout: 60000 });
  await page.locator('.page[data-page-number="1"] .ink-input').waitFor({ state: "attached" });
  await page.keyboard.press("p");
  const box = await page.locator('.page[data-page-number="1"]').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 400, box.y + 260, { steps: 10 }); await page.mouse.up();

  // 一路翻到第 300 頁，記錄 DOM 中手寫層的最大數量
  let maxLayers = 0;
  for (let n = 10; n <= 300; n += 10) {
    await goTo(page, n);
    await page.waitForTimeout(120);
    maxLayers = Math.max(maxLayers, await page.locator(".ink-layer").count());
  }
  check(maxLayers <= 20, "ink layers stay bounded while paging through 300 pages", maxLayers);
  await goTo(page, 1);
  await page.waitForFunction(() => { const c = document.querySelector('.page[data-page-number="1"] .ink-layer__pen'); if (!c || !c.width) return false; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) return true; return false; }, null, { timeout: 10000 });
  check(true, "page 1 ink still there after coming back");

  // 縮小到 25%＋很高的視窗：同時看到 10 頁以上，每一頁都要有手寫層
  await page.setViewportSize({ width: 1024, height: 3200 });
  await page.locator(".reader__percent").textContent();
  for (let i = 0; i < 20 && parseInt(await page.locator(".reader__percent").textContent()) > 25; i++) await page.getByLabel("縮小").click();
  await page.waitForTimeout(1500);
  console.log("     縮放：", await page.locator(".reader__percent").textContent(), "頁面高度", await page.locator('.page[data-page-number="1"]').evaluate((e) => Math.round(e.getBoundingClientRect().height)));
  const vis = await page.evaluate(() => {
    const sc = document.querySelector(".reader__scroll").getBoundingClientRect();
    const pages = [...document.querySelectorAll(".page")].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > sc.top && r.top < sc.bottom; });
    return { visible: pages.length, withInk: pages.filter((p) => p.querySelector(".ink-layer")).length, rendered: pages.filter((p) => p.querySelector("canvas:not(.ink-layer canvas)")).length };
  });
  check(vis.visible > 10 && vis.withInk === vis.rendered, "zoomed out: every rendered visible page has its ink layer", vis);
  const heap = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1024 / 1024));
  console.log(`     JS heap: ${heap} MB`);
  check(errors.length === 0, "no page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
