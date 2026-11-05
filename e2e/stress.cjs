const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs");
const { chromium } = require("playwright");
const PDF = env.STRESS_PDF;
const rows = [];
const ms = (t) => `${Math.round(t)} ms`;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(env.BASE + "/#reader");
  await page.getByText("還沒有筆記本").waitFor();
  const firstCanvas = () => page.waitForFunction(() => { const c = document.querySelector('.page[data-page-number="1"] canvas'); return c && c.width > 0; }, null, { timeout: 120000 });

  let t = Date.now();
  await page.locator(".drop input[type=file]").setInputFiles(PDF);
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 300", null, { timeout: 120000 });
  await firstCanvas();
  rows.push(["開啟 28 MB／300 頁 PDF（建立筆記本、存入書櫃、畫出第 1 頁）", ms(Date.now() - t)]);

  t = Date.now();
  await page.locator(".reader__page").fill("300"); await page.locator(".reader__page").press("Enter");
  await page.waitForFunction(() => { const c = document.querySelector('.page[data-page-number="300"] canvas'); return c && c.width > 0; }, null, { timeout: 60000 });
  rows.push(["跳到第 300 頁並畫好", ms(Date.now() - t)]);

  // 在第 300 頁寫幾筆
  await page.keyboard.press("p");
  const box = await page.locator('.page[data-page-number="300"]').boundingBox();
  for (let k = 0; k < 5; k++) { await page.mouse.move(box.x + 100, box.y + 200 + k * 40); await page.mouse.down(); await page.mouse.move(box.x + 400, box.y + 220 + k * 40, { steps: 10 }); await page.mouse.up(); }

  // 插入頁面：第一次要把 28 MB 原檔傳進 Worker，第二次之後只重新產生
  for (const [label, n] of [["第一次插頁（含把原檔傳進 Worker）", 301], ["第二次插頁", 302]]) {
    t = Date.now();
    await page.getByRole("button", { name: "＋ 插入頁面" }).click();
    await page.getByRole("menuitem", { name: "橫線" }).click();
    await page.waitForFunction((n) => document.querySelector(".reader__count")?.textContent === `/ ${n}` && document.querySelector(".reader__saved")?.textContent === "已自動儲存", n, { timeout: 120000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".page canvas")].some((c) => c.width > 0), null, { timeout: 60000 });
    rows.push([`${label}：重新產生 ${n} 頁並顯示`, ms(Date.now() - t)]);
  }

  t = Date.now();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), page.getByRole("button", { name: "匯出 PDF" }).click()]);
  await dl.path();
  rows.push(["匯出 PDF（302 頁）", ms(Date.now() - t)]);

  t = Date.now();
  const [gn] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), page.getByRole("button", { name: "存成 .guganote" }).click()]);
  const gnSize = fs.statSync(await gn.path()).size;
  rows.push([`存成 .guganote（${(gnSize / 1024 / 1024).toFixed(1)} MB）`, ms(Date.now() - t)]);

  // 回到書櫃再開啟（從 IndexedDB 讀回）
  await page.getByLabel("回到書櫃").click(); await page.getByText("我的筆記本").waitFor();
  t = Date.now();
  await page.locator(".library__open").first().click();
  await page.waitForFunction(() => document.querySelector(".reader__count")?.textContent === "/ 302", null, { timeout: 120000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".page canvas")].some((c) => c.width > 0), null, { timeout: 60000 });
  rows.push(["從書櫃重新開啟（302 頁，需重新產生顯示用 PDF）", ms(Date.now() - t)]);

  const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null));
  if (heap) rows.push(["主執行緒記憶體用量（JS heap）", `${heap} MB`]);
  const table = ["| 動作（Chromium，瀏覽器版） | 時間 |", "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n");
  console.log(table);
  fs.writeFileSync(path.join(env.out("stress"), "browser.md"), table + "\n");
  if (errors.length) console.log("ERRORS", errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
