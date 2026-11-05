const env = require("./lib/env.cjs");
const path = require("path"); const fs = require("fs"); const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const W2 = env.FIX; const shots = env.out("shots"); const OUT = env.out("w3"); fs.mkdirSync(OUT, { recursive: true });
let failed = false;
function check(ok, label, v) { console.log(`${ok ? "PASS" : "FAIL"} ${label}${v !== undefined ? ": " + JSON.stringify(v) : ""}`); if (!ok) failed = true; }
const pdf = (name) => ({ name, mimeType: "application/pdf", buffer: fs.readFileSync(path.join(W2, name)) });

/** 某頁某層 canvas 上不透明像素數 */
const inkPixels = (p, page, layer) => p.evaluate(([page, layer]) => {
  const c = document.querySelector(`.page[data-page-number="${page}"] .ink-layer__${layer}`);
  if (!c) return -1;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n;
}, [page, layer]);

async function draw(p, page, pts) {
  const box = await p.locator(`.page[data-page-number="${page}"]`).boundingBox();
  await p.mouse.move(box.x + pts[0][0], box.y + pts[0][1]);
  await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await p.mouse.up();
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(env.BASE + "/#reader");
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await page.getByText("/ 12").waitFor();
  await page.locator('.page[data-page-number="1"] .ink-layer__pen').waitFor({ state: "attached" });

  check(await page.locator(".ink-input").first().evaluate((el) => getComputedStyle(el).pointerEvents) === "none", "read mode: ink layer lets clicks through");

  // ── 鋼筆 ──
  await page.getByRole("radio", { name: "鋼筆（P）" }).click();
  check(await page.locator(".ink-input").first().evaluate((el) => getComputedStyle(el).pointerEvents) === "auto", "pen mode: ink layer captures input");
  await draw(page, 1, [[120, 300], [200, 340], [280, 300], [360, 360]]);
  const penPx = await inkPixels(page, 1, "pen");
  check(penPx > 200, "pen stroke drawn", penPx);
  check(await page.getByRole("button", { name: "復原（Ctrl+Z）" }).isEnabled(), "undo enabled after drawing");

  await page.getByRole("button", { name: "復原（Ctrl+Z）" }).click();
  check(await inkPixels(page, 1, "pen") === 0, "undo removes stroke");
  await page.keyboard.press("Control+Shift+z");
  check(await inkPixels(page, 1, "pen") === penPx, "Ctrl+Shift+Z redoes stroke");

  // 換紅色、粗筆再畫一筆
  await page.getByRole("radio", { name: "紅色" }).click();
  await page.getByRole("radio", { name: "粗" }).click();
  await draw(page, 1, [[120, 450], [400, 470]]);
  const red = await page.evaluate(() => {
    const c = document.querySelector('.page[data-page-number="1"] .ink-layer__pen');
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 180 && d[i + 1] < 80) n++; return n;
  });
  check(red > 100, "red thick stroke", red);

  // ── 螢光筆（按 H）蓋在標題文字上 ──
  await page.locator(".reader__scroll").hover();
  await page.keyboard.press("h");
  check(await page.getByRole("radio", { name: "螢光筆（H）" }).getAttribute("aria-checked") === "true", "H key selects highlighter");
  const titleBox = await page.evaluate(() => {
    const pg = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
    const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find((s) => s.textContent.includes("Page 1"));
    const r = span.getBoundingClientRect();
    return { x: r.left - pg.left, y: r.top - pg.top + r.height / 2, w: r.width };
  });
  await draw(page, 1, [[titleBox.x, titleBox.y], [titleBox.x + titleBox.w, titleBox.y]]);
  check(await inkPixels(page, 1, "highlight") > 500, "highlighter stroke drawn");
  await page.screenshot({ path: path.join(shots, "ink-drawing.png") });
  // 螢光筆下的文字仍然是深色（相乘混合），背景變黃
  const blend = await page.evaluate(async (tb) => {
    const pg = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
    return { x: pg.left + tb.x, y: pg.top + tb.y, w: tb.w };
  }, titleBox);
  const shot = await page.screenshot({ clip: { x: blend.x, y: blend.y - 12, width: blend.w, height: 24 } });
  fs.writeFileSync(path.join(OUT, "blend.png"), shot);

  // ── 橡皮擦（按 E）擦掉第一筆藍色 ──
  await page.keyboard.press("e");
  const before = await inkPixels(page, 1, "pen");
  await draw(page, 1, [[190, 320], [220, 340], [250, 320]]);
  const after = await inkPixels(page, 1, "pen");
  check(after < before && after > 100, "eraser removes the crossed stroke only", { before, after });
  await page.keyboard.press("Control+z");
  check(await inkPixels(page, 1, "pen") === before, "undo restores erased stroke");
  await page.keyboard.press("Control+y");
  check(await inkPixels(page, 1, "pen") === after, "Ctrl+Y redoes erase");

  // ── 第 2 頁：筆跡各頁分開 ──
  await page.keyboard.press("p");
  await page.getByRole("button", { name: "下一頁" }).click();
  await page.waitForFunction(() => document.querySelector(".reader__page").value === "2");
  await page.locator('.page[data-page-number="2"] .ink-layer__pen').waitFor({ state: "attached" });
  await draw(page, 2, [[150, 200], [300, 260]]);
  check(await inkPixels(page, 2, "pen") > 100, "page 2 has its own stroke");

  // ── 縮放後筆跡重新對齊 ──
  await page.getByRole("button", { name: "第 1 頁", exact: true }).click().catch(async () => { await page.locator(".reader__page").fill("1"); await page.locator(".reader__page").press("Enter"); });
  await page.waitForFunction(() => document.querySelector(".reader__page").value === "1");
  const pxBeforeZoom = await inkPixels(page, 1, "pen");
  await page.getByLabel("放大").click(); await page.getByLabel("放大").click();
  await page.waitForTimeout(800);
  await page.locator('.page[data-page-number="1"] .ink-layer__pen').waitFor({ state: "attached" });
  const pxAfterZoom = await inkPixels(page, 1, "pen");
  check(pxAfterZoom > pxBeforeZoom * 1.2, "ink redrawn larger after zoom", { pxBeforeZoom, pxAfterZoom });
  await page.locator(".reader__zoom").selectOption("page-width");
  await page.waitForTimeout(500);

  // ── 匯出 PDF ──
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 PDF" }).click()]);
  check(dl.suggestedFilename() === "目錄.pdf", "export filename", dl.suggestedFilename());
  const outPdf = path.join(OUT, "目錄_筆記.pdf"); fs.copyFileSync(await dl.path(), outPdf);
  execFileSync("pdftoppm", ["-r", "50", "-f", "1", "-l", "2", "-png", outPdf, path.join(OUT, "export")]);
  const stats = execFileSync("python3", ["-c", `
import numpy as np, glob
from PIL import Image
for p in sorted(glob.glob("${OUT}/export-*.png")):
    a = np.asarray(Image.open(p).convert("RGB")).astype(int)
    red = ((a[...,0] > 170) & (a[...,1] < 90) & (a[...,2] < 90)).sum()
    blue = ((a[...,2] > 120) & (a[...,0] < 90)).sum()
    yellow = ((a[...,0] > 200) & (a[...,1] > 180) & (a[...,2] < 170)).sum()
    print(int(red), int(blue), int(yellow))
`]).toString().trim().split("\n").map((l) => l.split(" ").map(Number));
  check(stats[0][0] > 20 && stats[0][2] > 20, "exported page 1 has red ink and yellow highlight", stats[0]);
  check(stats[1][0] > 20, "exported page 2 has its (red) ink", stats[1]);
  await page.getByText("已下載").waitFor();

  // ── 自動儲存：回到書櫃不會提醒，筆記已存好 ──
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  await page.getByLabel("回到書櫃").click();
  await page.getByText("我的筆記本").waitFor();
  check(dialogs === 0, "no warning when closing (auto-saved)");

  // ── 設定會記住（顏色、粗細）──
  await page.locator(".drop input[type=file]").setInputFiles(pdf("目錄.pdf"));
  await page.getByRole("button", { name: "接續之前的筆記", exact: true }).click();
  await page.getByText("/ 12").waitFor();
  await page.locator('.page[data-page-number="1"] .ink-layer__pen').waitFor({ state: "attached" }); await page.waitForTimeout(300);
  check(await inkPixels(page, 1, "pen") > 100, "notes kept when reopening the PDF");
  check(await page.getByRole("radio", { name: "閱讀（選取文字）（V）" }).getAttribute("aria-checked") === "true", "reopen starts in read mode");
  await page.keyboard.press("p");
  check(await page.getByRole("radio", { name: "紅色" }).getAttribute("aria-checked") === "true", "pen color remembered");

  check(errors.filter((e) => !e.includes("Cannot load system font")).length === 0, "no console/page errors", errors);
  await browser.close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
